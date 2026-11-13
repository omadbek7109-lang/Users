import type { BotContext } from '../context.js';
import type { TgMessage } from '../../types/telegram.js';
import type { PendingMedia } from '../../services/state-store.js';
import { MENU, aiOperationsKeyboard, mainMenu, mediaDraftKeyboard, mediaPickKeyboard, storyActionsKeyboard, storyDraftKeyboard } from '../keyboards/index.js';
import { parseCommand } from '../commands/parse.js';
import {
  cleanerScreen, editorScreen, logsScreen, mediaDraftText, settingsScreen, storiesScreen, storyDraftText, tasksScreen, timedScreen,
} from './screens.js';
import { parseWhen } from '../../utils/time.js';
import { escapeHtml, truncate } from '../../utils/html.js';
import { STORY_CAPTION_MAX } from '../../modules/stories/story.service.js';
import { MEDIA_CAPTION_MAX } from '../../modules/timed-media/timed-media.service.js';

const HELP = [
  '<b>Personal Telegram AI Assistant</b>',
  '',
  '📸 <b>Stories</b> — rasm/video yuboring → "Story" → joylash yoki rejalashtirish (Telegram Business orqali).',
  '🗑 <b>Group Cleaner</b> — guruhda /delete N, /cleanlinks, /clear, /cancel.',
  '✨ <b>AI Editor</b> — oddiy matn yuboring.',
  '⏱ <b>Timed Media</b> — rasm/video yuboring → "Timed Media".',
  '',
  'Vaqt formatlari: <code>+10m</code>, <code>+2h</code>, <code>30 daqiqa</code>, <code>18:30</code>, <code>2026-11-20 09:00</code>',
  '/cancel — joriy amalni bekor qilish',
].join('\n');

export function extractMedia(m: TgMessage): PendingMedia | null {
  if (m.photo?.length) {
    const best = m.photo[m.photo.length - 1]!;
    return { type: 'photo', fileId: best.file_id, caption: m.caption, fileSize: best.file_size };
  }
  if (m.video) return { type: 'video', fileId: m.video.file_id, caption: m.caption, duration: m.video.duration, fileSize: m.video.file_size };
  return null;
}

export async function handlePrivateMessage(c: BotContext, m: TgMessage): Promise<void> {
  const chatId = m.chat.id;
  const owner = await c.owner();
  const cmd = parseCommand(m.text);

  if (cmd) {
    switch (cmd.name) {
      case 'start':
      case 'menu':
        await c.d.state.clear(c.d.ownerId);
        await c.send(chatId, `Salom${m.from?.first_name ? `, ${escapeHtml(m.from.first_name)}` : ''}! Bo‘limni tanlang 👇`, mainMenu(), true);
        return;
      case 'help':
        await c.send(chatId, HELP, mainMenu(), true);
        return;
      case 'cancel':
        await c.d.state.clear(c.d.ownerId);
        await c.send(chatId, '🚫 Joriy amal bekor qilindi.', mainMenu());
        return;
      case 'status':
        await storiesScreen(c, chatId);
        return;
      default:
        await c.send(chatId, 'Noma’lum buyruq. /help', mainMenu());
        return;
    }
  }

  const menuHandlers: Record<string, () => Promise<void>> = {
    [MENU.stories]: () => storiesScreen(c, chatId),
    [MENU.cleaner]: () => cleanerScreen(c, chatId),
    [MENU.editor]: () => editorScreen(c, chatId),
    [MENU.timed]: () => timedScreen(c, chatId),
    [MENU.tasks]: () => tasksScreen(c, chatId),
    [MENU.logs]: () => logsScreen(c, chatId),
    [MENU.settings]: () => settingsScreen(c, chatId),
  };
  if (m.text && menuHandlers[m.text]) {
    await c.d.state.clear(c.d.ownerId);
    await menuHandlers[m.text]!();
    return;
  }

  const media = extractMedia(m);
  if (media) {
    await c.d.state.set(c.d.ownerId, { kind: 'media_pick', media });
    await c.send(chatId, 'Bu media bilan nima qilamiz?', mediaPickKeyboard());
    return;
  }
  if (m.photo === undefined && m.video === undefined && m.text === undefined) {
    await c.send(chatId, 'Men faqat matn, rasm va video bilan ishlayman.');
    return;
  }

  const text = m.text!;
  const state = await c.d.state.get(c.d.ownerId);

  if (state.kind === 'story_draft' && state.awaiting === 'caption') {
    const caption = text === '-' ? '' : text;
    if (caption.length > STORY_CAPTION_MAX) {
      await c.send(chatId, `Caption ${STORY_CAPTION_MAX} belgidan oshmasin. Qayta yuboring.`);
      return;
    }
    const draft = { ...state.draft, caption };
    await c.d.state.set(c.d.ownerId, { kind: 'story_draft', draft });
    await c.send(chatId, storyDraftText(draft), storyDraftKeyboard(draft), true);
    return;
  }
  if (state.kind === 'story_draft' && state.awaiting === 'time') {
    const at = parseWhen(text, c.now(), c.d.timezone);
    if (!at) {
      await c.send(chatId, 'Vaqtni tushunmadim. Masalan: <code>+30m</code>, <code>18:30</code>, <code>2026-11-20 09:00</code>', undefined, true);
      return;
    }
    const row = await c.d.stories.schedule(owner, state.draft, at);
    await c.d.state.clear(c.d.ownerId);
    await c.send(chatId, `📅 Story rejalashtirildi: <b>${c.fmt(row.scheduled_at)}</b>`, storyActionsKeyboard(row.id, row.status), true);
    return;
  }
  if (state.kind === 'story_edit_caption') {
    await c.send(chatId, '⏳ Story yangilanmoqda…');
    const row = await c.d.stories.editCaption(owner, state.storyId, text === '-' ? '' : text);
    await c.d.state.clear(c.d.ownerId);
    await c.send(chatId, '✅ Story caption yangilandi.', storyActionsKeyboard(row.id, row.status));
    return;
  }
  if (state.kind === 'media_draft' && state.awaiting === 'caption') {
    const caption = text === '-' ? '' : text;
    if (caption.length > MEDIA_CAPTION_MAX) {
      await c.send(chatId, `Caption ${MEDIA_CAPTION_MAX} belgidan oshmasin. Qayta yuboring.`);
      return;
    }
    const draft = { ...state.draft, caption };
    await c.d.state.set(c.d.ownerId, { kind: 'media_draft', draft });
    await c.send(chatId, mediaDraftText(draft), mediaDraftKeyboard(draft), true);
    return;
  }
  if (state.kind === 'media_draft' && state.awaiting === 'time') {
    const at = parseWhen(text, c.now(), c.d.timezone);
    if (!at) {
      await c.send(chatId, 'Vaqtni tushunmadim. Masalan: <code>+10m</code>, <code>18:30</code>', undefined, true);
      return;
    }
    const row = await c.d.media.create(owner, state.draft, at);
    await c.d.state.clear(c.d.ownerId);
    await c.send(chatId, `📅 Media rejalashtirildi: <b>${c.fmt(row.send_at)}</b> → ${escapeHtml(row.target_title ?? '')}`, undefined, true);
    return;
  }

  // Default: plain text → AI Message Editor
  const edit = await c.d.editor.start(owner, text);
  await c.send(chatId, `<b>✨ Matn qabul qilindi.</b> Nima qilamiz?\n\n${escapeHtml(truncate(edit.result_text, 3500))}`, aiOperationsKeyboard(edit.id), true);
}

export function storyDraftFromMedia(media: PendingMedia) {
  return {
    media,
    caption: media.caption ?? '',
    activePeriod: 86400,
    postToChatPage: false,
    protectContent: false,
  };
}
