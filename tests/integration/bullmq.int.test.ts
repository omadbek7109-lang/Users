/**
 * REAL Redis + BullMQ: delays, retries, cancellation, survival across a process restart and
 * reconciliation after Redis lost its data. Requires REDIS_URL. Skipped otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { JobData, JobName } from '../../src/services/queue.js';
import { silentLogger } from '../../src/services/logger.js';
import { OWNER, setup } from '../helpers.js';
import { reconcileJobs } from '../../src/jobs/reconcile.js';
import { createProcessor } from '../../src/jobs/processor.js';

const URL = process.env.REDIS_URL;
const skip = !URL ? 'REDIS_URL not set' : false;

async function lib() {
  return import('../../src/services/bullmq-queue.js');
}

type Seen = { name: JobName; data: JobData; final: boolean; at: number };

async function waitFor(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('bullmq: delayed job runs after its delay, not before', { skip, timeout: 20_000 }, async () => {
  const { BullJobQueue, createRedis, startWorker } = await lib();
  const prefix = `t-${randomUUID()}`;
  const conn = createRedis(URL!);
  const queue = new BullJobQueue(conn, { prefix });
  const seen: Seen[] = [];
  const worker = startWorker(conn, async (name, data, ctx) => void seen.push({ name, data, final: ctx.isFinalAttempt, at: Date.now() }), silentLogger, { prefix });
  try {
    const t0 = Date.now();
    await queue.enqueue('media.send', { id: 'a' }, { jobId: 'job-a', delayMs: 1500 });
    assert.equal(await queue.has('job-a'), true);
    await waitFor(() => seen.length === 1, 10_000);
    assert.ok(seen[0]!.at - t0 >= 1400, `ran after ${seen[0]!.at - t0}ms`);
    assert.deepEqual(seen[0]!.data, { id: 'a' });
    await waitFor(() => true, 100);
    assert.equal(await queue.has('job-a'), false, 'completed job is not "live"');
  } finally {
    await worker.close();
    await queue.close();
    conn.disconnect();
  }
});

test('bullmq: failed job is retried and the last attempt is marked final', { skip, timeout: 20_000 }, async () => {
  const { BullJobQueue, createRedis, startWorker } = await lib();
  const prefix = `t-${randomUUID()}`;
  const conn = createRedis(URL!);
  const queue = new BullJobQueue(conn, { prefix, attempts: 3, backoffMs: 100 });
  const finals: boolean[] = [];
  const worker = startWorker(conn, async (_n, _d, ctx) => {
    finals.push(ctx.isFinalAttempt);
    throw new Error('telegram 500');
  }, silentLogger, { prefix });
  try {
    await queue.enqueue('story.post', { id: 's' }, { jobId: 'job-s' });
    await waitFor(() => finals.length === 3, 15_000);
    assert.deepEqual(finals, [false, false, true]);
  } finally {
    await worker.close();
    await queue.close();
    conn.disconnect();
  }
});

test('bullmq: removed (cancelled) job never runs', { skip, timeout: 20_000 }, async () => {
  const { BullJobQueue, createRedis, startWorker } = await lib();
  const prefix = `t-${randomUUID()}`;
  const conn = createRedis(URL!);
  const queue = new BullJobQueue(conn, { prefix });
  let ran = 0;
  const worker = startWorker(conn, async () => void ran++, silentLogger, { prefix });
  try {
    await queue.enqueue('media.delete', { id: 'x' }, { jobId: 'job-x', delayMs: 800 });
    assert.equal(await queue.remove('job-x'), true);
    assert.equal(await queue.has('job-x'), false);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(ran, 0);
  } finally {
    await worker.close();
    await queue.close();
    conn.disconnect();
  }
});

test('restart: a delayed job survives the process going away', { skip, timeout: 30_000 }, async () => {
  const { BullJobQueue, createRedis, startWorker } = await lib();
  const prefix = `t-${randomUUID()}`;
  // "process 1": schedules and shuts down before the job is due
  const c1 = createRedis(URL!);
  const q1 = new BullJobQueue(c1, { prefix });
  await q1.enqueue('story.post', { id: 'persist' }, { jobId: 'job-p', delayMs: 2000 });
  await q1.close();
  c1.disconnect();

  // "process 2": new connection + worker picks it up
  const c2 = createRedis(URL!);
  const q2 = new BullJobQueue(c2, { prefix });
  const seen: string[] = [];
  const worker = startWorker(c2, async (_n, d) => void seen.push(d.id), silentLogger, { prefix });
  try {
    assert.equal(await q2.has('job-p'), true);
    await waitFor(() => seen.length === 1, 15_000);
    assert.deepEqual(seen, ['persist']);
  } finally {
    await worker.close();
    await q2.close();
    c2.disconnect();
  }
});

test('restart: after Redis data loss, reconcile re-creates the job and the real worker sends the media', { skip, timeout: 30_000 }, async () => {
  const { BullJobQueue, createRedis, startWorker } = await lib();
  const prefix = `t-${randomUUID()}`;
  const env = setup({ now: new Date() });
  const owner = await env.repo.ensureUser(OWNER);
  const conn = createRedis(URL!);
  const queue = new BullJobQueue(conn, { prefix });
  // task exists in the DB, but its job is gone (e.g. Redis without persistence restarted)
  const task = await env.repo.createMediaTask({
    user_id: owner.id, target_chat_id: OWNER, business_connection_id: null, media_type: 'photo', file_id: 'P', caption: null,
    has_spoiler: false, protect_content: false, send_at: new Date(Date.now() + 500).toISOString(), delete_after_seconds: null,
  });
  assert.equal(await queue.has(`media-send-${task.id}`), false);

  const res = await reconcileJobs({ repo: env.repo, queue, logger: silentLogger }, owner);
  assert.equal(res.sendsRequeued, 1);
  const again = await reconcileJobs({ repo: env.repo, queue, logger: silentLogger }, owner);
  assert.equal(again.sendsRequeued, 0, 'idempotent while the job is live');

  const worker = startWorker(conn, createProcessor({ stories: env.stories, media: env.media }), silentLogger, { prefix });
  try {
    await waitFor(() => env.repo.media.get(task.id)!.status === 'sent', 15_000);
    assert.equal(env.fake.byMethod('sendPhoto').length, 1);
  } finally {
    await worker.close();
    await queue.close();
    conn.disconnect();
  }
});

test('bullmq: re-enqueue with the same id replaces the old job (no duplicates)', { skip, timeout: 20_000 }, async () => {
  const { BullJobQueue, createRedis, startWorker } = await lib();
  const prefix = `t-${randomUUID()}`;
  const conn = createRedis(URL!);
  const queue = new BullJobQueue(conn, { prefix });
  const seen: number[] = [];
  try {
    await queue.enqueue('media.send', { id: 'd' }, { jobId: 'job-d', delayMs: 60_000 });
    await queue.enqueue('media.send', { id: 'd' }, { jobId: 'job-d', delayMs: 300 });
    const worker = startWorker(conn, async () => void seen.push(Date.now()), silentLogger, { prefix });
    await waitFor(() => seen.length === 1, 10_000);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(seen.length, 1);
    await worker.close();
  } finally {
    await queue.close();
    conn.disconnect();
  }
});
