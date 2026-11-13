import type {
  ReplyMarkup,
  TgBusinessConnection,
  TgChatMember,
  TgFile,
  TgMessage,
  TgStory,
  TgUser,
} from '../types/telegram.js';
import { redactString } from '../utils/redact.js';

export type FetchFn = typeof fetch;

/** Bot API cloud server allows downloading files up to 20 MB via getFile. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly errorCode: number,
    public readonly description: string,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram ${method}: ${errorCode} ${redactString(description)}`);
    this.name = 'TelegramApiError';
  }
}

export interface UploadFile {
  field: string;
  filename: string;
  data: Uint8Array;
  mime?: string;
}

export interface SendOptions {
  reply_markup?: ReplyMarkup;
  parse_mode?: 'HTML' | 'MarkdownV2';
  business_connection_id?: string;
  protect_content?: boolean;
  link_preview_options?: { is_disabled: boolean };
}

export type StoryContent =
  | { type: 'photo'; data: Uint8Array }
  | { type: 'video'; data: Uint8Array; duration?: number };

export interface StoryOptions {
  activePeriod: number;
  caption?: string;
  postToChatPage?: boolean;
  protectContent?: boolean;
}

export interface TelegramClientOptions {
  fetchFn?: FetchFn;
  apiBase?: string;
  maxRetryAfterSec?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Thin, dependency-free Bot API client. Every call goes to an official method name.
 * Handles 429 (retry_after) once and never leaks the token into errors.
 */
export class TelegramClient {
  private readonly fetchFn: FetchFn;
  private readonly apiBase: string;
  private readonly maxRetryAfterSec: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly token: string, opts: TelegramClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.apiBase = opts.apiBase ?? 'https://api.telegram.org';
    this.maxRetryAfterSec = opts.maxRetryAfterSec ?? 30;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, files: UploadFile[] = []): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.apiBase}/bot${this.token}/${method}`, this.buildRequest(params, files));
      } catch (err) {
        if (attempt === 0) {
          await this.sleep(1000);
          continue;
        }
        throw new TelegramApiError(method, 0, `network error: ${(err as Error).message}`);
      }
      let body: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new TelegramApiError(method, res.status, 'invalid JSON response');
      }
      if (body.ok) return body.result as T;
      const retryAfter = body.parameters?.retry_after;
      if (body.error_code === 429 && retryAfter !== undefined && retryAfter <= this.maxRetryAfterSec && attempt === 0) {
        await this.sleep(retryAfter * 1000);
        continue;
      }
      throw new TelegramApiError(method, body.error_code ?? res.status, body.description ?? 'unknown error', retryAfter);
    }
  }

  private buildRequest(params: Record<string, unknown>, files: UploadFile[]): RequestInit {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    if (files.length === 0) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(entries)),
      };
    }
    const form = new FormData();
    for (const [k, v] of entries) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    for (const f of files) {
      form.append(f.field, new Blob([f.data as BlobPart], { type: f.mime ?? 'application/octet-stream' }), f.filename);
    }
    return { method: 'POST', body: form };
  }

  // ---------- generic ----------
  getMe() {
    return this.call<TgUser>('getMe');
  }

  sendMessage(chatId: number, text: string, opts: SendOptions = {}) {
    return this.call<TgMessage>('sendMessage', { chat_id: chatId, text, ...opts });
  }

  editMessageText(chatId: number, messageId: number, text: string, opts: Omit<SendOptions, 'business_connection_id'> = {}) {
    return this.call<TgMessage | true>('editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts });
  }

  answerCallbackQuery(id: string, text?: string, showAlert = false) {
    return this.call<true>('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });
  }

  getChatMember(chatId: number, userId: number) {
    return this.call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: userId });
  }

  leaveChat(chatId: number) {
    return this.call<true>('leaveChat', { chat_id: chatId });
  }

  deleteMessage(chatId: number, messageId: number) {
    return this.call<true>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  /** 1–100 ids per call (official limit). */
  deleteMessages(chatId: number, messageIds: number[]) {
    if (messageIds.length < 1 || messageIds.length > 100) throw new RangeError('deleteMessages: 1–100 ta id');
    return this.call<true>('deleteMessages', { chat_id: chatId, message_ids: messageIds });
  }

  sendMedia(kind: 'photo' | 'video', chatId: number, fileId: string, opts: SendOptions & { caption?: string; has_spoiler?: boolean } = {}) {
    const method = kind === 'photo' ? 'sendPhoto' : 'sendVideo';
    return this.call<TgMessage>(method, { chat_id: chatId, [kind]: fileId, ...opts });
  }

  // ---------- files ----------
  getFile(fileId: string) {
    return this.call<TgFile>('getFile', { file_id: fileId });
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const file = await this.getFile(fileId);
    if (file.file_size && file.file_size > MAX_DOWNLOAD_BYTES) {
      throw new TelegramApiError('getFile', 400, 'file is too big (Bot API getFile limit 20 MB)');
    }
    if (!file.file_path) throw new TelegramApiError('getFile', 400, 'file_path missing');
    const res = await this.fetchFn(`${this.apiBase}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new TelegramApiError('downloadFile', res.status, 'download failed');
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---------- business ----------
  getBusinessConnection(id: string) {
    return this.call<TgBusinessConnection>('getBusinessConnection', { business_connection_id: id });
  }

  deleteBusinessMessages(businessConnectionId: string, messageIds: number[]) {
    if (messageIds.length < 1 || messageIds.length > 100) throw new RangeError('deleteBusinessMessages: 1–100 ta id');
    return this.call<true>('deleteBusinessMessages', { business_connection_id: businessConnectionId, message_ids: messageIds });
  }

  // ---------- stories (Bot API 9.0+) ----------
  private storyContent(content: StoryContent): { json: Record<string, unknown>; file: UploadFile } {
    // Story media cannot be reused by file_id — it must be uploaded as a new file (attach://).
    if (content.type === 'photo') {
      return {
        json: { type: 'photo', photo: 'attach://story_media' },
        file: { field: 'story_media', filename: 'story.jpg', data: content.data, mime: 'image/jpeg' },
      };
    }
    return {
      json: { type: 'video', video: 'attach://story_media', ...(content.duration ? { duration: content.duration } : {}) },
      file: { field: 'story_media', filename: 'story.mp4', data: content.data, mime: 'video/mp4' },
    };
  }

  postStory(businessConnectionId: string, content: StoryContent, opts: StoryOptions) {
    const c = this.storyContent(content);
    return this.call<TgStory>(
      'postStory',
      {
        business_connection_id: businessConnectionId,
        content: c.json,
        active_period: opts.activePeriod,
        caption: opts.caption,
        post_to_chat_page: opts.postToChatPage,
        protect_content: opts.protectContent,
      },
      [c.file],
    );
  }

  editStory(businessConnectionId: string, storyId: number, content: StoryContent, caption?: string) {
    const c = this.storyContent(content);
    return this.call<TgStory>(
      'editStory',
      { business_connection_id: businessConnectionId, story_id: storyId, content: c.json, caption },
      [c.file],
    );
  }

  deleteStory(businessConnectionId: string, storyId: number) {
    return this.call<true>('deleteStory', { business_connection_id: businessConnectionId, story_id: storyId });
  }
}

/** Converts Telegram errors into a human explanation (Uzbek) + the original description. */
export function explainTelegramError(err: unknown): string {
  if (!(err instanceof TelegramApiError)) {
    return `Kutilmagan xato: ${redactString(err instanceof Error ? err.message : String(err))}`;
  }
  const d = err.description.toLowerCase();
  let hint = 'Telegram so‘rovni rad etdi.';
  if (err.errorCode === 429) hint = `Telegram limiti: ${err.retryAfter ?? '?'} soniyadan keyin qayta urinib ko‘ring.`;
  else if (d.includes('too big')) hint = 'Fayl juda katta (bot 20 MB gacha yuklab ola oladi).';
  else if (d.includes('premium')) hint = 'Bu amal uchun Telegram Premium kerak.';
  else if (d.includes('right') || d.includes('not enough') || d.includes('forbidden') || err.errorCode === 403)
    hint = 'Botda yetarli huquq yo‘q (admin yoki Business huquqlarini tekshiring).';
  else if (d.includes("can't be deleted") || d.includes('message to delete not found'))
    hint = 'Xabarni o‘chirib bo‘lmaydi (48 soatdan eski, allaqachon o‘chirilgan yoki huquq yo‘q).';
  else if (d.includes('business') && d.includes('connection')) hint = 'Business ulanishi topilmadi yoki o‘chirilgan.';
  else if (d.includes('chat not found')) hint = 'Chat topilmadi.';
  else if (d.includes('wrong file') || d.includes('file')) hint = 'Media fayl bilan muammo (format/o‘lcham).';
  return `${hint}\nTelegram javobi: ${err.errorCode} — ${redactString(err.description)}`;
}
