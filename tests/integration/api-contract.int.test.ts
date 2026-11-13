/**
 * Compares every request this project sends with the official Bot API definitions shipped in
 * @grammyjs/types (generated from https://core.telegram.org/bots/api). For each method:
 * every parameter we send must exist, and every required parameter must be present.
 * Also checks the update/type fields the router reads. Requires node_modules (CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramClient } from '../../src/services/telegram-client.js';
import { FakeTelegram, TOKEN } from '../helpers.js';
import { ALLOWED_UPDATES } from '../../src/bot/router.js';
import { aiResultKeyboard, confirmKeyboard, mediaDraftKeyboard, storyDraftKeyboard } from '../../src/bot/keyboards/index.js';

const dir = join('node_modules', '@grammyjs', 'types');
const skip = existsSync(dir) ? false : '@grammyjs/types not installed';

function source(): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.d.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Returns the `{ ... }` body starting at the brace after `from`. */
function block(src: string, from: number): string {
  const start = src.indexOf('{', from);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i);
  }
  throw new Error('unbalanced');
}

function fields(body: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  let depth = 0;
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const m = line.match(/^\s*([a-z_]+)(\?)?\s*:/);
      if (m) out.set(m[1]!, !m[2]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(') depth++;
      if (ch === '}' || ch === ')') depth--;
    }
  }
  return out;
}

function methodParams(src: string, method: string): Map<string, boolean> | null {
  const noArgs = new RegExp(`\\b${method}\\(\\)\\s*:`).test(src);
  const m = new RegExp(`\\b${method}\\(args: `).exec(src);
  if (!m) return noArgs ? new Map() : null;
  return fields(block(src, m.index));
}

function iface(src: string, name: string): Map<string, boolean> {
  const m = new RegExp(`export interface ${name}(<[^>]*>)? (extends [^{]+)?\\{`).exec(src);
  assert.ok(m, `interface ${name} not found`);
  return fields(block(src, m.index));
}

async function exerciseClient() {
  const fake = new FakeTelegram();
  const tg = new TelegramClient(TOKEN, { fetchFn: fake.fetch, sleep: async () => {} });
  const data = new Uint8Array([1]);
  await tg.getMe();
  await tg.sendMessage(1, 't', { reply_markup: confirmKeyboard('a', 'b'), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, business_connection_id: 'b', protect_content: true });
  await tg.editMessageText(1, 2, 't', { reply_markup: confirmKeyboard('a', 'b'), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  await tg.answerCallbackQuery('q', 't', true);
  await tg.getChatMember(1, 2);
  await tg.leaveChat(1);
  await tg.deleteMessage(1, 2);
  await tg.deleteMessages(1, [2, 3]);
  await tg.sendMedia('photo', 1, 'f', { caption: 'c', has_spoiler: true, protect_content: true, business_connection_id: 'b' });
  await tg.sendMedia('video', 1, 'f', { caption: 'c', has_spoiler: true, protect_content: true });
  await tg.getFile('f');
  await tg.getBusinessConnection('b');
  await tg.deleteBusinessMessages('b', [1]);
  await tg.postStory('b', { type: 'photo', data }, { activePeriod: 86400, caption: 'c', postToChatPage: true, protectContent: true });
  await tg.postStory('b', { type: 'video', data, duration: 5, isAnimation: true }, { activePeriod: 21600 });
  await tg.editStory('b', 1, { type: 'photo', data }, 'c');
  await tg.deleteStory('b', 1);
  // raw calls made elsewhere in the code
  await tg.call('editMessageReplyMarkup', { chat_id: 1, message_id: 2, reply_markup: confirmKeyboard('a', 'b') }).catch(() => undefined);
  await tg.call('sendChatAction', { chat_id: 1, action: 'typing' }).catch(() => undefined);
  await tg.call('setMyCommands', { commands: [{ command: 'start', description: 'x' }], scope: { type: 'chat', chat_id: 1 } }).catch(() => undefined);
  return fake.calls;
}

test('contract: every method and parameter we send exists in the official API', { skip }, async () => {
  const src = source();
  const calls = await exerciseClient();
  const report: string[] = [];
  for (const call of calls) {
    const params = methodParams(src, call.method);
    assert.ok(params, `unknown method ${call.method}`);
    const sent = new Set([...Object.keys(call.params), ...Object.keys(call.files)].filter((k) => k !== 'story_media'));
    for (const k of sent) assert.ok(params.has(k), `${call.method}: unknown parameter "${k}"`);
    for (const [k, required] of params) if (required) assert.ok(sent.has(k), `${call.method}: missing required "${k}"`);
    report.push(`${call.method}(${[...sent].join(', ')})`);
  }
  console.log(`verified ${calls.length} requests:\n  ${[...new Set(report)].join('\n  ')}`);
});

test('contract: story content objects match InputStoryContentPhoto / InputStoryContentVideo', { skip }, async () => {
  const src = source();
  const calls = (await exerciseClient()).filter((c) => c.method === 'postStory' || c.method === 'editStory');
  const photo = iface(src, 'InputStoryContentPhoto');
  const video = iface(src, 'InputStoryContentVideo');
  for (const c of calls) {
    const content = c.params.content as Record<string, unknown>;
    const spec = content.type === 'photo' ? photo : video;
    for (const k of Object.keys(content)) assert.ok(spec.has(k), `content.${k} not in spec`);
    const media = content[content.type as string];
    assert.equal(typeof media, 'string');
    assert.ok(String(media).startsWith('attach://'), 'story media must be uploaded as a new file');
    assert.ok(c.files[String(media).slice('attach://'.length)], 'attached file part present');
  }
});

test('contract: inline buttons use official fields (callback_data / copy_text ≤ 256)', { skip }, () => {
  const src = source();
  const copy = iface(src, 'CopyTextButton');
  assert.ok(copy.has('text'));
  const kbs = [
    aiResultKeyboard('00000000-0000-0000-0000-000000000000', 'short'),
    aiResultKeyboard('00000000-0000-0000-0000-000000000000', 'x'.repeat(300)),
    storyDraftKeyboard({ media: { type: 'photo', fileId: 'f' }, caption: '', activePeriod: 86400, postToChatPage: false, protectContent: false }),
    mediaDraftKeyboard({ media: { type: 'photo', fileId: 'f' }, caption: '', deleteAfter: null, hasSpoiler: false, protectContent: false }),
  ];
  for (const b of kbs.flatMap((k) => k.inline_keyboard.flat())) {
    const keys = Object.keys(b).filter((k) => k !== 'text');
    assert.equal(keys.length, 1, JSON.stringify(b));
    assert.ok(['callback_data', 'copy_text', 'url'].includes(keys[0]!));
    if ('callback_data' in b) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    if ('copy_text' in b) assert.ok(b.copy_text.text.length >= 1 && b.copy_text.text.length <= 256);
  }
});

test('contract: update and object fields read by the router exist', { skip }, () => {
  const src = source();
  const update = iface(src, 'Update');
  for (const u of ALLOWED_UPDATES) assert.ok(update.has(u), `Update.${u}`);
  const bc = iface(src, 'BusinessConnection');
  for (const f of ['id', 'user', 'user_chat_id', 'date', 'rights', 'is_enabled']) assert.ok(bc.has(f), `BusinessConnection.${f}`);
  const rights = iface(src, 'BusinessBotRights');
  for (const f of ['can_reply', 'can_manage_stories', 'can_delete_outgoing_messages', 'can_delete_all_messages']) assert.ok(rights.has(f), `BusinessBotRights.${f}`);
  assert.ok(!rights.has('can_delete_sent_messages'), 'deprecated right is gone — we must not rely on it');
  const admin = iface(src, 'ChatMemberAdministrator');
  assert.ok(admin.has('can_delete_messages'));
  const story = iface(src, 'Story');
  assert.ok(story.has('id') && story.has('chat'));
  assert.match(src, /migrate_to_chat_id\??:/);
  assert.match(src, /business_connection_id\??:/);
  assert.match(src, /new_chat_member:/);
});
