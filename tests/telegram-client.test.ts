import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramApiError, TelegramClient, explainTelegramError } from '../src/services/telegram-client.js';
import { FakeTelegram, TOKEN } from './helpers.js';

function client(fake = new FakeTelegram()) {
  const sleeps: number[] = [];
  const tg = new TelegramClient(TOKEN, { fetchFn: fake.fetch, sleep: async (ms) => void sleeps.push(ms) });
  return { tg, fake, sleeps };
}

test('client: JSON call hits official method and returns result', async () => {
  const { tg, fake } = client();
  const me = await tg.getMe();
  assert.equal(me.username, 'pta_test_bot');
  assert.equal(fake.calls[0]!.method, 'getMe');
});

test('client: errors become TelegramApiError without the token', async () => {
  const { tg, fake } = client();
  fake.fail('sendMessage', 403, `Forbidden: bot was blocked by the user ${TOKEN}`);
  await assert.rejects(tg.sendMessage(1, 'x'), (e: unknown) => {
    assert.ok(e instanceof TelegramApiError);
    assert.equal(e.errorCode, 403);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
});

test('client: 429 is retried once after retry_after', async () => {
  const { tg, fake, sleeps } = client();
  let n = 0;
  fake.handlers.sendMessage = () => (++n === 1 ? { __error: { error_code: 429, description: 'Too Many Requests', retry_after: 3 } } : { message_id: 1 });
  await tg.sendMessage(1, 'hi');
  assert.equal(n, 2);
  assert.deepEqual(sleeps, [3000]);
});

test('client: postStory uploads media as multipart attach:// with official params', async () => {
  const { tg, fake } = client();
  const story = await tg.postStory('bc_1', { type: 'video', data: new Uint8Array([9, 9]), duration: 12 }, {
    activePeriod: 43200, caption: 'Salom', postToChatPage: true, protectContent: true,
  });
  assert.equal(story.id, 77);
  const call = fake.byMethod('postStory')[0]!;
  assert.deepEqual(call.params.content, { type: 'video', video: 'attach://story_media', duration: 12 });
  assert.equal(call.params.active_period, 43200);
  assert.equal(call.params.business_connection_id, 'bc_1');
  assert.equal(call.params.post_to_chat_page, true);
  assert.equal(call.params.protect_content, true);
  assert.ok(call.files.story_media instanceof Blob);
});

test('client: deleteMessages enforces the 1–100 limit', async () => {
  const { tg } = client();
  assert.throws(() => tg.deleteMessages(1, []), RangeError);
  assert.throws(() => tg.deleteMessages(1, Array.from({ length: 101 }, (_, i) => i)), RangeError);
});

test('client: downloadFile refuses files above the 20 MB getFile limit', async () => {
  const { tg, fake } = client();
  fake.handlers.getFile = () => ({ file_id: 'f', file_unique_id: 'u', file_size: 25 * 1024 * 1024, file_path: 'x' });
  await assert.rejects(tg.downloadFile('f'), /too big/);
});

test('explainTelegramError gives a reason plus the original description', () => {
  const t = explainTelegramError(new TelegramApiError('deleteMessage', 400, "Bad Request: message can't be deleted"));
  assert.match(t, /48 soat/);
  assert.match(t, /message can't be deleted/);
  assert.match(explainTelegramError(new TelegramApiError('postStory', 400, 'Bad Request: not enough rights')), /huquq/);
});
