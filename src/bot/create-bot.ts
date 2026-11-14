import { Bot, GrammyError, HttpError } from 'grammy';
import type { Router } from './router.js';
import type { Logger } from '../services/logger.js';
import type { TgUpdate } from '../types/telegram.js';

/**
 * grammY is used for receiving updates (long polling with automatic backoff).
 * All business logic lives in the framework-agnostic Router.
 */
export function createBot(token: string, router: Router, logger: Logger): Bot {
  const bot = new Bot(token);
  bot.use(async (ctx) => {
    await router.handle(ctx.update as unknown as TgUpdate);
  });
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) logger.error('grammY API error', { code: e.error_code, description: e.description });
    else if (e instanceof HttpError) logger.error('grammY network error', { message: e.message });
    else logger.error('grammY unknown error', { err: e });
  });
  return bot;
}
