/**
 * Applies supabase/migrations to a REAL Postgres and checks RLS / grants the way Supabase sets them up.
 * Requires DATABASE_URL (superuser) and the psql client. Skipped otherwise.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const DB = process.env.DATABASE_URL;
const skip = !DB ? 'DATABASE_URL not set' : false;

function psql(sql: string, opts: { file?: string } = {}) {
  const args = [DB!, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A'];
  if (opts.file) args.push('-f', opts.file);
  else args.push('-c', sql);
  const r = spawnSync('psql', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const TABLES = ['users', 'business_connections', 'business_chats', 'scheduled_stories', 'media_tasks',
  'group_settings', 'tracked_messages', 'delete_tasks', 'ai_edits', 'action_logs'];

before(() => {
  if (skip) return;
  // Reproduce Supabase defaults: API roles + default privileges that grant everything to anon/authenticated.
  const setup = psql(`
    drop schema if exists public cascade; create schema public;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
  assert.ok(setup.ok, setup.err);
  const dir = join(process.cwd(), 'supabase', 'migrations');
  for (const f of readdirSync(dir).sort()) {
    const r = psql('', { file: join(dir, f) });
    assert.ok(r.ok, `${f}: ${r.err}`);
  }
});

test('rls: every table has row level security enabled', { skip }, () => {
  const r = psql(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`);
  assert.ok(r.ok, r.err);
  assert.equal(r.out, '', `tables without RLS: ${r.out}`);
  const count = psql(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`);
  assert.equal(Number(count.out), TABLES.length);
});

test('rls: anon and authenticated have no table privileges at all', { skip }, () => {
  for (const role of ['anon', 'authenticated']) {
    for (const t of TABLES) {
      const sel = psql(`set role ${role}; select count(*) from public.${t};`);
      assert.equal(sel.ok, false, `${role} could read ${t}`);
      assert.match(sel.err, /permission denied/);
    }
    const ins = psql(`set role ${role}; insert into public.users(telegram_id) values (1);`);
    assert.equal(ins.ok, false);
  }
});

test('rls: even if someone grants SELECT to anon later, no rows leak (no policies)', { skip }, () => {
  assert.ok(psql(`insert into public.users(telegram_id) values (424242) on conflict do nothing;`).ok);
  assert.ok(psql(`grant select on public.users to anon;`).ok);
  const r = psql(`set role anon; select count(*) from public.users;`);
  assert.ok(r.ok, r.err);
  assert.equal(r.out, '0');
  assert.ok(psql(`revoke select on public.users from anon;`).ok);
});

test('rls: service_role (used by the bot server) can read and write', { skip }, () => {
  const r = psql(`set role service_role;
    insert into public.users(telegram_id) values (777) on conflict (telegram_id) do update set username='x' returning telegram_id;`);
  assert.ok(r.ok, r.err);
  assert.equal(r.out, '777');
  assert.equal(psql(`set role service_role; select count(*) from public.users where telegram_id=777;`).out, '1');
});

test('schema: constraints reject invalid story periods and cascade on delete', { skip }, () => {
  const u = psql(`insert into public.users(telegram_id) values (888) returning id;`).out;
  assert.ok(psql(`insert into public.business_connections(id,user_id,user_chat_id,connected_at) values ('bc_t','${u}',888,now());`).ok);
  const bad = psql(`insert into public.scheduled_stories(user_id,business_connection_id,media_type,file_id,active_period)
                    values ('${u}','bc_t','photo','f',3600);`);
  assert.equal(bad.ok, false);
  assert.match(bad.err, /check constraint/);
  assert.ok(psql(`insert into public.scheduled_stories(user_id,business_connection_id,media_type,file_id,active_period)
                  values ('${u}','bc_t','photo','f',86400);`).ok);
  assert.ok(psql(`delete from public.users where id='${u}';`).ok);
  assert.equal(psql(`select count(*) from public.scheduled_stories where user_id='${u}';`).out, '0');
});

test('schema: trigger function is not executable by API roles', { skip }, () => {
  const r = psql(`select has_function_privilege('anon','public.set_updated_at()','execute')::text,
                         has_function_privilege('authenticated','public.set_updated_at()','execute')::text;`);
  assert.equal(r.out, 'false|false');
});

test('grants: anon has no sequence or function privileges', { skip }, () => {
  const r = psql(`select count(*) from information_schema.role_usage_grants where grantee in ('anon','authenticated') and object_schema='public';`);
  assert.equal(r.out, '0');
  const f = psql(`select count(*) from information_schema.role_routine_grants where grantee in ('anon','authenticated') and routine_schema='public';`);
  assert.equal(f.out, '0');
});
