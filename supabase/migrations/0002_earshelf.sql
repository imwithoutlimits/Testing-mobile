create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null, author text, source_type text not null,
  language text, doc_type text, subject text, difficulty text,
  word_count int, page_count int, duration_min int, cover_path text,
  status text not null default 'queued',
  reading_mode text not null default 'clean',
  tags text[] not null default '{}',
  last_played_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table document_files (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null, mime text, bytes bigint, is_original boolean not null default true,
  created_at timestamptz not null default now()
);
create table document_sections (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  position int not null, title text, level int not null default 1
);
create table document_blocks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  section_id uuid references document_sections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  position int not null, type text not null, text text not null default '',
  level int, page int, data jsonb
);
create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  block_ids uuid[] not null default '{}',
  content text not null,
  tsv tsvector generated always as (to_tsvector('english', content)) stored,
  embedding vector(384)
);
create table document_metadata (
  document_id uuid primary key references documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  cleanup_report jsonb, extra jsonb
);
create table document_figures (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  block_id uuid references document_blocks(id) on delete cascade,
  caption text, storage_path text, page int
);
create table document_tables (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  block_id uuid references document_blocks(id) on delete cascade,
  caption text, rows jsonb not null default '[]', page int
);
create table document_pronunciations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade, -- null = applies to all documents
  term text not null, say text not null,
  unique (user_id, document_id, term)
);

create index documents_user_idx on documents (user_id, updated_at desc);
create index blocks_doc_idx on document_blocks (document_id, position);
create index chunks_tsv_idx on document_chunks using gin (tsv);
create index chunks_trgm_idx on document_chunks using gin (content gin_trgm_ops);
create index chunks_vec_idx on document_chunks using hnsw (embedding vector_cosine_ops);

do $$ declare t text; begin
  foreach t in array array['documents','document_files','document_sections','document_blocks','document_chunks','document_metadata','document_figures','document_tables','document_pronunciations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy own_rows on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop; end $$;
create trigger documents_updated before update on documents for each row execute function set_updated_at();

-- Private buckets; files live under <user_id>/...; signed URLs for downloads.
insert into storage.buckets (id, name, public) values ('originals','originals',false), ('audio','audio',false)
  on conflict (id) do nothing;
create policy own_storage_read on storage.objects for select using (bucket_id in ('originals','audio') and (storage.foldername(name))[1] = auth.uid()::text);
create policy own_storage_write on storage.objects for insert with check (bucket_id in ('originals','audio') and (storage.foldername(name))[1] = auth.uid()::text);
create policy own_storage_delete on storage.objects for delete using (bucket_id in ('originals','audio') and (storage.foldername(name))[1] = auth.uid()::text);
