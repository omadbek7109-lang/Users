export interface ParsedCommand {
  name: string;
  args: string[];
  target?: string;
}

/** Parses "/cmd@BotName arg1 arg2". Returns null for non-commands. */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text || !text.startsWith('/')) return null;
  const [head, ...args] = text.trim().split(/\s+/);
  const m = head!.match(/^\/([a-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?$/i);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args, target: m[2] };
}

export function isForThisBot(cmd: ParsedCommand, botUsername: string | undefined): boolean {
  return !cmd.target || (!!botUsername && cmd.target.toLowerCase() === botUsername.toLowerCase());
}
