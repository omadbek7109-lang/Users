/**
 * Removes secrets from any string/object before it is logged or stored.
 * Covers: Telegram bot tokens (incl. inside api.telegram.org URLs), Anthropic/OpenAI keys,
 * Bearer tokens, JWTs (Supabase keys), redis passwords in URLs, business connection ids.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\bbot\d{5,}:[A-Za-z0-9_-]{30,}/g, 'bot[REDACTED]'],
  [/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer [REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
  [/(rediss?:\/\/[^:\s/]*:)[^@\s]+@/g, '$1[REDACTED]@'],
];

const SENSITIVE_KEYS = /^(token|bot_token|api_key|apikey|authorization|password|secret|service_role_key|x-api-key|business_connection_id)$/i;

export function redactString(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 6) return '[DEPTH]' as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
