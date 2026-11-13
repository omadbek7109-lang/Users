import type { BotContext } from '../context.js';
import type { TgBusinessConnection, TgMessage } from '../../types/telegram.js';

/** business_connection update: the owner connected/disconnected the bot or changed its rights. */
export async function handleBusinessConnection(c: BotContext, bc: TgBusinessConnection): Promise<void> {
  if (bc.user.id !== c.d.ownerId) {
    // Somebody else tried to connect their business account — ignore and never store it.
    c.d.logger.warn('foreign business connection ignored');
    await c.d.repo.log({ user_id: (await c.owner()).id, module: 'security', action: 'foreign-business-connection', status: 'info' });
    return;
  }
  const owner = await c.owner();
  await c.d.repo.upsertBusinessConnection({
    id: bc.id,
    user_id: owner.id,
    user_chat_id: bc.user_chat_id,
    rights: bc.rights ?? {},
    is_enabled: bc.is_enabled,
    connected_at: new Date(bc.date * 1000).toISOString(),
  });
  await c.d.repo.log({ user_id: owner.id, module: 'business', action: bc.is_enabled ? 'connected' : 'disconnected', status: 'ok' });
  const r = bc.rights ?? {};
  const yn = (b?: boolean) => (b ? '✅' : '❌');
  await c.send(
    c.d.ownerId,
    bc.is_enabled
      ? [
          '💼 Telegram Business ulandi.',
          `${yn(r.can_manage_stories)} Stories boshqarish`,
          `${yn(r.can_reply)} Xabar yuborish`,
          `${yn(r.can_delete_outgoing_messages ?? r.can_delete_sent_messages)} O‘zi yuborganini o‘chirish`,
          r.can_manage_stories ? '' : '\nStory joylash uchun bot huquqlarida "Manage stories"ni yoqing.',
        ].join('\n').trim()
      : '💼 Telegram Business ulanishi o‘chirildi.',
  );
}

/** Incoming business messages are only used to remember chats (24h can_reply window). Content is not stored. */
export async function handleBusinessMessage(c: BotContext, m: TgMessage): Promise<void> {
  if (!m.business_connection_id || m.from?.id === c.d.ownerId) return;
  const conn = await c.d.repo.getBusinessConnection(m.business_connection_id);
  if (!conn) return;
  const owner = await c.owner();
  if (conn.user_id !== owner.id) return;
  const title = m.chat.first_name ?? m.chat.title ?? (m.chat.username ? `@${m.chat.username}` : null);
  await c.d.repo.touchBusinessChat({
    business_connection_id: conn.id,
    chat_id: m.chat.id,
    title,
    last_incoming_at: new Date(m.date * 1000).toISOString(),
  });
}
