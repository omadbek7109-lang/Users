/** Offset (ms) of `tz` from UTC at instant `at`. */
export function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

function zonedParts(at: Date, tz: string) {
  const local = new Date(at.getTime() + tzOffsetMs(at, tz));
  return { y: local.getUTCFullYear(), mo: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

const UNIT_MS: Record<string, number> = {
  s: 1000, sek: 1000, soniya: 1000,
  m: 60_000, min: 60_000, daq: 60_000, daqiqa: 60_000,
  h: 3_600_000, soat: 3_600_000,
  d: 86_400_000, kun: 86_400_000,
};

/**
 * Parses a schedule time typed by the user (interpreted in `tz`):
 *  "+10m", "+2h", "30 daqiqa", "1 soat", "15:30" (today or tomorrow), "2026-11-14 09:00", "14.11.2026 09:00".
 * Returns null if the input is not understood.
 */
export function parseWhen(input: string, now: Date, tz: string): Date | null {
  const s = input.trim().toLowerCase();

  const rel = s.match(/^\+?\s*(\d{1,4})\s*(s|sek|soniya|m|min|daq|daqiqa|h|soat|d|kun)\b/);
  if (rel) {
    const ms = Number(rel[1]) * UNIT_MS[rel[2]!]!;
    return ms > 0 ? new Date(now.getTime() + ms) : null;
  }

  const hm = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (hm) {
    const h = Number(hm[1]), mi = Number(hm[2]);
    if (h > 23 || mi > 59) return null;
    const { y, mo, d } = zonedParts(now, tz);
    let at = zonedToUtc(y, mo, d, h, mi, tz);
    if (at.getTime() <= now.getTime()) at = new Date(at.getTime() + 86_400_000);
    return at;
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/);
  const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  const m = iso
    ? { y: +iso[1]!, mo: +iso[2]!, d: +iso[3]!, h: +iso[4]!, mi: +iso[5]! }
    : dmy
      ? { y: +dmy[3]!, mo: +dmy[2]!, d: +dmy[1]!, h: +dmy[4]!, mi: +dmy[5]! }
      : null;
  if (m) {
    if (m.mo < 1 || m.mo > 12 || m.d < 1 || m.d > 31 || m.h > 23 || m.mi > 59) return null;
    return zonedToUtc(m.y, m.mo, m.d, m.h, m.mi, tz);
  }
  return null;
}

export function formatInTz(date: Date | string, tz: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

export function humanDuration(sec: number): string {
  if (sec < 60) return `${sec} soniya`;
  if (sec < 3600) return `${Math.round(sec / 60)} daqiqa`;
  if (sec < 86400) return `${Math.round(sec / 3600)} soat`;
  return `${Math.round(sec / 86400)} kun`;
}
