import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectBusiness, ownerUser, setup, OWNER } from './helpers.js';
import { StoryError, validateStoryDraft } from '../src/modules/stories/story.service.js';
import { jobIds } from '../src/services/queue.js';
import type { StoryDraft } from '../src/services/state-store.js';

const draft = (over: Partial<StoryDraft> = {}): StoryDraft => ({
  media: { type: 'photo', fileId: 'PHOTO_1' },
  caption: 'Salom!',
  activePeriod: 86400,
  postToChatPage: true,
  protectContent: false,
  ...over,
});

test('stories: only official active_period values pass validation', () => {
  assert.deepEqual(validateStoryDraft(draft()), []);
  assert.equal(validateStoryDraft(draft({ activePeriod: 3600 })).length, 1);
  assert.equal(validateStoryDraft(draft({ caption: 'x'.repeat(2049) })).length, 1);
});

test('stories: post now downloads the file and calls postStory', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.postNow(owner, draft());
  assert.equal(row.status, 'posted');
  assert.equal(row.story_id, 77);
  const call = env.fake.byMethod('postStory')[0]!;
  assert.equal(call.params.caption, 'Salom!');
  assert.equal(call.params.active_period, 86400);
  assert.equal(env.fake.byMethod('getFile')[0]!.params.file_id, 'PHOTO_1');
  assert.equal(env.repo.logs.at(-1)!.action, 'post');
});

test('permission: story fails clearly without business connection or can_manage_stories', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await assert.rejects(env.stories.postNow(owner, draft()), (e: Error) => e instanceof StoryError && /Business ulanmagan/.test(e.message));

  await connectBusiness(env, { can_reply: true });
  await assert.rejects(env.stories.postNow(owner, draft()), /Manage stories/);
  assert.equal(env.fake.byMethod('postStory').length, 0);
});

test('stories: telegram error is stored and explained', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  env.fake.fail('postStory', 400, 'Bad Request: PREMIUM_ACCOUNT_REQUIRED');
  await assert.rejects(env.stories.postNow(owner, draft()), /Premium/);
  const [row] = [...env.repo.stories.values()];
  assert.equal(row!.status, 'failed');
  assert.match(row!.error!, /PREMIUM_ACCOUNT_REQUIRED/);
});

test('stories: schedule enqueues delayed job; cancel removes it', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const at = new Date(env.now().getTime() + 3_600_000);
  const row = await env.stories.schedule(owner, draft(), at);
  const job = env.queue.jobs.find((j) => j.jobId === jobIds.story(row.id))!;
  assert.equal(job.name, 'story.post');
  assert.equal(job.delayMs, 3_600_000);

  await env.stories.cancel(owner, row.id);
  assert.equal(env.queue.jobs.length, 0);
  assert.equal((await env.repo.getStory(row.id))!.status, 'cancelled');
  // a cancelled story is never posted even if a stale job fires
  await env.stories.runScheduled(row.id, { isFinalAttempt: true });
  assert.equal(env.fake.byMethod('postStory').length, 0);
});

test('stories: schedule rejects times in the past', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  await assert.rejects(env.stories.schedule(owner, draft(), new Date(env.now().getTime() - 1000)), /30 soniya/);
});

test('error handling: scheduled job retries, then fails and notifies the owner', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.schedule(owner, draft(), new Date(env.now().getTime() + 60_000));
  env.fake.fail('postStory', 500, 'Internal Server Error');

  await assert.rejects(env.stories.runScheduled(row.id, { isFinalAttempt: false }));
  assert.equal((await env.repo.getStory(row.id))!.status, 'scheduled');

  await env.stories.runScheduled(row.id, { isFinalAttempt: true });
  assert.equal((await env.repo.getStory(row.id))!.status, 'failed');
  const notice = env.fake.byMethod('sendMessage').at(-1)!;
  assert.equal(notice.params.chat_id, OWNER);
  assert.match(String(notice.params.text), /joylanmadi/);
});

test('stories: delete and edit posted story', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.postNow(owner, draft());
  await env.stories.editCaption(owner, row.id, 'Yangi');
  assert.equal(env.fake.byMethod('editStory')[0]!.params.caption, 'Yangi');
  await env.stories.deletePosted(owner, row.id);
  assert.deepEqual(env.fake.byMethod('deleteStory')[0]!.params, { business_connection_id: 'bc_1', story_id: 77 });
  assert.equal((await env.repo.getStory(row.id))!.status, 'deleted');
});
