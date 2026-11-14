import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectBusiness, ownerUser, setup, OWNER } from './helpers.js';
import { reconcileJobs } from '../src/jobs/reconcile.js';
import { jobIds } from '../src/services/queue.js';
import { silentLogger } from '../src/services/logger.js';

test('restart: jobs lost from Redis are re-created from the database', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const story = await env.stories.schedule(owner, {
    media: { type: 'photo', fileId: 'P' }, caption: '', activePeriod: 86400, postToChatPage: false, protectContent: false,
  }, new Date(env.now().getTime() + 3_600_000));
  const send = await env.media.create(owner, {
    media: { type: 'photo', fileId: 'P' }, caption: '', targetChatId: OWNER, deleteAfter: 3600, hasSpoiler: false, protectContent: false,
  }, new Date(env.now().getTime() + 600_000));
  const sent = await env.media.create(owner, {
    media: { type: 'photo', fileId: 'P' }, caption: '', targetChatId: OWNER, deleteAfter: 3600, hasSpoiler: false, protectContent: false,
  }, null);
  await env.media.processSend(sent.id, { isFinalAttempt: true });

  env.queue.jobs = []; // simulate Redis wiped / not persisted
  env.advance(60_000); // bot was down for one minute
  const res = await reconcileJobs({ repo: env.repo, queue: env.queue, logger: silentLogger, now: env.now }, owner);
  assert.deepEqual(res, { storiesRequeued: 1, storiesInterrupted: 0, sendsRequeued: 1, deletesRequeued: 1 });
  assert.equal(env.queue.jobs.find((j) => j.jobId === jobIds.story(story.id))!.delayMs, 3_540_000);
  assert.equal(env.queue.jobs.find((j) => j.jobId === jobIds.mediaSend(send.id))!.delayMs, 540_000);
  assert.equal(env.queue.jobs.find((j) => j.jobId === jobIds.mediaDelete(sent.id))!.delayMs, 3_540_000);

  // idempotent: running again does not duplicate anything
  const again = await reconcileJobs({ repo: env.repo, queue: env.queue, logger: silentLogger, now: env.now }, owner);
  assert.deepEqual(again, { storiesRequeued: 0, storiesInterrupted: 0, sendsRequeued: 0, deletesRequeued: 0 });
  assert.equal(env.queue.jobs.length, 3);
});

test('restart: overdue tasks run immediately', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  const t = await env.media.create(owner, {
    media: { type: 'photo', fileId: 'P' }, caption: '', targetChatId: OWNER, deleteAfter: null, hasSpoiler: false, protectContent: false,
  }, new Date(env.now().getTime() + 60_000));
  env.queue.jobs = [];
  env.advance(3_600_000);
  await reconcileJobs({ repo: env.repo, queue: env.queue, logger: silentLogger, now: env.now }, owner);
  assert.equal(env.queue.jobs.find((j) => j.jobId === jobIds.mediaSend(t.id))!.delayMs, 0);
});

test('restart: a story interrupted mid-upload is marked failed, never re-posted blindly', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.postNow(owner, {
    media: { type: 'photo', fileId: 'P' }, caption: '', activePeriod: 86400, postToChatPage: false, protectContent: false,
  });
  await env.repo.updateStory(row.id, { status: 'posting' });
  env.queue.jobs = [];
  const res = await reconcileJobs({ repo: env.repo, queue: env.queue, logger: silentLogger, now: env.now }, owner);
  assert.equal(res.storiesInterrupted, 1);
  assert.equal((await env.repo.getStory(row.id))!.status, 'failed');
  assert.equal(env.queue.jobs.length, 0);
});
