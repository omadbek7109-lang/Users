import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../src/config/env.js';
import { redact, redactString } from '../src/utils/redact.js';
import { createLogger } from '../src/services/logger.js';
import { TOKEN } from './helpers.js';

const base = {
  BOT_TOKEN: TOKEN,
  OWNER_TELEGRAM_ID: '1001',
  SUPABASE_URL: 'https://abc.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl',
  REDIS_URL: 'rediss://default:secretpass@redis.example.com:6379',
  ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop',
};

test('config: valid env loads with defaults', () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.ownerTelegramId, 1001);
  assert.equal(cfg.aiProvider, 'claude');
  assert.equal(cfg.timezone, 'Asia/Tashkent');
});

test('config: missing values are listed, secrets are never echoed', () => {
  try {
    loadConfig({ ...base, BOT_TOKEN: 'bad-token', OWNER_TELEGRAM_ID: 'abc', REDIS_URL: '' });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.match(e.message, /BOT_TOKEN formati/);
    assert.match(e.message, /OWNER_TELEGRAM_ID/);
    assert.match(e.message, /REDIS_URL kiritilmagan/);
    assert.ok(!e.message.includes('sk-ant'));
    assert.ok(!e.message.includes('bad-token'));
  }
});

test('config: openai requires model name and key for selected provider', () => {
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: 'openai' }), /OPENAI_API_KEY yo‘q/);
  assert.throws(() => loadConfig({ ...base, OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaa' }), /OPENAI_MODEL/);
  const cfg = loadConfig({ ...base, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-proj-aaaaaaaaaaaaaaaaaaaa', OPENAI_MODEL: 'some-model' });
  assert.equal(cfg.aiProvider, 'openai');
});

test('security: redact removes bot tokens, api keys, JWTs, redis passwords', () => {
  const s = redactString(
    `https://api.telegram.org/bot${TOKEN}/getMe ${TOKEN} sk-ant-api03-abcdefghijk sk-proj-abcdefghijklmnopqrst ` +
      `Bearer abcdefghijklmnop ${base.SUPABASE_SERVICE_ROLE_KEY} ${base.REDIS_URL}`,
  );
  for (const secret of [TOKEN, 'sk-ant-api03', 'sk-proj-abc', 'abcdefghijklmnop', base.SUPABASE_SERVICE_ROLE_KEY, 'secretpass']) {
    assert.ok(!s.includes(secret), `leaked: ${secret}`);
  }
});

test('security: redact masks sensitive object keys deeply', () => {
  const out = redact({ a: { api_key: 'x', business_connection_id: 'bc', nested: [{ token: 't' }] }, ok: 1 });
  assert.deepEqual(out, { a: { api_key: '[REDACTED]', business_connection_id: '[REDACTED]', nested: [{ token: '[REDACTED]' }] }, ok: 1 });
});

test('security: logger never prints secrets', () => {
  const lines: string[] = [];
  const log = createLogger('debug', (l) => lines.push(l));
  log.error(`failed calling bot${TOKEN}`, { err: new Error(`401 ${base.ANTHROPIC_API_KEY}`), authorization: 'Bearer zzzzzzzzzzzz' });
  const all = lines.join('\n');
  assert.ok(!all.includes(TOKEN));
  assert.ok(!all.includes(base.ANTHROPIC_API_KEY));
  assert.ok(!all.includes('zzzzzzzzzzzz'));
});
