import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerUser, setup } from './helpers.js';
import { ClaudeProvider, OpenAiProvider, AiProviderError } from '../src/services/ai/provider.js';
import { wordDiff, diffToHtml } from '../src/modules/ai-editor/diff.js';
import type { FetchFn } from '../src/services/telegram-client.js';

function captureFetch(status: number, body: unknown) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return Response.json(body, { status });
  }) as unknown as FetchFn;
  return { fn, seen };
}

test('ai: Claude provider uses Messages API with server-side key', async () => {
  const { fn, seen } = captureFetch(200, { content: [{ type: 'text', text: 'Tuzatilgan matn' }] });
  const p = new ClaudeProvider('sk-ant-secret-key-123', 'claude-sonnet-5-5', fn);
  assert.equal(await p.complete({ system: 'S', user: 'U' }), 'Tuzatilgan matn');
  assert.equal(seen[0]!.url, 'https://api.anthropic.com/v1/messages');
  const h = seen[0]!.init.headers as Record<string, string>;
  assert.equal(h['x-api-key'], 'sk-ant-secret-key-123');
  assert.equal(h['anthropic-version'], '2023-06-01');
  const body = JSON.parse(String(seen[0]!.init.body));
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.system, 'S');
});

test('ai: OpenAI provider uses chat completions', async () => {
  const { fn, seen } = captureFetch(200, { choices: [{ message: { content: 'OK' } }] });
  const p = new OpenAiProvider('sk-proj-xxxxxxxxxxxxxxxxxxxx', 'my-model', fn);
  assert.equal(await p.complete({ system: 'S', user: 'U' }), 'OK');
  assert.equal(seen[0]!.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(JSON.parse(String(seen[0]!.init.body)).messages[0].role, 'system');
});

test('error handling: provider errors never contain the API key', async () => {
  const { fn } = captureFetch(401, { error: { message: 'invalid x-api-key sk-ant-secret-key-123' } });
  const p = new ClaudeProvider('sk-ant-secret-key-123', 'm', fn);
  await assert.rejects(p.complete({ system: 'S', user: 'U' }), (e: Error) => e instanceof AiProviderError && !e.message.includes('sk-ant-secret'));
});

test('editor: start → apply → chain → regenerate → original → compare', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  const root = await env.editor.start(owner, 'salom dunyo');
  const fixed = await env.editor.apply(owner, root.id, 'fix');
  assert.equal(fixed.parent_id, root.id);
  assert.equal(fixed.root_id, root.id);
  assert.match(env.claude.requests[0]!.user, /<text>\nsalom dunyo\n<\/text>/);

  const shorter = await env.editor.apply(owner, fixed.id, 'shorten');
  assert.equal(shorter.source_text, fixed.result_text);
  assert.equal(shorter.root_id, root.id);

  const again = await env.editor.regenerate(owner, shorter.id);
  assert.equal(again.operation, 'shorten');
  assert.equal(again.parent_id, fixed.id);

  assert.equal((await env.editor.original(owner, again.id)).id, root.id);
  assert.match(await env.editor.compare(owner, fixed.id), /<s>/);
});

test('editor: provider can be switched per user settings', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await env.repo.updateUserSettings(owner.id, { aiProvider: 'openai' });
  const root = await env.editor.start(owner, 'hello');
  const e = await env.editor.apply(owner, root.id, 'tr_uz');
  assert.equal(e.provider, 'openai');
  assert.equal(e.result_text, 'OPENAI RESULT');
});

test('editor: limits and failures', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await assert.rejects(env.editor.start(owner, 'x'.repeat(4001)), /juda uzun/);
  const root = await env.editor.start(owner, 'hi');
  env.claude.fail = true;
  await assert.rejects(env.editor.apply(owner, root.id, 'fix'), /AI javob bermadi/);
  assert.equal(env.repo.logs.at(-1)!.status, 'error');
});

test('diff: word level with HTML escaping', () => {
  const parts = wordDiff('men <b> bor', 'men <i> bor edim')!;
  const html = diffToHtml(parts);
  assert.match(html, /<s>&lt;b&gt;<\/s>/);
  assert.match(html, /<b><u>&lt;i&gt;<\/u><\/b>/);
  assert.match(html, /<b><u>edim<\/u><\/b>/);
});
