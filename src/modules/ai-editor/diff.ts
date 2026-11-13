import { escapeHtml } from '../../utils/html.js';

export type DiffPart = { type: 'same' | 'add' | 'del'; text: string };

const MAX_CELLS = 4_000_000;

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

/** Word-level diff using LCS. Returns null if the texts are too large to diff cheaply. */
export function wordDiff(a: string, b: string): DiffPart[] | null {
  const x = tokenize(a);
  const y = tokenize(b);
  const n = x.length, m = y.length;
  if (n * m > MAX_CELLS) return null;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push('same', x[i]!); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push('del', x[i]!); i++; }
    else { push('add', y[j]!); j++; }
  }
  while (i < n) push('del', x[i++]!);
  while (j < m) push('add', y[j++]!);
  return parts;
}

/** Telegram HTML: removed words struck through, added words bold+underlined. */
export function diffToHtml(parts: DiffPart[]): string {
  return parts
    .map((p) => {
      if (p.type === 'same' || !p.text.trim()) return escapeHtml(p.text);
      const [, lead, core, trail] = p.text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
      const t = escapeHtml(core!);
      return `${lead}${p.type === 'del' ? `<s>${t}</s>` : `<b><u>${t}</u></b>`}${trail}`;
    })
    .join('');
}
