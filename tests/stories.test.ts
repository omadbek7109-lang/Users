import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectBusiness, ownerUser, setup, OWNER } from './helpers.js';
import { StoryError, validateStoryDraft } from '../src/modules/stories/story.service.js';
import { MediaPrepError } from '../src/modules/stories/media-prep.js';
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

test('stories: post now is queued, then the job downloads, prepares and calls postStory', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.postNow(owner, draft());
  assert.equal(row.status, 'scheduled');
  assert.equal(env.queue.jobs[0]!.jobId, jobIds.story(row.id));
  assert.equal(env.queue.jobs[0]!.delayMs, 0);
  assert.equal(env.fake.byMethod('postStory').length, 0, 'nothing posted inside the update handler');

  await env.drain();
  const done = (await env.repo.getStory(row.id))!;
  assert.equal(done.status, 'posted');
  assert.equal(done.story_id, 77);
  const call = env.fake.byMethod('postStory')[0]!;
  assert.equal(call.params.caption, 'Salom!');
  assert.equal(call.params.active_period, 86400);
  assert.equal(env.fake.byMethod('getFile')[0]!.params.file_id, 'PHOTO_1');
  assert.match(String(env.fake.byMethod('sendMessage').at(-1)!.params.text), /Story joylandi/);
});

test('permission: story is refused without business connection or can_manage_stories', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await assert.rejects(env.stories.postNow(owner, draft()), (e: Error) => e instanceof StoryError && /Business ulanmagan/.test(e.message));
  await connectBusiness(env, { can_reply: true });
  await assert.rejects(env.stories.postNow(owner, draft()), /Manage stories/);
  assert.equal(env.queue.jobs.length, 0);
});

test('stories: non-retryable telegram error fails immediately with explanation', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  env.fake.fail('postStory', 400, 'Bad Request: PREMIUM_ACCOUNT_REQUIRED');
  const row = await env.stories.postNow(owner, draft());
  await env.stories.runScheduled(row.id, { isFinalAttempt: false });
  const r = (await env.repo.getStory(row.id))!;
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /Premium/);
  assert.match(String(env.fake.byMethod('sendMessage').at(-1)!.params.text), /joylanmadi/);
});

test('error handling: 5xx is retried by the queue, final attempt fails and notifies', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.schedule(owner, draft(), new Date(env.now().getTime() + 60_000));
  env.fake.fail('postStory', 500, 'Internal Server Error');
  await assert.rejects(env.stories.runScheduled(row.id, { isFinalAttempt: false }));
  assert.equal((await env.repo.getStory(row.id))!.status, 'scheduled');
  await env.stories.runScheduled(row.id, { isFinalAttempt: true });
  assert.equal((await env.repo.getStory(row.id))!.status, 'failed');
  assert.equal(env.fake.byMethod('sendMessage').at(-1)!.params.chat_id, OWNER);
});

test('error handling: media conversion failure is reported, not retried', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  (env.stories as unknown as { deps: { preparer: unknown } }).deps.preparer = {
    photo: async () => { throw new MediaPrepError('Rasmni 10 MB dan kichik qilib bo‘lmadi'); },
    video: async () => { throw new MediaPrepError('x'); },
  };
  const row = await env.stories.postNow(owner, draft());
  await env.stories.runScheduled(row.id, { isFinalAttempt: false });
  assert.equal((await env.repo.getStory(row.id))!.status, 'failed');
  assert.equal(env.fake.byMethod('postStory').length, 0);
});

test('stories: schedule enqueues delayed job; cancel removes it; stale job does nothing', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.schedule(owner, draft(), new Date(env.now().getTime() + 3_600_000));
  assert.equal(env.queue.jobs[0]!.delayMs, 3_600_000);
  await env.stories.cancel(owner, row.id);
  assert.equal(env.queue.jobs.length, 0);
  await env.stories.runScheduled(row.id, { isFinalAttempt: true });
  assert.equal(env.fake.byMethod('postStory').length, 0);
});

test('stories: schedule rejects times in the past', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  await assert.rejects(env.stories.schedule(owner, draft(), new Date(env.now().getTime() - 1000)), /30 soniya/);
});

test('stories: video passes duration/is_animation to postStory', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  (env.stories as unknown as { deps: { preparer: unknown } }).deps.preparer = {
    photo: async (d: Uint8Array) => ({ data: d }),
    video: async (d: Uint8Array) => ({ data: d, duration: 12, isAnimation: true }),
  };
  await env.stories.postNow(owner, draft({ media: { type: 'video', fileId: 'V', duration: 12 } }));
  await env.drain();
  assert.deepEqual(env.fake.byMethod('postStory')[0]!.params.content, { type: 'video', video: 'attach://story_media', duration: 12, is_animation: true });
});

test('stories: caption edit and delete of a posted story', async () => {
  const env = setup();
  const owner = await connectBusiness(env);
  const row = await env.stories.postNow(owner, draft());
  await env.drain();
  await env.stories.requestCaptionEdit(owner, row.id, 'Yangi');
  await env.drain();
  assert.equal(env.fake.byMethod('editStory')[0]!.params.caption, 'Yangi');
  assert.equal((await env.repo.getStory(row.id))!.caption, 'Yangi');
  await env.stories.deletePosted(owner, row.id);
  assert.deepEqual(env.fake.byMethod('deleteStory')[0]!.params, { business_connection_id: 'bc_1', story_id: 77 });
  assert.equal((await env.repo.getStory(row.id))!.status, 'deleted');
});
