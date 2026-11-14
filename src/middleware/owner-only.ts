import type { TgUpdate } from '../types/telegram.js';

/** The Telegram user who caused this update (if any). */
export function actorId(u: TgUpdate): number | undefined {
  return (
    u.message?.from?.id ??
    u.edited_message?.from?.id ??
    u.callback_query?.from.id ??
    u.my_chat_member?.from.id ??
    u.business_connection?.user.id ??
    u.business_message?.from?.id ??
    u.edited_business_message?.from?.id
  );
}

export function isOwner(u: TgUpdate, ownerId: number): boolean {
  return actorId(u) === ownerId;
}

/**
 * Which updates may be processed when the actor is NOT the owner:
 *  - group messages: only to record metadata for the cleaner (no commands);
 *  - business messages from the owner's clients: only to remember the chat (24h reply window);
 *  - my_chat_member: so the bot can leave groups it was added to by strangers.
 * Everything else from strangers is rejected.
 */
export function strangerAllowance(u: TgUpdate): 'track-group' | 'track-business' | 'membership' | 'deny' {
  if (u.message && (u.message.chat.type === 'group' || u.message.chat.type === 'supergroup')) return 'track-group';
  if (u.business_message) return 'track-business';
  if (u.my_chat_member) return 'membership';
  return 'deny';
}
