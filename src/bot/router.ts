import type { TgUpdate } from '../types/telegram.js';
import { BotContext, type BotDeps } from './context.js';
import { isOwner, strangerAllowance } from '../middleware/owner-only.js';
import { handlePrivateMessage } from './handlers/private.js';
import { handleCallback } from './handlers/callbacks.js';
import { handleGroupCommand, trackGroupMessage } from './handlers/group.js';
import { handleBusinessConnection, handleBusinessMessage } from './handlers/business.js';
import { StoryError } from '../modules/stories/story.service.js';
import { TimedMediaError } from '../modules/timed-media/timed-media.service.js';
import { EditorError } from '../modules/ai-editor/editor.service.js';
import { explainTelegramError, TelegramApiError } from '../services/telegram-client.js';
import { escapeHtml } from '../utils/html.js';

export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'my_chat_member',
  'business_connection',
  'business_message',
] as const;

/** Framework-agnostic update router. grammY only delivers raw updates into `handle`. */
export class Router {
  readonly ctx: BotContext;
  private warnedStrangers = new Set<number>();

  constructor(deps: BotDeps) {
    this.ctx = new BotContext(deps);
  }

  async handle(u: TgUpdate): Promise<void> {
    const c = this.ctx;
    const owner = isOwner(u, c.d.ownerId);
    try {
      if (u.business_connection) return await handleBusinessConnection(c, u.business_connection);
      if (u.business_message) return await handleBusinessMessage(c, u.business_message);
      if (u.my_chat_member) return void (await c.d.cleaner.onMembership(u.my_chat_member, await c.owner()));

      if (!owner) return await this.handleStranger(u);

      if (u.message) {
        const m = u.message;
        if (m.chat.type === 'group' || m.chat.type === 'supergroup') {
          await trackGroupMessage(c, m);
          return await handleGroupCommand(c, m);
        }
        if (m.chat.type === 'private') return await handlePrivateMessage(c, m);
        return;
      }
      if (u.callback_query) return await handleCallback(c, u.callback_query);
    } catch (err) {
      await this.reportError(u, err);
    }
  }

  private async handleStranger(u: TgUpdate): Promise<void> {
    const c = this.ctx;
    const allowance = strangerAllowance(u);
    if (allowance === 'track-group' && u.message) return trackGroupMessage(c, u.message);
    if (u.callback_query) {
      await c.d.tg.answerCallbackQuery(u.callback_query.id, '⛔️ Ruxsat yo‘q', true).catch(() => undefined);
      return;
    }
    const m = u.message;
    if (m?.chat.type === 'private' && m.from && !this.warnedStrangers.has(m.from.id)) {
      this.warnedStrangers.add(m.from.id);
      await c.send(m.chat.id, '⛔️ Bu shaxsiy yordamchi bot va faqat egasiga xizmat qiladi.').catch(() => undefined);
    }
  }

  private async reportError(u: TgUpdate, err: unknown): Promise<void> {
    const c = this.ctx;
    const chatId = u.message?.chat.id ?? u.callback_query?.message?.chat.id ?? c.d.ownerId;
    const known = err instanceof StoryError || err instanceof TimedMediaError || err instanceof EditorError;
    if (!known) c.d.logger.error('update failed', { update: u.update_id, err });
    const text = known
      ? `⚠️ ${(err as Error).message}`
      : err instanceof TelegramApiError
        ? `⚠️ ${explainTelegramError(err)}`
        : '⚠️ Kutilmagan xatolik yuz berdi. Activity Logs’ni tekshiring.';
    try {
      const owner = await c.owner();
      if (!known) await c.d.repo.log({ user_id: owner.id, module: 'bot', action: 'error', status: 'error', details: { error: (err as Error)?.message } });
      await c.send(chatId, escapeHtml(text), undefined, true);
    } catch (e) {
      c.d.logger.error('error report failed', { e });
    }
  }
}
