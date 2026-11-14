import type { Repository } from '../../database/repository.js';
import type { DeleteMode, DeleteTaskRow, UserRow } from '../../database/types.js';
import type { Logger } from '../../services/logger.js';
import { explainTelegramError, type TelegramClient } from '../../services/telegram-client.js';
import type { TgChatMemberUpdated, TgMessage } from '../../types/telegram.js';
import { hasLink } from './link-detector.js';

/** Telegram only lets bots delete messages younger than 48h — keep a 15-minute safety margin. */
export const DELETE_WINDOW_MS = 48 * 3_600_000 - 15 * 60_000;
export const MAX_DELETE_COUNT = 1000;
export const CONFIRM_TTL_MS = 10 * 60_000;
const BATCH = 100;

export type PrepareResult = { ok: true; task: DeleteTaskRow } | { ok: false; reason: string };

export interface ExecuteResult {
  task: DeleteTaskRow;
  requested: number;
  deleted: number;
  errors: string[];
}

export class CleanerService {
  private botId?: number;

  constructor(
    private readonly deps: {
      repo: Repository;
      tg: TelegramClient;
      logger: Logger;
      ownerId: number;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async getBotId(): Promise<number> {
    if (this.botId === undefined) this.botId = (await this.deps.tg.getMe()).id;
    return this.botId;
  }

  /**
   * Bot added/removed/promoted in a group. Groups where the bot was added by anyone
   * other than the owner are left immediately.
   */
  async onMembership(u: TgChatMemberUpdated, owner: UserRow): Promise<'registered' | 'left' | 'removed' | 'ignored'> {
    const { repo, tg } = this.deps;
    if (u.chat.type !== 'group' && u.chat.type !== 'supergroup') return 'ignored';
    const st = u.new_chat_member.status;
    if (st === 'left' || st === 'kicked') {
      await repo.deleteGroup(u.chat.id);
      await repo.log({ user_id: owner.id, module: 'group-cleaner', action: 'bot-removed', status: 'info', details: { chat: u.chat.id } });
      return 'removed';
    }
    const wasIn = ['member', 'administrator', 'creator', 'restricted'].includes(u.old_chat_member.status);
    const existing = await repo.getGroup(u.chat.id);
    if (!wasIn && !existing && u.from.id !== this.deps.ownerId) {
      await tg.leaveChat(u.chat.id).catch(() => undefined);
      await repo.log({ user_id: owner.id, module: 'group-cleaner', action: 'left-foreign-group', status: 'info', details: { chat: u.chat.id } });
      return 'left';
    }
    const canDelete = st === 'administrator' && u.new_chat_member.can_delete_messages === true;
    await repo.upsertGroup({
      chat_id: u.chat.id,
      user_id: owner.id,
      title: u.chat.title ?? null,
      bot_can_delete: canDelete,
      track_messages: existing?.track_messages ?? true,
    });
    return 'registered';
  }

  /** A basic group was upgraded to a supergroup: Telegram gives it a new chat id. */
  async migrate(oldChatId: number, newChatId: number): Promise<boolean> {
    const { repo } = this.deps;
    const g = await repo.getGroup(oldChatId);
    if (!g) return false;
    await repo.upsertGroup({ ...g, chat_id: newChatId });
    await repo.deleteGroup(oldChatId); // old message ids are invalid in the new chat
    await repo.log({ user_id: g.user_id, module: 'group-cleaner', action: 'migrated-to-supergroup', status: 'info', details: { from: oldChatId, to: newChatId } });
    return true;
  }

  /** Stores metadata (no text) of a group message the bot received. */
  async track(m: TgMessage): Promise<boolean> {
    const g = await this.deps.repo.getGroup(m.chat.id);
    if (!g || !g.track_messages) return false;
    await this.deps.repo.trackMessage({
      chat_id: m.chat.id,
      message_id: m.message_id,
      from_user_id: m.from?.id ?? null,
      has_link: hasLink(m),
      sent_at: new Date(m.date * 1000).toISOString(),
    });
    return true;
  }

  /** Verifies live admin rights via getChatMember and stores the result. */
  async checkRights(chatId: number): Promise<{ ok: boolean; reason?: string }> {
    const { repo, tg } = this.deps;
    const group = await repo.getGroup(chatId);
    if (!group) return { ok: false, reason: 'Bu guruh ro‘yxatdan o‘tmagan. Botni guruhdan chiqarib, qayta qo‘shing.' };
    try {
      const me = await tg.getChatMember(chatId, await this.getBotId());
      const ok = me.status === 'administrator' && me.can_delete_messages === true;
      if (group.bot_can_delete !== ok) await repo.upsertGroup({ ...group, bot_can_delete: ok });
      return ok ? { ok } : { ok, reason: 'Bot admin emas yoki "Xabarlarni o‘chirish" huquqi berilmagan.' };
    } catch (err) {
      return { ok: false, reason: explainTelegramError(err) };
    }
  }

  async prepare(owner: UserRow, chatId: number, mode: DeleteMode, count?: number, excludeIds: number[] = []): Promise<PrepareResult> {
    const { repo } = this.deps;
    if (mode === 'last_n' && (!count || !Number.isInteger(count) || count < 1 || count > MAX_DELETE_COUNT)) {
      return { ok: false, reason: `Son 1 dan ${MAX_DELETE_COUNT} gacha bo‘lishi kerak. Masalan: /delete 10` };
    }
    const rights = await this.checkRights(chatId);
    if (!rights.ok) return { ok: false, reason: rights.reason ?? 'Huquq yo‘q' };

    const since = new Date(this.now().getTime() - DELETE_WINDOW_MS);
    const limit = mode === 'last_n' ? count! + excludeIds.length : MAX_DELETE_COUNT;
    const rows = await repo.listTrackedMessages(chatId, { since, onlyLinks: mode === 'links', limit });
    const ids = rows.map((r) => r.message_id).filter((id) => !excludeIds.includes(id));
    const selected = mode === 'last_n' ? ids.slice(0, count) : ids;
    if (selected.length === 0) {
      return {
        ok: false,
        reason: mode === 'links'
          ? 'So‘nggi 48 soatda bot kuzatgan linkli xabar topilmadi.'
          : 'So‘nggi 48 soatda bot kuzatgan xabar topilmadi. Bot faqat o‘zi qo‘shilgandan keyin ko‘rgan xabarlarni o‘chira oladi.',
      };
    }
    await repo.cancelPendingDeleteTasks(chatId);
    const task = await repo.createDeleteTask({
      user_id: owner.id,
      chat_id: chatId,
      mode,
      requested_count: mode === 'last_n' ? count! : null,
      message_ids: selected,
    });
    await repo.log({ user_id: owner.id, module: 'group-cleaner', action: `prepare-${mode}`, status: 'info', details: { chat: chatId, count: selected.length } });
    return { ok: true, task };
  }

  async execute(owner: UserRow, taskId: string): Promise<ExecuteResult> {
    const { repo, tg, logger } = this.deps;
    const task = await repo.getDeleteTask(taskId);
    if (!task || task.user_id !== owner.id) throw new Error('Vazifa topilmadi');
    if (task.status !== 'pending_confirmation') throw new Error('Bu vazifa allaqachon bajarilgan yoki bekor qilingan');
    if (this.now().getTime() - new Date(task.created_at).getTime() > CONFIRM_TTL_MS) {
      await repo.updateDeleteTask(task.id, { status: 'cancelled', finished_at: this.now().toISOString(), error: 'Tasdiqlash muddati o‘tdi' });
      throw new Error('Tasdiqlash muddati (10 daqiqa) o‘tdi. Buyruqni qayta yuboring.');
    }
    // Re-check rights and the 48h window at execution time (they may have changed since /delete).
    const rights = await this.checkRights(task.chat_id);
    if (!rights.ok) {
      await repo.updateDeleteTask(task.id, { status: 'failed', finished_at: this.now().toISOString(), error: rights.reason ?? 'Huquq yo‘q' });
      throw new Error(rights.reason ?? 'Huquq yo‘q');
    }
    await repo.updateDeleteTask(task.id, { status: 'running', confirmed_at: this.now().toISOString() });
    const since = new Date(this.now().getTime() - DELETE_WINDOW_MS);
    const stillValid = new Set(
      (await repo.listTrackedMessages(task.chat_id, { since, limit: MAX_DELETE_COUNT * 2 })).map((m) => m.message_id),
    );
    const ids = task.message_ids.filter((id) => stillValid.has(id));
    const skipped = task.message_ids.length - ids.length;

    let deleted = 0;
    const errors: string[] = [];
    if (skipped) errors.push(`${skipped} ta xabar 48 soatlik muddatdan chiqib qolgani yoki allaqachon o‘chirilgani uchun o‘tkazib yuborildi.`);
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        await tg.deleteMessages(task.chat_id, batch);
        deleted += batch.length;
        await repo.markMessagesDeleted(task.chat_id, batch);
      } catch (err) {
        logger.warn('deleteMessages batch failed', { chat: task.chat_id, err });
        errors.push(explainTelegramError(err));
      }
    }
    const status = deleted === task.message_ids.length ? 'done' : deleted > 0 ? 'partial' : 'failed';
    const updated = await repo.updateDeleteTask(task.id, {
      status,
      deleted_count: deleted,
      error: errors[0] ?? null,
      finished_at: this.now().toISOString(),
    });
    await repo.log({
      user_id: owner.id, module: 'group-cleaner', action: `delete-${task.mode}`, status: errors.length ? 'error' : 'ok',
      details: { chat: task.chat_id, requested: task.message_ids.length, deleted },
    });
    return { task: updated, requested: task.message_ids.length, deleted, errors };
  }

  async cancel(owner: UserRow, chatId: number, taskId?: string): Promise<number> {
    const { repo } = this.deps;
    if (taskId) {
      const t = await repo.getDeleteTask(taskId);
      if (!t || t.user_id !== owner.id || t.status !== 'pending_confirmation') return 0;
      await repo.updateDeleteTask(t.id, { status: 'cancelled', finished_at: this.now().toISOString() });
      return 1;
    }
    return repo.cancelPendingDeleteTasks(chatId);
  }
}
