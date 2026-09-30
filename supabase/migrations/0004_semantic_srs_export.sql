-- Meaning-based search, review cards, and audio-export jobs.

-- 1. Search chunks keep string block ids (b0001) and the section they came from.
alter table document_chunks
  add column if not exists block_refs text[] not null default '{}',
  add column if not exists section_ref text,
  add column if not exists section_title text,
  add column if not exists position int,
  add column if not exists doc_version bigint;
create index if not exists chunks_doc_position_idx on document_chunks (document_id, position);

-- Keyword + meaning search, merged with reciprocal rank fusion. Server only: the caller passes the user id.
create or replace function hybrid_search(p_user uuid, p_query text, p_embedding vector(384), p_limit int default 10, p_document uuid default null)
returns table (chunk_id uuid, document_id uuid, content text, block_refs text[], section_ref text, section_title text, score double precision)
language sql stable set search_path = public as $$
  with live as (
    select c.* from document_chunks c
    where c.user_id = p_user and (p_document is null or c.document_id = p_document)
      and exists (select 1 from documents d where d.id = c.document_id and d.deleted_at is null)
  ),
  sem as (
    select id, row_number() over (order by embedding <=> p_embedding) as r
    from (select id, embedding from live where embedding is not null order by embedding <=> p_embedding limit 40) s
  ),
  kw as (
    select id, row_number() over (order by rank desc) as r
    from (select id, ts_rank_cd(tsv, websearch_to_tsquery('english', p_query)) as rank
          from live where tsv @@ websearch_to_tsquery('english', p_query) order by rank desc limit 40) k
  )
  select c.id, c.document_id, c.content, c.block_refs, c.section_ref, c.section_title,
         (coalesce(1.0 / (60 + s.r), 0) + coalesce(1.0 / (60 + k.r), 0))::double precision as score
  from (select id from sem union select id from kw) ids
  join document_chunks c on c.id = ids.id
  left join sem s on s.id = c.id
  left join kw k on k.id = c.id
  order by score desc
  limit p_limit;
$$;
revoke all on function hybrid_search(uuid, text, vector, int, uuid) from public, anon, authenticated;
grant execute on function hybrid_search(uuid, text, vector, int, uuid) to service_role;

-- 2. Review cards (spaced repetition).
create table if not exists review_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid references documents(id) on delete set null,
  front text not null,
  back text not null,
  block_ref text,
  ease real not null default 2.5,
  interval_days real not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  due_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table review_cards enable row level security;
create policy own_rows on review_cards for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create trigger review_cards_updated before update on review_cards for each row execute function set_updated_at();
create index if not exists review_cards_pull_idx on review_cards (user_id, updated_at);
create index if not exists review_cards_due_idx on review_cards (user_id, due_at) where deleted_at is null;

-- 3. Export jobs use two more states and can carry a result.
alter table processing_jobs drop constraint if exists processing_jobs_state_check;
alter table processing_jobs add constraint processing_jobs_state_check
  check (state in ('queued','uploading','uploaded','extracting','ocr_processing','structuring','indexing','generating','packaging','ready','failed'));
alter table processing_jobs add column if not exists result jsonb;
