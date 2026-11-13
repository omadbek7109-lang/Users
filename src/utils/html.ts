export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Telegram message hard limit is 4096 chars; keep a safety margin. */
export function truncate(s: string, max = 3900): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
