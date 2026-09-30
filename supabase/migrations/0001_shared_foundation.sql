-- Shared foundation for earshelf and tapestry. Every user-owned table has RLS.
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists vector;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null check (product in ('earshelf','tapestry')),
  prefs jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, product)
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_subscription_id text not null,
  variant_id text,
  status text not null,
  renews_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);

create table entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null check (product in ('earshelf','tapestry')),
  plan text not null default 'free' check (plan in ('free','plus','pro')),
  active boolean not null default false,
  source text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, product)
);

create table usage_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null,
  metric text not null,
  period_start date not null,
  period_end date not null,
  used numeric not null default 0,
  "limit" numeric,
  primary key (user_id, product, metric, period_start)
);

create table usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, metric text not null, amount numeric not null default 1,
  created_at timestamptz not null default now()
);

create table billing_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  primary key (provider, event_id)
);
-- NOTE: server code checks billing_events by event_id; provider is constant today.
create unique index billing_events_event_id_key on billing_events (event_id);

create table wells (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null check (product in ('earshelf','tapestry')),
  name text not null,
  description text,
  kind text not null default 'custom' check (kind in ('default','custom','smart')),
  smart_rule jsonb,
  visibility text not null default 'private' check (visibility in ('private','shared','public')),
  voice_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table well_items (
  id uuid primary key default gen_random_uuid(),
  well_id uuid not null references wells(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null, item_id uuid not null,
  position int not null default 0,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  unique (well_id, item_type, item_id)
);

create table playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table playlist_items (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references playlists(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null, item_id uuid not null, position int not null default 0
);

create table audio_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null,
  owner_type text not null, owner_id uuid not null,
  storage_path text not null,
  provider text not null, model text, model_version text, voice_id text,
  duration_ms int, bytes bigint,
  created_at timestamptz not null default now()
);
create table audio_segments (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references audio_assets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  utterance_id text not null,
  start_ms int not null, end_ms int
);

create table playback_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, item_type text not null, item_id uuid not null,
  utterance_index int not null default 0,
  position_ms int not null default 0,
  completed boolean not null default false,
  device_id text,
  updated_at timestamptz not null default now(),
  primary key (user_id, product, item_type, item_id)
);

create table bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, item_type text not null, item_id uuid not null,
  locator jsonb not null default '{}', label text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table highlights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, item_type text not null, item_id uuid not null,
  locator jsonb not null default '{}', text text not null, color text default 'amber',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, item_type text not null, item_id uuid not null,
  locator jsonb not null default '{}', body text not null,
  is_private boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table downloads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, item_type text not null, item_id uuid not null,
  bytes bigint, device_id text, created_at timestamptz not null default now()
);
create table search_queries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, query text not null, created_at timestamptz not null default now()
);
create table recommendations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, payload jsonb not null, reason text,
  created_at timestamptz not null default now()
);
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, kind text not null, payload jsonb not null default '{}',
  read_at timestamptz, created_at timestamptz not null default now()
);
create table processing_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null,
  kind text not null,
  subject_id uuid,
  state text not null default 'queued' check (state in ('queued','uploading','uploaded','extracting','ocr_processing','structuring','indexing','ready','failed')),
  progress numeric,
  error text,
  attempts int not null default 0,
  provider text, model text, model_version text,
  history jsonb not null default '[]',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table ai_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  product text not null, kind text not null,
  provider text, model text, prompt_version text,
  input_ref jsonb, output jsonb, created_at timestamptz not null default now()
);
create table feature_flags (
  key text primary key, enabled boolean not null default false, description text
);

-- updated_at triggers
do $$ declare t text; begin
  foreach t in array array['profiles','user_preferences','subscriptions','entitlements','wells','playlists','playback_progress','bookmarks','highlights','notes','processing_jobs'] loop
    execute format('create trigger %I_updated before update on %I for each row execute function set_updated_at()', t, t);
  end loop; end $$;

-- Row Level Security: users only touch their own rows.
do $$ declare t text; begin
  foreach t in array array['profiles','user_preferences','wells','well_items','playlists','playlist_items','audio_assets','audio_segments','playback_progress','bookmarks','highlights','notes','downloads','search_queries','recommendations','notifications','processing_jobs','ai_generations','usage_events'] loop
    execute format('alter table %I enable row level security', t);
  end loop; end $$;

create policy own_profile on profiles for all using (id = auth.uid()) with check (id = auth.uid());
do $$ declare t text; begin
  foreach t in array array['user_preferences','wells','well_items','playlists','playlist_items','audio_assets','audio_segments','playback_progress','bookmarks','highlights','notes','downloads','search_queries','recommendations','notifications','ai_generations'] loop
    execute format('create policy own_rows on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop; end $$;

-- Jobs and usage are written by server code; clients may only read them.
create policy read_own_jobs on processing_jobs for select using (user_id = auth.uid());
create policy read_own_usage_events on usage_events for select using (user_id = auth.uid());

-- Billing tables: clients read their own; only the service role writes (bypasses RLS).
alter table subscriptions enable row level security;
alter table entitlements enable row level security;
alter table usage_counters enable row level security;
alter table billing_events enable row level security; -- no policies: service role only
alter table feature_flags enable row level security;
create policy read_own_subscriptions on subscriptions for select using (user_id = auth.uid());
create policy read_own_entitlements on entitlements for select using (user_id = auth.uid());
create policy read_own_counters on usage_counters for select using (user_id = auth.uid());
create policy read_flags on feature_flags for select using (true);

-- Public wells expose only explicitly shared items, never notes.
create policy public_wells on wells for select using (visibility = 'public');
create policy public_well_items on well_items for select using (
  is_public and exists (select 1 from wells w where w.id = well_id and w.visibility = 'public'));
