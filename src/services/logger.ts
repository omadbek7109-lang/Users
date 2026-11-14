import { redact } from '../utils/redact.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(level: Level = 'info', sink: (line: string) => void = (l) => console.log(l)): Logger {
  const write = (lvl: Level, msg: string, meta?: unknown) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry: Record<string, unknown> = { t: new Date().toISOString(), lvl, msg: redact(msg) };
    if (meta !== undefined) entry.meta = redact(meta);
    sink(JSON.stringify(entry));
  };
  return {
    debug: (m, x) => write('debug', m, x),
    info: (m, x) => write('info', m, x),
    warn: (m, x) => write('warn', m, x),
    error: (m, x) => write('error', m, x),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
