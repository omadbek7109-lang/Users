import { TelegramClient, type FetchFn } from '../src/services/telegram-client.js';
import { MemoryRepository } from '../src/database/memory-repository.js';
import { MemoryQueue } from '../src/services/queue.js';
import { MemoryStateStore } from '../src/services/state-store.js';
import { silentLogger } from '../src/services/logger.js';
import { AiRegistry, type AiProvider, type AiRequest } from '../src/services/ai/provider.js';
import { StoryService } from '../src/modules/stories/story.service.js';
import { TimedMediaService } from '../src/modules/timed-media/timed-media.service.js';
import { CleanerService } from '../src/modules/group-cleaner/cleaner.service.js';
import { EditorService } from '../src/modules/ai-editor/editor.service.js';
import { Router } from '../src/bot/router.js';

export const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
export const OWNER = 1001;
export const BOT_ID = 999;
export const STRANGER = 2002;

export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  files: Record<string, Blob>;
}

type Handler = (params: Record<string, unknown>) => unknown;

/** Mock of the Telegram Bot API HTTP endpoint. */
export class FakeTelegram {
  calls: RecordedCall[] = [];
  handlers: Record<string, Handler> = {};
  private msgId = 5000;

  constructor() {
    this.handlers = {
      getMe: () => ({ id: BOT_ID, is_bot: true, first_name: 'PTA', username: 'pta_test_bot' }),
      sendMessage: (p) => ({ message_id: ++this.msgId, date: 0, chat: { id: p.chat_id, type: 'private' }, text: p.text }),
      editMessageText: () => true,
      editMessageReplyMarkup: () => true,
      answerCallbackQuery: () => true,
      sendChatAction: () => true,
      setMyCommands: () => true,
      getFile: (p) => ({ file_id: p.file_id, file_unique_id: 'u', file_size: 1000, file_path: 'photos/file_1.jpg' }),
      postStory: () => ({ id: 77, chat: { id: OWNER, type: 'private' } }),
      editStory: () => ({ id: 77, chat: { id: OWNER, type: 'private' } }),
      deleteStory: () => true,
      getBusinessConnection: (p) => ({
        id: p.business_connection_id, user: { id: OWNER, is_bot: false, first_name: 'Owner' }, user_chat_id: OWNER, date: 1,
        is_enabled: true, rights: { can_manage_stories: true, can_reply: true, can_delete_outgoing_messages: true },
      }),
      getChatMember: () => ({ status: 'administrator', user: { id: BOT_ID, is_bot: true, first_name: 'PTA' }, can_delete_messages: true }),
      deleteMessages: () => true,
      deleteMessage: () => true,
      deleteBusinessMessages: () => true,
      leaveChat: () => true,
      sendPhoto: (p) => ({ message_id: ++this.msgId, date: 0, chat: { id: p.chat_id, type: 'private' } }),
      sendVideo: (p) => ({ message_id: ++this.msgId, date: 0, chat: { id: p.chat_id, type: 'private' } }),
    };
  }

  fail(method: string, code: number, description: string, extra: Record<string, unknown> = {}) {
    this.handlers[method] = () => ({ __error: { error_code: code, description, ...extra } });
  }

  byMethod(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  fetch: FetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3, 4]));
    const method = url.split('/').pop()!;
    const params: Record<string, unknown> = {};
    const files: Record<string, Blob> = {};
    if (init?.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (typeof v === 'string') {
          try { params[k] = JSON.parse(v); } catch { params[k] = v; }
        } else files[k] = v;
      }
    } else if (typeof init?.body === 'string') Object.assign(params, JSON.parse(init.body));
    this.calls.push({ method, params, files });
    const h = this.handlers[method];
    if (!h) return Response.json({ ok: false, error_code: 404, description: `Not Found: method ${method}` });
    const result = h(params) as { __error?: Record<string, unknown> };
    if (result && typeof result === 'object' && '__error' in result && result.__error) {
      const { error_code, description, ...parameters } = result.__error;
      return Response.json({ ok: false, error_code, description, parameters: Object.keys(parameters).length ? parameters : undefined });
    }
    return Response.json({ ok: true, result });
  }) as FetchFn;
}

export class FakeAi implements AiProvider {
  requests: AiRequest[] = [];
  fail = false;
  constructor(readonly name: 'claude' | 'openai' = 'claude', private readonly reply = (r: AiRequest) => `EDITED(${r.user.length})`) {}
  async complete(req: AiRequest) {
    this.requests.push(req);
    if (this.fail) throw new Error('provider down');
    return this.reply(req);
  }
}

export function setup(opts: { now?: Date } = {}) {
  const fake = new FakeTelegram();
  const tg = new TelegramClient(TOKEN, { fetchFn: fake.fetch, sleep: async () => {} });
  const queue = new MemoryQueue();
  const state = new MemoryStateStore();
  const claude = new FakeAi('claude');
  const openai = new FakeAi('openai', () => 'OPENAI RESULT');
  const ai = new AiRegistry([claude, openai], 'claude');
  let current = opts.now ?? new Date('2026-11-13T10:00:00Z');
  const now = () => current;
  const advance = (ms: number) => { current = new Date(current.getTime() + ms); };
  const repo = new MemoryRepository(now);
  const logger = silentLogger;
  const stories = new StoryService({ repo, tg, queue, logger, ownerChatId: OWNER, now });
  const media = new TimedMediaService({ repo, tg, queue, logger, ownerChatId: OWNER, now });
  const cleaner = new CleanerService({ repo, tg, logger, ownerId: OWNER, now });
  const editor = new EditorService({ repo, ai, logger });
  const router = new Router({ ownerId: OWNER, timezone: 'Asia/Tashkent', repo, tg, state, ai, stories, media, cleaner, editor, logger, now });
  return { fake, tg, repo, queue, state, ai, claude, openai, stories, media, cleaner, editor, router, now, advance };
}

export type Env = ReturnType<typeof setup>;

export async function ownerUser(env: Env) {
  return env.repo.ensureUser(OWNER);
}

export async function connectBusiness(env: Env, rights: Record<string, boolean> = { can_manage_stories: true, can_reply: true, can_delete_outgoing_messages: true }) {
  const owner = await ownerUser(env);
  await env.repo.upsertBusinessConnection({
    id: 'bc_1', user_id: owner.id, user_chat_id: OWNER, rights, is_enabled: true, connected_at: '2026-11-01T00:00:00Z',
  });
  env.fake.handlers.getBusinessConnection = (p) => ({
    id: p.business_connection_id, user: { id: OWNER, is_bot: false, first_name: 'Owner' }, user_chat_id: OWNER, date: 1, is_enabled: true, rights,
  });
  return owner;
}

let updateId = 1;
export function privateMsg(from: number, extra: Record<string, unknown>) {
  return {
    update_id: updateId++,
    message: { message_id: updateId, date: 1_700_000_000, chat: { id: from, type: 'private' as const }, from: { id: from, is_bot: false, first_name: 'U' }, ...extra },
  };
}
export function groupMsg(chatId: number, from: number, extra: Record<string, unknown>, messageId = updateId, date = 1_700_000_000) {
  return {
    update_id: updateId++,
    message: { message_id: messageId, date, chat: { id: chatId, type: 'supergroup' as const, title: 'Test group' }, from: { id: from, is_bot: false, first_name: 'U' }, ...extra },
  };
}
export function callback(from: number, data: string, chatId = from, messageId = 1) {
  return {
    update_id: updateId++,
    callback_query: { id: `cb${updateId}`, from: { id: from, is_bot: false, first_name: 'U' }, data, message: { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' as const } } },
  };
}
