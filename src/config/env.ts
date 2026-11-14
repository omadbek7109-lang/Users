export type AiProviderName = 'claude' | 'openai';

export interface AppConfig {
  botToken: string;
  ownerTelegramId: number;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  redisUrl: string;
  aiProvider: AiProviderName;
  anthropicApiKey?: string;
  claudeModel: string;
  openaiApiKey?: string;
  openaiModel?: string;
  timezone: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  port?: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Konfiguratsiya xatosi:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const BOT_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/** Validates environment variables. Never prints secret values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const problems: string[] = [];
  const req = (name: string): string => {
    const v = clean(env[name]);
    if (!v) problems.push(`${name} kiritilmagan`);
    return v ?? '';
  };

  const botToken = req('BOT_TOKEN');
  if (botToken && !BOT_TOKEN_RE.test(botToken)) problems.push('BOT_TOKEN formati noto‘g‘ri');

  const ownerRaw = req('OWNER_TELEGRAM_ID');
  const ownerTelegramId = Number(ownerRaw);
  if (ownerRaw && (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0)) {
    problems.push('OWNER_TELEGRAM_ID musbat butun son bo‘lishi kerak');
  }

  const supabaseUrl = req('SUPABASE_URL');
  if (supabaseUrl && !/^https:\/\//.test(supabaseUrl)) problems.push('SUPABASE_URL https:// bilan boshlanishi kerak');
  const supabaseServiceRoleKey = req('SUPABASE_SERVICE_ROLE_KEY');
  const redisUrl = req('REDIS_URL');
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) problems.push('REDIS_URL redis:// yoki rediss:// bilan boshlanishi kerak');

  const aiProviderRaw = (clean(env.AI_PROVIDER) ?? 'claude').toLowerCase();
  if (aiProviderRaw !== 'claude' && aiProviderRaw !== 'openai') problems.push('AI_PROVIDER faqat claude yoki openai');
  const aiProvider = aiProviderRaw as AiProviderName;

  const anthropicApiKey = clean(env.ANTHROPIC_API_KEY);
  const openaiApiKey = clean(env.OPENAI_API_KEY);
  const openaiModel = clean(env.OPENAI_MODEL);
  if (!anthropicApiKey && !openaiApiKey) problems.push('ANTHROPIC_API_KEY yoki OPENAI_API_KEY dan kamida bittasi kerak');
  if (aiProvider === 'claude' && !anthropicApiKey) problems.push('AI_PROVIDER=claude, lekin ANTHROPIC_API_KEY yo‘q');
  if (aiProvider === 'openai' && !openaiApiKey) problems.push('AI_PROVIDER=openai, lekin OPENAI_API_KEY yo‘q');
  if (openaiApiKey && !openaiModel) problems.push('OPENAI_API_KEY berilgan, lekin OPENAI_MODEL ko‘rsatilmagan');

  const timezone = clean(env.TIMEZONE) ?? 'Asia/Tashkent';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    problems.push(`TIMEZONE noto‘g‘ri: ${timezone}`);
  }

  const lvl = (clean(env.LOG_LEVEL) ?? 'info') as AppConfig['logLevel'];
  const logLevel = ['debug', 'info', 'warn', 'error'].includes(lvl) ? lvl : 'info';
  const portRaw = clean(env.PORT);
  const port = portRaw ? Number(portRaw) : undefined;
  if (portRaw && (!Number.isInteger(port) || port! <= 0)) problems.push('PORT noto‘g‘ri');

  if (problems.length) throw new ConfigError(problems);

  return {
    botToken,
    ownerTelegramId,
    supabaseUrl,
    supabaseServiceRoleKey,
    redisUrl,
    aiProvider,
    anthropicApiKey,
    claudeModel: clean(env.CLAUDE_MODEL) ?? 'claude-sonnet-5-5',
    openaiApiKey,
    openaiModel,
    timezone,
    logLevel,
    port,
  };
}
