import type { Repository } from '../../database/repository.js';
import type { BusinessConnectionRow, StoryRow, UserRow } from '../../database/types.js';
import type { JobQueue } from '../../services/queue.js';
import { jobIds } from '../../services/queue.js';
import type { Logger } from '../../services/logger.js';
import { TelegramApiError, type TelegramClient, explainTelegramError } from '../../services/telegram-client.js';
import type { StoryDraft } from '../../services/state-store.js';

/** Official allowed values of postStory.active_period (seconds). */
export const STORY_PERIODS = [21600, 43200, 86400, 172800] as const;
export const STORY_CAPTION_MAX = 2048;
const MAX_SCHEDULE_AHEAD_MS = 30 * 86_400_000;

export type ConnectionProblem = 'not_connected' | 'disabled' | 'no_rights';

export interface ConnectionStatus {
  connection: BusinessConnectionRow | null;
  problem?: ConnectionProblem;
}

export class StoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryError';
  }
}

export function validateStoryDraft(d: StoryDraft): string[] {
  const errors: string[] = [];
  if (!(STORY_PERIODS as readonly number[]).includes(d.activePeriod)) errors.push('Davomiylik faqat 6, 12, 24 yoki 48 soat bo‘lishi mumkin');
  if (d.caption.length > STORY_CAPTION_MAX) errors.push(`Caption ${STORY_CAPTION_MAX} belgidan oshmasin`);
  if (d.media.type !== 'photo' && d.media.type !== 'video') errors.push('Faqat rasm yoki video');
  return errors;
}

export function connectionProblemText(p: ConnectionProblem): string {
  switch (p) {
    case 'not_connected':
      return 'Telegram Business ulanmagan. Telegram → Settings → Telegram Business → Chatbots bo‘limida shu botni qo‘shing (Telegram Premium kerak).';
    case 'disabled':
      return 'Business ulanishi o‘chirilgan. Telegram Business → Chatbots bo‘limida botni qayta yoqing.';
    case 'no_rights':
      return 'Botda "Manage stories" (can_manage_stories) huquqi yo‘q. Telegram Business → Chatbots → bot huquqlarida uni yoqing.';
  }
}

export class StoryService {
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

  /** Reads the stored connection and refreshes rights from Telegram (getBusinessConnection). */
  async connectionStatus(user: UserRow): Promise<ConnectionStatus> {
    const { repo, tg, logger } = this.deps;
    let conn = await repo.getActiveBusinessConnection(user.id);
    if (!conn) return { connection: null, problem: 'not_connected' };
    try {
      const fresh = await tg.getBusinessConnection(conn.id);
      conn = { ...conn, rights: fresh.rights ?? {}, is_enabled: fresh.is_enabled, user_chat_id: fresh.user_chat_id };
      await repo.upsertBusinessConnection(conn);
    } catch (err) {
      logger.warn('getBusinessConnection failed', { err });
      if (err instanceof TelegramApiError && err.errorCode === 400) {
        conn = { ...conn, is_enabled: false };
        await repo.upsertBusinessConnection(conn);
      }
    }
    if (!conn.is_enabled) return { connection: conn, problem: 'disabled' };
    if (!conn.rights?.can_manage_stories) return { connection: conn, problem: 'no_rights' };
    return { connection: conn };
  }

  private async requireConnection(user: UserRow): Promise<BusinessConnectionRow> {
    const st = await this.connectionStatus(user);
    if (st.problem || !st.connection) throw new StoryError(connectionProblemText(st.problem ?? 'not_connected'));
    return st.connection;
  }

  private async createRow(user: UserRow, conn: BusinessConnectionRow, d: StoryDraft, at: Date): Promise<StoryRow> {
    const errors = validateStoryDraft(d);
    if (errors.length) throw new StoryError(errors.join('\n'));
    return this.deps.repo.createStory({
      user_id: user.id,
      business_connection_id: conn.id,
      media_type: d.media.type,
      file_id: d.media.fileId,
      video_duration: d.media.duration ?? null,
      caption: d.caption || null,
      active_period: d.activePeriod,
      post_to_chat_page: d.postToChatPage,
      protect_content: d.protectContent,
      scheduled_at: at.toISOString(),
      status: 'scheduled',
    });
  }

  async postNow(user: UserRow, draft: StoryDraft): Promise<StoryRow> {
    const conn = await this.requireConnection(user);
    const row = await this.createRow(user, conn, draft, this.now());
    const res = await this.publish(row.id, { isFinalAttempt: true });
    if (res.status !== 'posted') throw new StoryError(res.error ?? 'Story joylanmadi');
    return res;
  }

  async schedule(user: UserRow, draft: StoryDraft, at: Date): Promise<StoryRow> {
    const delay = at.getTime() - this.now().getTime();
    if (delay < 30_000) throw new StoryError('Vaqt kamida 30 soniyadan keyin bo‘lishi kerak');
    if (delay > MAX_SCHEDULE_AHEAD_MS) throw new StoryError('Ko‘pi bilan 30 kun oldinga rejalashtirish mumkin');
    const conn = await this.requireConnection(user);
    const row = await this.createRow(user, conn, draft, at);
    await this.deps.queue.enqueue('story.post', { id: row.id }, { jobId: jobIds.story(row.id), delayMs: delay });
    await this.deps.repo.log({ user_id: user.id, module: 'stories', action: 'schedule', status: 'ok', details: { story: row.id, at: row.scheduled_at } });
    return row;
  }

  /** Downloads the media and calls postStory. Used both for "post now" and by the scheduled job. */
  async publish(storyId: string, ctx: { isFinalAttempt: boolean }): Promise<StoryRow> {
    const { repo, tg, logger } = this.deps;
    const row = await repo.getStory(storyId);
    if (!row) throw new StoryError('Story topilmadi');
    if (row.status !== 'scheduled' && row.status !== 'posting') return row; // cancelled / already posted → idempotent skip

    await repo.updateStory(row.id, { status: 'posting', attempts: row.attempts + 1 });
    try {
      const data = await tg.downloadFile(row.file_id);
      const content = row.media_type === 'photo'
        ? { type: 'photo' as const, data }
        : { type: 'video' as const, data, duration: row.video_duration ?? undefined };
      const story = await tg.postStory(row.business_connection_id, content, {
        activePeriod: row.active_period,
        caption: row.caption ?? undefined,
        postToChatPage: row.post_to_chat_page,
        protectContent: row.protect_content,
      });
      const done = await repo.updateStory(row.id, {
        status: 'posted',
        story_id: story.id,
        story_chat_id: story.chat.id,
        posted_at: this.now().toISOString(),
        error: null,
      });
      await repo.log({ user_id: row.user_id, module: 'stories', action: 'post', status: 'ok', details: { story: row.id, story_id: story.id } });
      return done;
    } catch (err) {
      const explained = explainTelegramError(err);
      logger.warn('postStory failed', { story: row.id, err });
      const failed = await repo.updateStory(row.id, { status: ctx.isFinalAttempt ? 'failed' : 'scheduled', error: explained });
      await repo.log({ user_id: row.user_id, module: 'stories', action: 'post', status: 'error', details: { story: row.id, error: explained } });
      if (!ctx.isFinalAttempt) throw err; // let the queue retry
      return failed;
    }
  }

  /** Job entry point: publishes and notifies the owner about the outcome. */
  async runScheduled(storyId: string, ctx: { isFinalAttempt: boolean }): Promise<void> {
    const res = await this.publish(storyId, ctx);
    if (res.status === 'posted') {
      await this.deps.tg.sendMessage(this.deps.ownerChatId, `✅ Rejalashtirilgan story joylandi (ID: ${res.story_id}).`);
    } else if (res.status === 'failed') {
      await this.deps.tg.sendMessage(this.deps.ownerChatId, `❌ Rejalashtirilgan story joylanmadi.\n${res.error ?? ''}`);
    }
  }

  async cancel(user: UserRow, storyId: string): Promise<StoryRow> {
    const row = await this.ownRow(user, storyId);
    if (row.status !== 'scheduled') throw new StoryError('Faqat rejalashtirilgan storyni bekor qilish mumkin');
    await this.deps.queue.remove(jobIds.story(row.id));
    const res = await this.deps.repo.updateStory(row.id, { status: 'cancelled' });
    await this.deps.repo.log({ user_id: user.id, module: 'stories', action: 'cancel', status: 'ok', details: { story: row.id } });
    return res;
  }

  async deletePosted(user: UserRow, storyId: string): Promise<StoryRow> {
    const row = await this.ownRow(user, storyId);
    if (row.status !== 'posted' || !row.story_id) throw new StoryError('Bu story joylanmagan');
    try {
      await this.deps.tg.deleteStory(row.business_connection_id, row.story_id);
    } catch (err) {
      await this.deps.repo.log({ user_id: user.id, module: 'stories', action: 'delete', status: 'error', details: { story: row.id, error: explainTelegramError(err) } });
      throw new StoryError(explainTelegramError(err));
    }
    const res = await this.deps.repo.updateStory(row.id, { status: 'deleted' });
    await this.deps.repo.log({ user_id: user.id, module: 'stories', action: 'delete', status: 'ok', details: { story: row.id } });
    return res;
  }

  /** editStory requires content, so the original media is re-uploaded with the new caption. */
  async editCaption(user: UserRow, storyId: string, caption: string): Promise<StoryRow> {
    const row = await this.ownRow(user, storyId);
    if (row.status !== 'posted' || !row.story_id) throw new StoryError('Faqat joylangan storyni tahrirlash mumkin');
    if (caption.length > STORY_CAPTION_MAX) throw new StoryError(`Caption ${STORY_CAPTION_MAX} belgidan oshmasin`);
    try {
      const data = await this.deps.tg.downloadFile(row.file_id);
      const content = row.media_type === 'photo'
        ? { type: 'photo' as const, data }
        : { type: 'video' as const, data, duration: row.video_duration ?? undefined };
      await this.deps.tg.editStory(row.business_connection_id, row.story_id, content, caption);
    } catch (err) {
      throw new StoryError(explainTelegramError(err));
    }
    const res = await this.deps.repo.updateStory(row.id, { caption });
    await this.deps.repo.log({ user_id: user.id, module: 'stories', action: 'edit', status: 'ok', details: { story: row.id } });
    return res;
  }

  /** Bot API has no "get story" method, so status = our record + computed expiry. */
  describe(row: StoryRow, fmt: (d: string) => string): string {
    const statusText: Record<StoryRow['status'], string> = {
      scheduled: '📅 Rejalashtirilgan', posting: '⏳ Joylanmoqda', posted: '✅ Joylangan',
      failed: '❌ Xato', cancelled: '🚫 Bekor qilingan', deleted: '🗑 O‘chirilgan',
    };
    const lines = [`${statusText[row.status]} · ${row.media_type === 'photo' ? 'Rasm' : 'Video'} · ${row.active_period / 3600} soat`];
    if (row.status === 'scheduled') lines.push(`Vaqt: ${fmt(row.scheduled_at)}`);
    if (row.posted_at) {
      const exp = new Date(new Date(row.posted_at).getTime() + row.active_period * 1000).toISOString();
      lines.push(`Joylandi: ${fmt(row.posted_at)} · Arxivga o‘tadi: ${fmt(exp)}`);
    }
    if (row.error && row.status !== 'posted') lines.push(`Sabab: ${row.error}`);
    return lines.join('\n');
  }

  private async ownRow(user: UserRow, id: string): Promise<StoryRow> {
    const row = await this.deps.repo.getStory(id);
    if (!row || row.user_id !== user.id) throw new StoryError('Story topilmadi');
    return row;
  }
}
