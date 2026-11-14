-- Personal Telegram AI Assistant — initial schema
-- Server connects with the service_role key (bypasses RLS). RLS is enabled on every table with
-- NO policies for anon/authenticated, so the public API keys cannot read or write anything.

create extension if not exists pgcrypto;

-- ---------- helpers ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- users ----------
create table public.users (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint not null unique,
  username     text,
  first_name   text,
  settings     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------- business_connections ----------
create table public.business_connections (
  id            text primary key,                      -- business_connection_id from Telegram
  user_id       uuid not null references public.users(id) on delete cascade,
  user_chat_id  bigint not null,
  rights        jsonb not null default '{}'::jsonb,
  is_enabled    boolean not null default true,
  connected_at  timestamptz not null,
  updated_at    timestamptz not null default now()
);
create index business_connections_user_idx on public.business_connections(user_id, is_enabled);

-- Private chats of the business account that the bot has seen (needed for can_reply 24h rule)
create table public.business_chats (
  business_connection_id text not null references public.business_connections(id) on delete cascade,
  chat_id                bigint not null,
  title                  text,
  last_incoming_at       timestamptz not null,
  primary key (business_connection_id, chat_id)
);
create index business_chats_recent_idx on public.business_chats(business_connection_id, last_incoming_at desc);

-- ---------- scheduled_stories ----------
create table public.scheduled_stories (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.users(id) on delete cascade,
  business_connection_id  text not null references public.business_connections(id) on delete cascade,
  media_type              text not null check (media_type in ('photo','video')),
  file_id                 text not null,
  video_duration          integer,
  caption                 text check (caption is null or char_length(caption) <= 2048),
  active_period           integer not null check (active_period in (21600, 43200, 86400, 172800)),
  post_to_chat_page       boolean not null default false,
  protect_content         boolean not null default false,
  status                  text not null default 'scheduled'
                          check (status in ('scheduled','posting','posted','failed','cancelled','deleted')),
  scheduled_at            timestamptz not null default now(),
  posted_at               timestamptz,
  story_id                bigint,
  story_chat_id           bigint,
  attempts                integer not null default 0,
  error                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index scheduled_stories_user_status_idx on public.scheduled_stories(user_id, status, scheduled_at);

-- ---------- media_tasks ----------
create table public.media_tasks (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.users(id) on delete cascade,
  target_chat_id          bigint not null,
  target_title            text,
  business_connection_id  text references public.business_connections(id) on delete set null,
  media_type              text not null check (media_type in ('photo','video')),
  file_id                 text not null,
  caption                 text check (caption is null or char_length(caption) <= 1024),
  has_spoiler             boolean not null default false,
  protect_content         boolean not null default false,
  send_at                 timestamptz not null default now(),
  delete_after_seconds    integer check (delete_after_seconds is null or delete_after_seconds between 10 and 86400),
  status                  text not null default 'scheduled'
                          check (status in ('scheduled','sent','deleted','failed','cancelled')),
  sent_message_id         bigint,
  sent_at                 timestamptz,
  delete_at               timestamptz,
  deleted_at              timestamptz,
  attempts                integer not null default 0,
  error                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index media_tasks_user_status_idx on public.media_tasks(user_id, status, send_at);

-- ---------- group_settings ----------
create table public.group_settings (
  chat_id         bigint primary key,
  user_id         uuid not null references public.users(id) on delete cascade,
  title           text,
  bot_can_delete  boolean not null default false,
  track_messages  boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index group_settings_user_idx on public.group_settings(user_id);

-- Only metadata of messages the bot actually received (no message text is stored).
create table public.tracked_messages (
  chat_id       bigint not null references public.group_settings(chat_id) on delete cascade,
  message_id    bigint not null,
  from_user_id  bigint,
  has_link      boolean not null default false,
  sent_at       timestamptz not null,
  deleted       boolean not null default false,
  primary key (chat_id, message_id)
);
create index tracked_messages_recent_idx on public.tracked_messages(chat_id, sent_at desc) where not deleted;
create index tracked_messages_links_idx on public.tracked_messages(chat_id, sent_at desc) where has_link and not deleted;

-- ---------- delete_tasks ----------
create table public.delete_tasks (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  chat_id          bigint not null references public.group_settings(chat_id) on delete cascade,
  mode             text not null check (mode in ('last_n','links','clear')),
  requested_count  integer,
  message_ids      bigint[] not null default '{}',
  status           text not null default 'pending_confirmation'
                   check (status in ('pending_confirmation','running','done','partial','failed','cancelled')),
  deleted_count    integer not null default 0,
  error            text,
  created_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  finished_at      timestamptz
);
create index delete_tasks_chat_status_idx on public.delete_tasks(chat_id, status);

-- ---------- ai_edits ----------
create table public.ai_edits (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  parent_id      uuid references public.ai_edits(id) on delete cascade,
  root_id        uuid references public.ai_edits(id) on delete cascade,
  provider       text,
  operation      text not null,
  source_text    text not null check (char_length(source_text) <= 8000),
  result_text    text not null check (char_length(result_text) <= 16000),
  created_at     timestamptz not null default now()
);
create index ai_edits_user_created_idx on public.ai_edits(user_id, created_at desc);
create index ai_edits_root_idx on public.ai_edits(root_id);

-- ---------- action_logs ----------
create table public.action_logs (
  id          bigint generated always as identity primary key,
  user_id     uuid references public.users(id) on delete set null,
  module      text not null,
  action      text not null,
  status      text not null check (status in ('ok','error','info')),
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index action_logs_user_created_idx on public.action_logs(user_id, created_at desc);

-- ---------- triggers ----------
create trigger users_updated_at before update on public.users for each row execute function public.set_updated_at();
create trigger business_connections_updated_at before update on public.business_connections for each row execute function public.set_updated_at();
create trigger scheduled_stories_updated_at before update on public.scheduled_stories for each row execute function public.set_updated_at();
create trigger media_tasks_updated_at before update on public.media_tasks for each row execute function public.set_updated_at();
create trigger group_settings_updated_at before update on public.group_settings for each row execute function public.set_updated_at();

-- ---------- security: RLS on, no public policies ----------
do $$
declare t text;
begin
  foreach t in array array[
    'users','business_connections','business_chats','scheduled_stories','media_tasks',
    'group_settings','tracked_messages','delete_tasks','ai_edits','action_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

revoke execute on function public.set_updated_at() from anon, authenticated, public;
