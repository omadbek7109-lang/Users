import type { Repository } from '../../database/repository.js';
import type { BusinessConnectionRow, StoryRow, UserRow } from '../../database/types.js';
import type { JobQueue } from '../../services/queue.js';
import { jobIds } from '../../services/queue.js';
import type { Logger } from '../../services/logger.js';
import { TelegramApiError, type StoryContent, type TelegramClient, explainTelegramError } from '../../services/telegram-client.js';
import type { StoryDraft } from '../../services/state-store.js';
import { MediaPrepError, type StoryMediaPreparer } from './media-prep.js';

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
      preparer: StoryMediaPreparer;
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

  private async createAndEnqueue(user: UserRow, d: StoryDraft, at: Date, delayMs: number): Promise<StoryRow> {
    const errors = validateStoryDraft(d);
    if (errors.length) throw new StoryError(errors.join('\n'));
    const conn = await this.requireConnection(user);
    const row = await this.deps.repo.createStory({
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
    await this.deps.queue.enqueue('story.post', { id: row.id }, { jobId: jobIds.story(row.id), delayMs });
    await this.deps.repo.log({ user_id: user.id, module: 'stories', action: delayMs ? 'schedule' : 'queue-now', status: 'ok', details: { story: row.id, at: row.scheduled_at } });
    return row;
  }

  /**
   * "Post now" also goes through the queue: media conversion (H.265) can take minutes and must not
   * block the update loop; the job survives restarts and the owner is notified about the result.
   */
  async postNow(user: UserRow, draft: StoryDraft): Promise<StoryRow> {
    return this.createAndEnqueue(user, draft, this.now(), 0);
  }

  async schedule(user: UserRow, draft: StoryDraft, at: Date): Promise<StoryRow> {
    const delay = at.getTime() - this.now().getTime();
    if (delay < 30_000) throw new StoryError('Vaqt kamida 30 soniyadan keyin bo‘lishi kerak');
    if (delay > MAX_SCHEDULE_AHEAD_MS) throw new StoryError('Ko‘pi bilan 30 kun oldinga rejalashtirish mumkin');
    return this.createAndEnqueue(user, draft, at, delay);
  }

  /** Downloads, converts to the official story format and uploads. */
  private async buildContent(row: StoryRow): Promise<StoryContent> {
    const raw = await this.deps.tg.downloadFile(row.file_id);
    if (row.media_type === 'photo') {
      const p = await this.deps.preparer.photo(raw);
      return { type: 'photo', data: p.data };
    }
    const v = await this.deps.preparer.video(raw, row.video_duration ?? undefined);
    return { type: 'video', data: v.data, duration: v.duration, isAnimation: v.isAnimation };
  }

  /** Job entry point for story.post. Idempotent: anything but 'scheduled' is skipped. */
  async publish(storyId: string, ctx: { isFinalAttempt: boolean }): Promise<StoryRow> {
    const { repo, tg, logger } = this.deps;
    const row = await repo.getStory(storyId);
    if (!row) throw new StoryError('Story topilmadi');
    if (row.status !== 'scheduled') return row;

    await repo.updateStory(row.id, { status: 'posting', attempts: row.attempts + 1 });
    let content: StoryContent;
    try {
      content = await this.buildContent(row);
    } catch (err) {
      // Conversion/download problems are not transient — fail immediately with the reason.
      const explained = err instanceof MediaPrepError ? err.message : explainTelegramError(err);
      return this.fail(row, explained, true);
    }
    try {
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
      logger.warn('postStory failed', { story: row.id, err });
      const retryable = !(err instanceof TelegramApiError) || err.errorCode === 429 || err.errorCode >= 500 || err.errorCode === 0;
      const res = await this.fail(row, explainTelegramError(err), ctx.isFinalAttempt || !retryable);
      if (res.status === 'scheduled') throw err; // let the queue retry
      return res;
    }
  }

  private async fail(row: StoryRow, reason: string, final: boolean): Promise<StoryRow> {
    const updated = await this.deps.repo.updateStory(row.id, { status: final ? 'failed' : 'scheduled', error: reason });
    await this.deps.repo.log({ user_id: row.user_id, module: 'stories', action: 'post', status: 'error', details: { story: row.id, error: reason, final } });
    return updated;
  }

  /** Job wrapper: publishes and notifies the owner. */
  async runScheduled(storyId: string, ctx: { isFinalAttempt: boolean }): Promise<void> {
    const res = await this.publish(storyId, ctx);
    const { tg, ownerChatId } = this.deps;
    if (res.status === 'posted') {
      await tg.sendMessage(ownerChatId, `✅ Story joylandi (ID: ${res.story_id}).`, {
        reply_markup: { inline_keyboard: [[
          { text: '✏️ Captionni tahrirlash', callback_data: `sa:cap:${res.id}` },
          { text: '🗑 O‘chirish', callback_data: `sa:del:${res.id}` },
        ]] },
      });
    } else if (res.status === 'failed') {
      await tg.sendMessage(ownerChatId, `❌ Story joylanmadi.\n${res.error ?? ''}`);
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

  /** Queues a caption edit (editStory requires content, so the media is re-converted and re-uploaded). */
  async requestCaptionEdit(user: UserRow, storyId: string, caption: string): Promise<void> {
    const row = await this.ownRow(user, storyId);
    if (row.status !== 'posted' || !row.story_id) throw new StoryError('Faqat joylangan storyni tahrirlash mumkin');
    if (caption.length > STORY_CAPTION_MAX) throw new StoryError(`Caption ${STORY_CAPTION_MAX} belgidan oshmasin`);
    await this.deps.queue.enqueue('story.edit', { id: row.id, caption }, { jobId: jobIds.storyEdit(row.id), delayMs: 0 });
  }

  /** Job entry point for story.edit. */
  async runEdit(storyId: string, caption: string, ctx: { isFinalAttempt: boolean }): Promise<void> {
    const { repo, tg, ownerChatId } = this.deps;
    const row = await repo.getStory(storyId);
    if (!row || row.status !== 'posted' || !row.story_id) return;
    try {
      const content = await this.buildContent(row);
      await tg.editStory(row.business_connection_id, row.story_id, content, caption);
    } catch (err) {
      const reason = err instanceof MediaPrepError ? err.message : explainTelegramError(err);
      await repo.log({ user_id: row.user_id, module: 'stories', action: 'edit', status: 'error', details: { story: row.id, error: reason } });
      const retryable = err instanceof TelegramApiError && (err.errorCode === 429 || err.errorCode >= 500);
      if (retryable && !ctx.isFinalAttempt) throw err;
      await tg.sendMessage(ownerChatId, `❌ Story tahrirlanmadi.\n${reason}`);
      return;
    }
    await repo.updateStory(row.id, { caption: caption || null });
    await repo.log({ user_id: row.user_id, module: 'stories', action: 'edit', status: 'ok', details: { story: row.id } });
    await tg.sendMessage(ownerChatId, '✅ Story caption yangilandi.');
  }

  /** Bot API has no "get story" method, so status = our record + computed expiry. */
  describe(row: StoryRow, fmt: (d: string) => string): string {
    const statusText: Record<StoryRow['status'], string> = {
      scheduled: '📅 Navbatda', posting: '⏳ Joylanmoqda', posted: '✅ Joylangan',
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
