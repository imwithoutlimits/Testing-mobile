-- Sync support: Supabase is the source of truth, devices keep an offline cache.

alter table documents
  add column if not exists content_path text,   -- originals/<user>/<doc>/content.json (parsed text + cleanup settings)
  add column if not exists cleanup jsonb,
  add column if not exists report jsonb,
  add column if not exists source_name text,
  add column if not exists deleted_at timestamptz;

alter table wells add column if not exists deleted_at timestamptz;

alter table well_items alter column position type bigint;
alter table well_items
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table well_items drop constraint if exists well_items_well_id_item_type_item_id_key;
create unique index if not exists well_items_unique_live on well_items (well_id, item_type, item_id) where deleted_at is null;

alter table document_pronunciations
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table playback_progress add column if not exists total int not null default 0;

do $$ declare t text; begin
  foreach t in array array['well_items','document_pronunciations'] loop
    execute format('drop trigger if exists %I_updated on %I', t, t);
    execute format('create trigger %I_updated before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
  foreach t in array array['documents','wells','well_items','document_pronunciations','playback_progress','bookmarks','highlights','notes','user_preferences'] loop
    execute format('create index if not exists %I on %I (user_id, updated_at)', t || '_pull_idx', t);
  end loop;
end $$;

-- Uploads with upsert need an UPDATE policy as well.
drop policy if exists own_storage_update on storage.objects;
create policy own_storage_update on storage.objects for update
  using (bucket_id in ('originals','audio') and (storage.foldername(name))[1] = auth.uid()::text);

-- Atomic monthly usage counting. Only the server (service role) may call it.
create or replace function consume_usage(p_user uuid, p_product text, p_metric text, p_amount numeric, p_limit numeric)
returns table(is_allowed boolean, total_used numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_start date := date_trunc('month', now())::date;
  v_end date := (date_trunc('month', now()) + interval '1 month')::date;
  v_used numeric;
begin
  insert into usage_counters (user_id, product, metric, period_start, period_end, used, "limit")
  values (p_user, p_product, p_metric, v_start, v_end, 0, p_limit)
  on conflict do nothing;

  update usage_counters uc set used = uc.used + p_amount, "limit" = p_limit
  where uc.user_id = p_user and uc.product = p_product and uc.metric = p_metric and uc.period_start = v_start
    and (p_limit < 0 or uc.used + p_amount <= p_limit)
  returning uc.used into v_used;

  if v_used is null then
    select uc.used into v_used from usage_counters uc
    where uc.user_id = p_user and uc.product = p_product and uc.metric = p_metric and uc.period_start = v_start;
    return query select false, coalesce(v_used, 0);
  else
    return query select true, v_used;
  end if;
end $$;
revoke all on function consume_usage(uuid, text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function consume_usage(uuid, text, text, numeric, numeric) to service_role;
