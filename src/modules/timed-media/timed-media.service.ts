import type { Repository } from '../../database/repository.js';
import type { MediaTaskRow, UserRow } from '../../database/types.js';
import { jobIds, type JobQueue } from '../../services/queue.js';
import type { Logger } from '../../services/logger.js';
import { TelegramApiError, explainTelegramError, type TelegramClient } from '../../services/telegram-client.js';
import type { MediaDraft } from '../../services/state-store.js';

/** Auto-delete presets in seconds (null = don't delete). Max 24h keeps us inside the 48h deletion window. */
export const DELETE_PRESETS: Array<number | null> = [null, 10, 60, 3600, 86400];
export const MEDIA_CAPTION_MAX = 1024;
const MAX_SCHEDULE_AHEAD_MS = 30 * 86_400_000;
const BUSINESS_REPLY_WINDOW_MS = 24 * 3_600_000;

export interface MediaTarget {
  chatId: number;
  title: string;
  kind: 'self' | 'group' | 'business';
  businessConnectionId?: string;
}

export class TimedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimedMediaError';
  }
}

export class TimedMediaService {
  constructor(
    private readonly deps: {
      repo: Repository;
      tg: TelegramClient;
      queue: JobQueue;
      logger: Logger;
      ownerChatId: number;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Where the bot is actually able to send:
   *  - the owner's private chat with the bot;
   *  - groups the owner added the bot to;
   *  - business chats that had an incoming message in the last 24h (official can_reply rule).
   */
  async listTargets(user: UserRow): Promise<MediaTarget[]> {
    const { repo } = this.deps;
    const targets: MediaTarget[] = [{ chatId: this.deps.ownerChatId, title: '🤖 Bot bilan shaxsiy chat', kind: 'self' }];
    for (const g of await repo.listGroups(user.id)) {
      targets.push({ chatId: g.chat_id, title: `👥 ${g.title ?? g.chat_id}`, kind: 'group' });
    }
    const conn = await repo.getActiveBusinessConnection(user.id);
    if (conn?.rights?.can_reply) {
      const since = new Date(this.now().getTime() - BUSINESS_REPLY_WINDOW_MS);
      for (const c of await repo.listRecentBusinessChats(conn.id, since, 10)) {
        targets.push({ chatId: c.chat_id, title: `💼 ${c.title ?? c.chat_id}`, kind: 'business', businessConnectionId: conn.id });
      }
    }
    return targets;
  }

  validate(d: MediaDraft): string[] {
    const e: string[] = [];
    if (d.targetChatId === undefined) e.push('Qabul qiluvchi chat tanlanmagan');
    if (!DELETE_PRESETS.includes(d.deleteAfter)) e.push('Auto-delete muddati noto‘g‘ri');
    if (d.caption.length > MEDIA_CAPTION_MAX) e.push(`Caption ${MEDIA_CAPTION_MAX} belgidan oshmasin`);
    return e;
  }

  async create(user: UserRow, d: MediaDraft, sendAt: Date | null): Promise<MediaTaskRow> {
    const errors = this.validate(d);
    if (errors.length) throw new TimedMediaError(errors.join('\n'));
    const at = sendAt ?? this.now();
    const delay = at.getTime() - this.now().getTime();
    if (sendAt && delay < 10_000) throw new TimedMediaError('Vaqt kamida 10 soniyadan keyin bo‘lishi kerak');
    if (delay > MAX_SCHEDULE_AHEAD_MS) throw new TimedMediaError('Ko‘pi bilan 30 kun oldinga rejalashtirish mumkin');

    const row = await this.deps.repo.createMediaTask({
      user_id: user.id,
      target_chat_id: d.targetChatId!,
      target_title: d.targetTitle ?? null,
      business_connection_id: d.businessConnectionId ?? null,
      media_type: d.media.type,
      file_id: d.media.fileId,
      caption: d.caption || null,
      has_spoiler: d.hasSpoiler,
      protect_content: d.protectContent,
      send_at: at.toISOString(),
      delete_after_seconds: d.deleteAfter,
    });
    await this.deps.queue.enqueue('media.send', { id: row.id }, { jobId: jobIds.mediaSend(row.id), delayMs: Math.max(0, delay) });
    await this.deps.repo.log({
      user_id: user.id, module: 'timed-media', action: 'create', status: 'ok',
      details: { task: row.id, send_at: row.send_at, delete_after: d.deleteAfter },
    });
    return row;
  }

  async processSend(id: string, ctx: { isFinalAttempt: boolean }): Promise<MediaTaskRow | null> {
    const { repo, tg, queue } = this.deps;
    const row = await repo.getMediaTask(id);
    if (!row || row.status !== 'scheduled') return row;
    try {
      const msg = await tg.sendMedia(row.media_type, row.target_chat_id, row.file_id, {
        caption: row.caption ?? undefined,
        has_spoiler: row.has_spoiler || undefined,
        protect_content: row.protect_content || undefined,
        business_connection_id: row.business_connection_id ?? undefined,
      });
      const sentAt = this.now();
      const deleteAt = row.delete_after_seconds ? new Date(sentAt.getTime() + row.delete_after_seconds * 1000) : null;
      const updated = await repo.updateMediaTask(row.id, {
        status: 'sent',
        sent_message_id: msg.message_id,
        sent_at: sentAt.toISOString(),
        delete_at: deleteAt?.toISOString() ?? null,
        attempts: row.attempts + 1,
        error: null,
      });
      if (row.delete_after_seconds) {
        await queue.enqueue('media.delete', { id: row.id }, { jobId: jobIds.mediaDelete(row.id), delayMs: row.delete_after_seconds * 1000 });
      }
      await repo.log({ user_id: row.user_id, module: 'timed-media', action: 'send', status: 'ok', details: { task: row.id } });
      if (row.target_chat_id !== this.deps.ownerChatId) {
        const note = row.delete_after_seconds ? ` Auto-delete: ${deleteAt!.toISOString().slice(11, 16)} UTC.` : '';
        await tg.sendMessage(this.deps.ownerChatId, `✅ Media yuborildi → ${row.target_title ?? row.target_chat_id}.${note}`).catch(() => undefined);
      }
      return updated;
    } catch (err) {
      const explained = explainTelegramError(err);
      await repo.updateMediaTask(row.id, {
        attempts: row.attempts + 1,
        error: explained,
        ...(ctx.isFinalAttempt ? { status: 'failed' as const } : {}),
      });
      await repo.log({ user_id: row.user_id, module: 'timed-media', action: 'send', status: 'error', details: { task: row.id, error: explained } });
      if (ctx.isFinalAttempt) {
        await tg.sendMessage(this.deps.ownerChatId, `❌ Media yuborilmadi.\n${explained}`).catch(() => undefined);
        return repo.getMediaTask(row.id);
      }
      throw err;
    }
  }

  async processDelete(id: string, ctx: { isFinalAttempt: boolean }): Promise<MediaTaskRow | null> {
    const { repo, tg } = this.deps;
    const row = await repo.getMediaTask(id);
    if (!row || row.status !== 'sent' || !row.sent_message_id || !row.delete_at) return row;
    try {
      if (row.business_connection_id) {
        await tg.deleteBusinessMessages(row.business_connection_id, [row.sent_message_id]);
      } else {
        await tg.deleteMessage(row.target_chat_id, row.sent_message_id);
      }
    } catch (err) {
      const alreadyGone = err instanceof TelegramApiError && /message to delete not found/i.test(err.description);
      if (!alreadyGone) {
        const explained = explainTelegramError(err);
        await repo.updateMediaTask(row.id, { error: explained });
        await repo.log({ user_id: row.user_id, module: 'timed-media', action: 'auto-delete', status: 'error', details: { task: row.id, error: explained } });
        if (!ctx.isFinalAttempt) throw err;
        await tg.sendMessage(this.deps.ownerChatId, `⚠️ Media avtomatik o‘chirilmadi.\n${explained}`).catch(() => undefined);
        return repo.getMediaTask(row.id);
      }
    }
    const updated = await repo.updateMediaTask(row.id, { status: 'deleted', deleted_at: this.now().toISOString() });
    await repo.log({ user_id: row.user_id, module: 'timed-media', action: 'auto-delete', status: 'ok', details: { task: row.id } });
    return updated;
  }

  /** Cancels a scheduled send, or — if already sent — cancels the pending auto-delete. */
  async cancel(user: UserRow, id: string): Promise<{ row: MediaTaskRow; what: 'send' | 'auto-delete' }> {
    const { repo, queue } = this.deps;
    const row = await repo.getMediaTask(id);
    if (!row || row.user_id !== user.id) throw new TimedMediaError('Vazifa topilmadi');
    if (row.status === 'scheduled') {
      await queue.remove(jobIds.mediaSend(row.id));
      const r = await repo.updateMediaTask(row.id, { status: 'cancelled' });
      await repo.log({ user_id: user.id, module: 'timed-media', action: 'cancel', status: 'ok', details: { task: row.id } });
      return { row: r, what: 'send' };
    }
    if (row.status === 'sent' && row.delete_at) {
      await queue.remove(jobIds.mediaDelete(row.id));
      const r = await repo.updateMediaTask(row.id, { delete_at: null });
      await repo.log({ user_id: user.id, module: 'timed-media', action: 'cancel-auto-delete', status: 'ok', details: { task: row.id } });
      return { row: r, what: 'auto-delete' };
    }
    throw new TimedMediaError('Bu vazifani bekor qilib bo‘lmaydi');
  }
}
