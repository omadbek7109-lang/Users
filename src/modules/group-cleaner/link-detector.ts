import type { TgMessage } from '../../types/telegram.js';

const LINK_RE = /(https?:\/\/\S+|\bwww\.\S+|\bt\.me\/\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|ru|uz|io|me|info|biz|xyz|app|dev|link|site|online|shop)\b)/i;

/** True if the message contains a link (URL entities or a URL-looking string in text/caption). */
export function hasLink(m: Pick<TgMessage, 'text' | 'caption' | 'entities' | 'caption_entities'>): boolean {
  const entities = [...(m.entities ?? []), ...(m.caption_entities ?? [])];
  if (entities.some((e) => e.type === 'url' || e.type === 'text_link')) return true;
  return LINK_RE.test(`${m.text ?? ''} ${m.caption ?? ''}`);
}
