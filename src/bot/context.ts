import type { Repository } from '../database/repository.js';
import type { UserRow } from '../database/types.js';
import type { AiRegistry } from '../services/ai/provider.js';
import type { Logger } from '../services/logger.js';
import type { StateStore } from '../services/state-store.js';
import type { TelegramClient } from '../services/telegram-client.js';
import type { StoryService } from '../modules/stories/story.service.js';
import type { TimedMediaService } from '../modules/timed-media/timed-media.service.js';
import type { CleanerService } from '../modules/group-cleaner/cleaner.service.js';
import type { EditorService } from '../modules/ai-editor/editor.service.js';
import type { ReplyMarkup } from '../types/telegram.js';
import { formatInTz } from '../utils/time.js';

export interface BotDeps {
  ownerId: number;
  timezone: string;
  repo: Repository;
  tg: TelegramClient;
  state: StateStore;
  ai: AiRegistry;
  stories: StoryService;
  media: TimedMediaService;
  cleaner: CleanerService;
  editor: EditorService;
  logger: Logger;
  now?: () => Date;
}

export class BotContext {
  private ownerRow?: UserRow;
  private botUsername?: string;

  constructor(public readonly d: BotDeps) {}

  now(): Date {
    return this.d.now?.() ?? new Date();
  }

  fmt = (date: string | Date) => formatInTz(date, this.d.timezone);

  async owner(): Promise<UserRow> {
    if (!this.ownerRow) this.ownerRow = await this.d.repo.ensureUser(this.d.ownerId);
    return this.ownerRow;
  }

  /** Re-reads the owner row (after settings changes). */
  async refreshOwner(): Promise<UserRow> {
    this.ownerRow = (await this.d.repo.getUserByTelegramId(this.d.ownerId)) ?? undefined;
    return this.owner();
  }

  async username(): Promise<string | undefined> {
    if (this.botUsername === undefined) this.botUsername = (await this.d.tg.getMe()).username ?? '';
    return this.botUsername || undefined;
  }

  send(chatId: number, text: string, markup?: ReplyMarkup, html = false) {
    return this.d.tg.sendMessage(chatId, text, {
      reply_markup: markup,
      parse_mode: html ? 'HTML' : undefined,
      link_preview_options: { is_disabled: true },
    });
  }

  edit(chatId: number, messageId: number, text: string, markup?: ReplyMarkup, html = false) {
    return this.d.tg
      .editMessageText(chatId, messageId, text, {
        reply_markup: markup,
        parse_mode: html ? 'HTML' : undefined,
        link_preview_options: { is_disabled: true },
      })
      .catch((err: Error) => {
        // "message is not modified" is harmless
        if (!/not modified/i.test(err.message)) throw err;
      });
  }
}
