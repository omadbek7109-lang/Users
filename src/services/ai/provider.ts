import type { AiProviderName } from '../../config/env.js';
import type { FetchFn } from '../telegram-client.js';
import { redactString } from '../../utils/redact.js';

export interface AiRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface AiProvider {
  readonly name: AiProviderName;
  complete(req: AiRequest): Promise<string>;
}

export class AiProviderError extends Error {
  constructor(provider: string, public readonly status: number, message: string) {
    super(`${provider} xatosi (${status}): ${redactString(message).slice(0, 300)}`);
    this.name = 'AiProviderError';
  }
}

const TIMEOUT_MS = 60_000;

export class ClaudeProvider implements AiProvider {
  readonly name = 'claude' as const;
  constructor(private readonly apiKey: string, private readonly model: string, private readonly fetchFn: FetchFn = fetch) {}

  async complete(req: AiRequest): Promise<string> {
    const res = await this.fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 2048,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      content?: Array<{ type: string; text?: string }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new AiProviderError('Claude', res.status, body.error?.message ?? 'request failed');
    const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
    if (!text) throw new AiProviderError('Claude', res.status, 'bo‘sh javob');
    return text;
  }
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  constructor(private readonly apiKey: string, private readonly model: string, private readonly fetchFn: FetchFn = fetch) {}

  async complete(req: AiRequest): Promise<string> {
    const res = await this.fetchFn('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: req.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new AiProviderError('OpenAI', res.status, body.error?.message ?? 'request failed');
    const text = body.choices?.[0]?.message?.content?.trim();
    if (!text) throw new AiProviderError('OpenAI', res.status, 'bo‘sh javob');
    return text;
  }
}

/** Holds every configured provider; the active one can be switched at runtime from Settings. */
export class AiRegistry {
  private readonly providers = new Map<AiProviderName, AiProvider>();
  constructor(list: AiProvider[], private defaultName: AiProviderName) {
    for (const p of list) this.providers.set(p.name, p);
  }
  available(): AiProviderName[] {
    return [...this.providers.keys()];
  }
  get(preferred?: AiProviderName): AiProvider {
    const p = (preferred && this.providers.get(preferred)) || this.providers.get(this.defaultName) || [...this.providers.values()][0];
    if (!p) throw new Error('Hech qanday AI provayder sozlanmagan');
    return p;
  }
}
