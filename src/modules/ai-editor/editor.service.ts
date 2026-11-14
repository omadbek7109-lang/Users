import type { Repository } from '../../database/repository.js';
import type { AiEditRow, UserRow } from '../../database/types.js';
import type { AiRegistry } from '../../services/ai/provider.js';
import type { Logger } from '../../services/logger.js';
import { escapeHtml } from '../../utils/html.js';
import { diffToHtml, wordDiff } from './diff.js';
import { SYSTEM_PROMPT, buildUserPrompt, type AiOperation } from './prompts.js';

export const MAX_INPUT_CHARS = 4000;

export class EditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorError';
  }
}

export class EditorService {
  constructor(private readonly deps: { repo: Repository; ai: AiRegistry; logger: Logger }) {}

  async start(user: UserRow, text: string): Promise<AiEditRow> {
    const t = text.trim();
    if (!t) throw new EditorError('Matn bo‘sh');
    if (t.length > MAX_INPUT_CHARS) throw new EditorError(`Matn juda uzun (maksimum ${MAX_INPUT_CHARS} belgi)`);
    return this.deps.repo.createAiEdit({
      user_id: user.id, parent_id: null, root_id: null, provider: null, operation: 'original', source_text: t, result_text: t,
    });
  }

  private async own(user: UserRow, id: string): Promise<AiEditRow> {
    const e = await this.deps.repo.getAiEdit(id);
    if (!e || e.user_id !== user.id) throw new EditorError('Matn topilmadi (eskirgan bo‘lishi mumkin)');
    return e;
  }

  /** Applies an operation to the result of edit `baseId`. */
  async apply(user: UserRow, baseId: string, op: AiOperation): Promise<AiEditRow> {
    const base = await this.own(user, baseId);
    const provider = this.deps.ai.get(user.settings?.aiProvider);
    let result: string;
    try {
      result = await provider.complete({ system: SYSTEM_PROMPT, user: buildUserPrompt(op, base.result_text), maxTokens: 4096 });
    } catch (err) {
      await this.deps.repo.log({ user_id: user.id, module: 'ai-editor', action: op, status: 'error', details: { provider: provider.name, error: (err as Error).message } });
      throw new EditorError(`AI javob bermadi: ${(err as Error).message}`);
    }
    const edit = await this.deps.repo.createAiEdit({
      user_id: user.id,
      parent_id: base.id,
      root_id: base.root_id ?? base.id,
      provider: provider.name,
      operation: op,
      source_text: base.result_text,
      result_text: result.slice(0, 16000),
    });
    await this.deps.repo.log({ user_id: user.id, module: 'ai-editor', action: op, status: 'ok', details: { provider: provider.name, edit: edit.id } });
    return edit;
  }

  /** "Qayta tahrirlash": re-runs the same operation on the same source. */
  async regenerate(user: UserRow, editId: string): Promise<AiEditRow> {
    const e = await this.own(user, editId);
    if (!e.parent_id || e.operation === 'original') throw new EditorError('Avval biror amalni tanlang');
    return this.apply(user, e.parent_id, e.operation as AiOperation);
  }

  async original(user: UserRow, editId: string): Promise<AiEditRow> {
    const e = await this.own(user, editId);
    return e.root_id ? this.own(user, e.root_id) : e;
  }

  async get(user: UserRow, editId: string): Promise<AiEditRow> {
    return this.own(user, editId);
  }

  /** HTML comparison between the original text and this edit. */
  async compare(user: UserRow, editId: string): Promise<string> {
    const e = await this.own(user, editId);
    const root = await this.original(user, editId);
    if (root.id === e.id) return '<i>Bu original matn — taqqoslash uchun avval tahrir qiling.</i>';
    const parts = wordDiff(root.result_text, e.result_text);
    if (!parts) {
      return `<b>Original:</b>\n${escapeHtml(root.result_text)}\n\n<b>Yangi:</b>\n${escapeHtml(e.result_text)}`;
    }
    return `<b>🔍 Taqqoslash</b> (<s>o‘chirilgan</s>, <b><u>qo‘shilgan</u></b>)\n\n${diffToHtml(parts)}`;
  }
}
