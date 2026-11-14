import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { ConfigError, loadConfig } from './config/env.js';
import { createLogger } from './services/logger.js';
import { TelegramClient } from './services/telegram-client.js';
import { SupabaseRepository } from './database/supabase-repository.js';
import { BullJobQueue, createRedis, startWorker } from './services/bullmq-queue.js';
import { RedisStateStore } from './services/state-store.js';
import { AiRegistry, ClaudeProvider, OpenAiProvider, type AiProvider } from './services/ai/provider.js';
import { StoryService } from './modules/stories/story.service.js';
import { TimedMediaService } from './modules/timed-media/timed-media.service.js';
import { CleanerService } from './modules/group-cleaner/cleaner.service.js';
import { EditorService } from './modules/ai-editor/editor.service.js';
import { Router, ALLOWED_UPDATES } from './bot/router.js';
import { createBot } from './bot/create-bot.js';
import { createProcessor } from './jobs/processor.js';
import { reconcileJobs } from './jobs/reconcile.js';
import { FfmpegSharpPreparer } from './modules/stories/media-prep.js';
import { redactString } from './utils/redact.js';

async function main() {
  // Local development: read .env if present (production uses the host's environment variables).
  if (existsSync('.env')) process.loadEnvFile('.env');
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger(cfg.logLevel);
  const tg = new TelegramClient(cfg.botToken);
  const repo = new SupabaseRepository(cfg.supabaseUrl, cfg.supabaseServiceRoleKey);
  const redis = createRedis(cfg.redisUrl);
  const queue = new BullJobQueue(redis);
  const state = new RedisStateStore(redis);

  const providers: AiProvider[] = [];
  if (cfg.anthropicApiKey) providers.push(new ClaudeProvider(cfg.anthropicApiKey, cfg.claudeModel));
  if (cfg.openaiApiKey && cfg.openaiModel) providers.push(new OpenAiProvider(cfg.openaiApiKey, cfg.openaiModel));
  const ai = new AiRegistry(providers, cfg.aiProvider);

  const ownerChatId = cfg.ownerTelegramId; // private chat id == user id
  const ffmpegPath = process.env.FFMPEG_PATH?.trim() || ((await import('ffmpeg-static')) as unknown as { default: string | null }).default;
  if (!ffmpegPath) throw new Error('ffmpeg topilmadi: FFMPEG_PATH ni kiriting');
  const preparer = new FfmpegSharpPreparer(ffmpegPath);
  const stories = new StoryService({ repo, tg, queue, logger, ownerChatId, preparer });
  const media = new TimedMediaService({ repo, tg, queue, logger, ownerChatId });
  const cleaner = new CleanerService({ repo, tg, logger, ownerId: cfg.ownerTelegramId });
  const editor = new EditorService({ repo, ai, logger });

  const me = await tg.getMe();
  logger.info('bot identity', { username: me.username });
  const owner = await repo.ensureUser(cfg.ownerTelegramId);

  const router = new Router({
    ownerId: cfg.ownerTelegramId, timezone: cfg.timezone, repo, tg, state, ai, stories, media, cleaner, editor, logger,
  });
  const worker = startWorker(redis, createProcessor({ stories, media }), logger);
  // Database is the source of truth: re-create any queue job Redis lost while the bot was down.
  await reconcileJobs({ repo, queue, logger }, owner);

  await tg.call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Bosh menyu' },
      { command: 'help', description: 'Yordam' },
      { command: 'cancel', description: 'Joriy amalni bekor qilish' },
      { command: 'status', description: 'Stories / Business holati' },
    ],
    scope: { type: 'chat', chat_id: cfg.ownerTelegramId },
  }).catch((err) => logger.warn('setMyCommands failed', { err }));

  // Tracked message metadata older than 3 days is useless (Telegram 48h limit) — prune hourly.
  const prune = setInterval(() => {
    repo.pruneTrackedMessages(new Date(Date.now() - 3 * 86_400_000)).catch((err) => logger.warn('prune failed', { err }));
  }, 3_600_000);

  let server: ReturnType<typeof createServer> | undefined;
  if (cfg.port) {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }).listen(cfg.port, () => logger.info('health server listening', { port: cfg.port }));
  }

  const bot = createBot(cfg.botToken, router, logger);
  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(prune);
    await bot.stop().catch(() => undefined);
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    redis.disconnect();
    server?.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('starting long polling');
  await bot.start({
    allowed_updates: [...ALLOWED_UPDATES],
    onStart: () => logger.info('bot started'),
  });
}

main().catch((err) => {
  console.error('Fatal:', redactString(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
