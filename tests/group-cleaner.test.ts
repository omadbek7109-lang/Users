import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_ID, OWNER, STRANGER, ownerUser, setup, type Env } from './helpers.js';
import { hasLink } from '../src/modules/group-cleaner/link-detector.js';

const CHAT = -100500;

async function registerGroup(env: Env, canDelete = true) {
  const owner = await ownerUser(env);
  await env.repo.upsertGroup({ chat_id: CHAT, user_id: owner.id, title: 'G', bot_can_delete: canDelete, track_messages: true });
  return owner;
}

async function trackN(env: Env, n: number, opts: { link?: (i: number) => boolean; ageMs?: number } = {}) {
  const base = Math.floor((env.now().getTime() - (opts.ageMs ?? 60_000)) / 1000);
  for (let i = 1; i <= n; i++) {
    await env.cleaner.track({
      message_id: i, date: base + i, chat: { id: CHAT, type: 'supergroup' }, from: { id: STRANGER, is_bot: false, first_name: 'S' },
      text: opts.link?.(i) ? 'see https://example.com' : 'hello',
    });
  }
}

test('link detector', () => {
  assert.ok(hasLink({ text: 'go to t.me/channel' }));
  assert.ok(hasLink({ text: 'site.uz' }));
  assert.ok(hasLink({ text: 'x', entities: [{ type: 'text_link', offset: 0, length: 1, url: 'https://a.b' }] }));
  assert.ok(!hasLink({ text: 'oddiy xabar, 3.5 kg' }));
});

test('permission: prepare refuses when bot is not an admin with delete rights', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 3);
  env.fake.handlers.getChatMember = () => ({ status: 'member', user: { id: BOT_ID, is_bot: true, first_name: 'B' } });
  const r = await env.cleaner.prepare(owner, CHAT, 'last_n', 2);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /admin emas/);
  assert.equal((await env.repo.getGroup(CHAT))!.bot_can_delete, false);
});

test('cleaner: /delete N picks newest N tracked messages, excluding the command', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 10);
  const r = await env.cleaner.prepare(owner, CHAT, 'last_n', 3, [10]);
  assert.ok(r.ok);
  assert.deepEqual(r.task.message_ids, [9, 8, 7]);
  assert.equal(r.task.status, 'pending_confirmation');
  assert.equal(env.fake.byMethod('deleteMessages').length, 0, 'nothing deleted before confirmation');
});

test('cleaner: messages older than 48h are never selected', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 5, { ageMs: 49 * 3_600_000 });
  const r = await env.cleaner.prepare(owner, CHAT, 'clear');
  assert.equal(r.ok, false);
});

test('cleaner: /cleanlinks selects only link messages', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 6, { link: (i) => i % 2 === 0 });
  const r = await env.cleaner.prepare(owner, CHAT, 'links');
  assert.ok(r.ok);
  assert.deepEqual(r.task.message_ids, [6, 4, 2]);
});

test('cleaner: execute deletes in batches of 100 and records history', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 250);
  const r = await env.cleaner.prepare(owner, CHAT, 'clear');
  assert.ok(r.ok);
  const res = await env.cleaner.execute(owner, r.task.id);
  const calls = env.fake.byMethod('deleteMessages');
  assert.deepEqual(calls.map((c) => (c.params.message_ids as number[]).length), [100, 100, 50]);
  assert.equal(res.deleted, 250);
  assert.equal(res.task.status, 'done');
  assert.equal((await env.repo.listTrackedMessages(CHAT, { since: new Date(0), limit: 1000 })).length, 0);
  assert.ok(env.repo.logs.some((l) => l.action === 'delete-clear' && l.status === 'ok'));
});

test('error handling: failed batch → partial status with reason', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 150);
  let n = 0;
  env.fake.handlers.deleteMessages = () => (++n === 2 ? { __error: { error_code: 400, description: "Bad Request: message can't be deleted" } } : true);
  const r = await env.cleaner.prepare(owner, CHAT, 'clear');
  assert.ok(r.ok);
  const res = await env.cleaner.execute(owner, r.task.id);
  assert.equal(res.task.status, 'partial');
  assert.equal(res.deleted, 100);
  assert.match(res.errors[0]!, /48 soat/);
});

test('cleaner: confirmation expires after 10 minutes and tasks can be cancelled', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 5);
  const r1 = await env.cleaner.prepare(owner, CHAT, 'last_n', 2);
  assert.ok(r1.ok);
  env.advance(11 * 60_000);
  await assert.rejects(env.cleaner.execute(owner, r1.task.id), /muddati/);

  const r2 = await env.cleaner.prepare(owner, CHAT, 'last_n', 2);
  assert.ok(r2.ok);
  assert.equal(await env.cleaner.cancel(owner, CHAT), 1);
  await assert.rejects(env.cleaner.execute(owner, r2.task.id), /bekor/);
  assert.equal(env.fake.byMethod('deleteMessages').length, 0);
});

test('security: bot leaves a group added by a stranger', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  const res = await env.cleaner.onMembership({
    chat: { id: CHAT, type: 'supergroup', title: 'Foreign' }, from: { id: STRANGER, is_bot: false, first_name: 'S' }, date: 1,
    old_chat_member: { status: 'left', user: { id: BOT_ID, is_bot: true, first_name: 'B' } },
    new_chat_member: { status: 'member', user: { id: BOT_ID, is_bot: true, first_name: 'B' } },
  }, owner);
  assert.equal(res, 'left');
  assert.equal(env.fake.byMethod('leaveChat').length, 1);
  assert.equal(await env.repo.getGroup(CHAT), null);

  const ok = await env.cleaner.onMembership({
    chat: { id: CHAT, type: 'supergroup', title: 'Mine' }, from: { id: OWNER, is_bot: false, first_name: 'O' }, date: 1,
    old_chat_member: { status: 'left', user: { id: BOT_ID, is_bot: true, first_name: 'B' } },
    new_chat_member: { status: 'administrator', user: { id: BOT_ID, is_bot: true, first_name: 'B' }, can_delete_messages: true },
  }, owner);
  assert.equal(ok, 'registered');
  assert.equal((await env.repo.getGroup(CHAT))!.bot_can_delete, true);
});

test('48h: messages that aged out between /delete and confirmation are skipped', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  // 3 messages ~47h40m old (inside the window now), 2 fresh ones
  await trackN(env, 3, { ageMs: 47 * 3_600_000 + 40 * 60_000 });
  for (let i = 4; i <= 5; i++) {
    await env.cleaner.track({ message_id: i, date: Math.floor(env.now().getTime() / 1000) - 60, chat: { id: CHAT, type: 'supergroup' } });
  }
  const r = await env.cleaner.prepare(owner, CHAT, 'clear');
  assert.ok(r.ok);
  assert.equal(r.task.message_ids.length, 5);
  env.advance(9 * 60_000); // owner confirms 9 minutes later → old ones are now past the safety window
  const res = await env.cleaner.execute(owner, r.task.id);
  assert.deepEqual(env.fake.byMethod('deleteMessages')[0]!.params.message_ids, [5, 4]);
  assert.equal(res.task.status, 'partial');
  assert.match(res.errors[0]!, /3 ta xabar 48 soatlik/);
});

test('permission: rights are re-checked at confirmation time', async () => {
  const env = setup();
  const owner = await registerGroup(env);
  await trackN(env, 3);
  const r = await env.cleaner.prepare(owner, CHAT, 'clear');
  assert.ok(r.ok);
  env.fake.handlers.getChatMember = () => ({ status: 'administrator', user: { id: BOT_ID, is_bot: true, first_name: 'B' }, can_delete_messages: false });
  await assert.rejects(env.cleaner.execute(owner, r.task.id), /huquqi berilmagan/);
  assert.equal(env.fake.byMethod('deleteMessages').length, 0);
  assert.equal((await env.repo.getDeleteTask(r.task.id))!.status, 'failed');
});

test('supergroup migration moves settings to the new chat id', async () => {
  const env = setup();
  await registerGroup(env);
  await trackN(env, 2);
  await env.router.handle({ update_id: 1, message: { message_id: 99, date: 1, chat: { id: CHAT, type: 'group' }, from: { id: OWNER, is_bot: false, first_name: 'O' }, migrate_to_chat_id: -1009999 } });
  assert.equal(await env.repo.getGroup(CHAT), null);
  assert.equal((await env.repo.getGroup(-1009999))!.bot_can_delete, true);
});
