import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, connectBusiness, ownerUser, setup } from './helpers.js';
import { jobIds } from '../src/services/queue.js';
import type { MediaDraft } from '../src/services/state-store.js';

const draft = (over: Partial<MediaDraft> = {}): MediaDraft => ({
  media: { type: 'photo', fileId: 'P1' },
  caption: '',
  targetChatId: OWNER,
  targetTitle: 'self',
  deleteAfter: 10,
  hasSpoiler: true,
  protectContent: true,
  ...over,
});

test('timed media: send now → message sent → auto-delete scheduled → deleted', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  const row = await env.media.create(owner, draft(), null);
  assert.equal(env.queue.take(jobIds.mediaSend(row.id))!.delayMs, 0);

  const sent = await env.media.processSend(row.id, { isFinalAttempt: false });
  assert.equal(sent!.status, 'sent');
  const p = env.fake.byMethod('sendPhoto')[0]!.params;
  assert.equal(p.photo, 'P1');
  assert.equal(p.has_spoiler, true);
  assert.equal(p.protect_content, true);
  const del = env.queue.take(jobIds.mediaDelete(row.id))!;
  assert.equal(del.delayMs, 10_000);

  const deleted = await env.media.processDelete(row.id, { isFinalAttempt: false });
  assert.equal(deleted!.status, 'deleted');
  assert.equal(env.fake.byMethod('deleteMessage')[0]!.params.message_id, sent!.sent_message_id);
});

test('timed media: business chat uses business_connection_id and deleteBusinessMessages', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  await env.repo.touchBusinessChat({ business_connection_id: 'bc_1', chat_id: 555, title: 'Client', last_incoming_at: env.now().toISOString() });
  const row = await env.media.create(owner, draft({ targetChatId: 555, businessConnectionId: 'bc_1' }), null);
  await env.media.processSend(row.id, { isFinalAttempt: false });
  assert.equal(env.fake.byMethod('sendPhoto')[0]!.params.business_connection_id, 'bc_1');
  await env.media.processDelete(row.id, { isFinalAttempt: false });
  assert.deepEqual(env.fake.byMethod('deleteBusinessMessages')[0]!.params.message_ids, [env.repo.media.get(row.id)!.sent_message_id]);
});

test('permission: business targets require can_reply and a message in the last 24h', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  await env.repo.touchBusinessChat({ business_connection_id: 'bc_1', chat_id: 1, title: 'Fresh', last_incoming_at: env.now().toISOString() });
  await env.repo.touchBusinessChat({ business_connection_id: 'bc_1', chat_id: 2, title: 'Old', last_incoming_at: new Date(env.now().getTime() - 25 * 3_600_000).toISOString() });
  const titles = (await env.media.listTargets(owner)).map((t) => t.title);
  assert.ok(titles.some((t) => t.includes('Fresh')));
  assert.ok(!titles.some((t) => t.includes('Old')));

  const env2 = setup();
  const owner2 = await connectBusiness(env2, { can_manage_stories: true });
  await env2.repo.touchBusinessChat({ business_connection_id: 'bc_1', chat_id: 1, title: 'Fresh', last_incoming_at: env2.now().toISOString() });
  assert.equal((await env2.media.listTargets(owner2)).filter((t) => t.kind === 'business').length, 0);
});

test('timed media: cancel scheduled send, then cancel pending auto-delete', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  const at = new Date(env.now().getTime() + 600_000);
  const a = await env.media.create(owner, draft(), at);
  assert.equal((await env.media.cancel(owner, a.id)).what, 'send');
  assert.equal(env.queue.jobs.length, 0);

  const b = await env.media.create(owner, draft({ deleteAfter: 3600 }), null);
  await env.media.processSend(b.id, { isFinalAttempt: false });
  assert.equal((await env.media.cancel(owner, b.id)).what, 'auto-delete');
  assert.ok(!env.queue.jobs.some((j) => j.jobId === jobIds.mediaDelete(b.id)));
  assert.equal(await env.media.processDelete(b.id, { isFinalAttempt: true }).then((r) => r!.status), 'sent');
});

test('error handling: send retries then fails with owner notification', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  env.fake.fail('sendPhoto', 400, 'Bad Request: chat not found');
  const row = await env.media.create(owner, draft(), null);
  await assert.rejects(env.media.processSend(row.id, { isFinalAttempt: false }));
  assert.equal(env.repo.media.get(row.id)!.status, 'scheduled');
  await env.media.processSend(row.id, { isFinalAttempt: true });
  assert.equal(env.repo.media.get(row.id)!.status, 'failed');
  assert.match(String(env.fake.byMethod('sendMessage').at(-1)!.params.text), /Chat topilmadi/);
});

test('error handling: already-deleted message counts as deleted', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  const row = await env.media.create(owner, draft(), null);
  await env.media.processSend(row.id, { isFinalAttempt: false });
  env.fake.fail('deleteMessage', 400, 'Bad Request: message to delete not found');
  assert.equal((await env.media.processDelete(row.id, { isFinalAttempt: false }))!.status, 'deleted');
});

test('timed media: validation', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await assert.rejects(env.media.create(owner, draft({ targetChatId: undefined }), null), /tanlanmagan/);
  await assert.rejects(env.media.create(owner, draft({ deleteAfter: 5 }), null), /muddati/);
});
