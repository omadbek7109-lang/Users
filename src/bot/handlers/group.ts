import type { BotContext } from '../context.js';
import type { TgMessage } from '../../types/telegram.js';
import { isForThisBot, parseCommand } from '../commands/parse.js';
import { confirmKeyboard } from '../keyboards/index.js';
import type { DeleteMode } from '../../database/types.js';

const GROUP_COMMANDS = new Set(['delete', 'cleanlinks', 'clear', 'cancel']);

/** Called for every group message (any sender): records metadata so it can be cleaned later. */
export async function trackGroupMessage(c: BotContext, m: TgMessage): Promise<void> {
  try {
    await c.d.cleaner.track(m);
  } catch (err) {
    c.d.logger.warn('track failed', { chat: m.chat.id, err });
  }
}

/** Owner commands in a group. Strangers' commands never reach here. */
export async function handleGroupCommand(c: BotContext, m: TgMessage): Promise<void> {
  const cmd = parseCommand(m.text);
  if (!cmd || !GROUP_COMMANDS.has(cmd.name)) return;
  if (!isForThisBot(cmd, await c.username())) return;
  const owner = await c.owner();
  const chatId = m.chat.id;

  if (cmd.name === 'cancel') {
    const n = await c.d.cleaner.cancel(owner, chatId);
    await c.send(chatId, n ? '🚫 Kutilayotgan o‘chirish bekor qilindi.' : 'Bekor qilinadigan operatsiya yo‘q.');
    return;
  }

  let mode: DeleteMode;
  let count: number | undefined;
  if (cmd.name === 'delete') {
    mode = 'last_n';
    count = Number(cmd.args[0]);
  } else if (cmd.name === 'cleanlinks') mode = 'links';
  else mode = 'clear';

  const prep = await c.d.cleaner.prepare(owner, chatId, mode, count, [m.message_id]);
  if (!prep.ok) {
    await c.send(chatId, `⚠️ ${prep.reason}`);
    return;
  }
  const n = prep.task.message_ids.length;
  const what =
    mode === 'last_n' ? `oxirgi <b>${n}</b> ta kuzatilgan xabar` :
    mode === 'links' ? `<b>${n}</b> ta linkli xabar` :
    `bot kuzatgan (48 soat ichidagi) <b>BARCHA ${n}</b> ta xabar`;
  await c.send(
    chatId,
    `🗑 ${what} o‘chiriladi.\nTasdiqlaysizmi? (10 daqiqa amal qiladi, /cancel — bekor qilish)`,
    confirmKeyboard(`gc:ok:${prep.task.id}`, `gc:no:${prep.task.id}`),
    true,
  );
}
