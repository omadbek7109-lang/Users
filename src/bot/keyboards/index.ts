import type { InlineButton, InlineKeyboardMarkup, ReplyKeyboardMarkup } from '../../types/telegram.js';
import type { StoryDraft, MediaDraft } from '../../services/state-store.js';
import { STORY_PERIODS } from '../../modules/stories/story.service.js';
import { DELETE_PRESETS, type MediaTarget } from '../../modules/timed-media/timed-media.service.js';
import { OPERATION_CODES, OPERATION_LABELS, type AiOperation } from '../../modules/ai-editor/prompts.js';
import type { AiProviderName } from '../../config/env.js';

export const MENU = {
  stories: '📸 Stories Manager',
  cleaner: '🗑 Group Cleaner',
  editor: '✨ AI Message Editor',
  timed: '⏱ Timed Media',
  tasks: '📅 Scheduled Tasks',
  logs: '📊 Activity Logs',
  settings: '⚙️ Settings',
} as const;

const cb = (text: string, data: string): InlineButton => {
  if (Buffer.byteLength(data) > 64) throw new Error(`callback_data too long: ${data}`);
  return { text, callback_data: data };
};
const mark = (on: boolean, label: string) => `${on ? '✅' : '▫️'} ${label}`;

export function mainMenu(): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: MENU.stories }, { text: MENU.cleaner }],
      [{ text: MENU.editor }, { text: MENU.timed }],
      [{ text: MENU.tasks }, { text: MENU.logs }],
      [{ text: MENU.settings }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

export function mediaPickKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [cb('📸 Story qilib joylash', 'mp:story'), cb('⏱ Timed Media', 'mp:timed')],
      [cb('❌ Bekor qilish', 'mp:x')],
    ],
  };
}

export function storyDraftKeyboard(d: StoryDraft): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      STORY_PERIODS.map((p) => cb(`${d.activePeriod === p ? '🔘' : '⚪️'} ${p / 3600}s`, `sd:p:${p}`)),
      [cb(mark(d.postToChatPage, 'Profilda saqlash'), 'sd:page'), cb(mark(d.protectContent, 'Himoyalash'), 'sd:prot')],
      [cb('📝 Caption', 'sd:cap')],
      [cb('🚀 Hozir joylash', 'sd:now'), cb('📅 Rejalashtirish', 'sd:sched')],
      [cb('❌ Bekor qilish', 'sd:x')],
    ],
  };
}

export function storyActionsKeyboard(storyId: string, status: string): InlineKeyboardMarkup {
  if (status === 'posted') {
    return { inline_keyboard: [[cb('✏️ Captionni tahrirlash', `sa:cap:${storyId}`), cb('🗑 O‘chirish', `sa:del:${storyId}`)]] };
  }
  if (status === 'scheduled') return { inline_keyboard: [[cb('🚫 Bekor qilish', `sa:cn:${storyId}`)]] };
  return { inline_keyboard: [] };
}

export function confirmKeyboard(yesData: string, noData: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[cb('✅ Ha, tasdiqlayman', yesData), cb('❌ Yo‘q', noData)]] };
}

export function mediaTargetsKeyboard(targets: MediaTarget[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      ...targets.map((t) => [cb(t.title.slice(0, 60), `md:t:${t.kind === 'business' ? 'b' : 'c'}:${t.chatId}`)]),
      [cb('❌ Bekor qilish', 'md:x')],
    ],
  };
}

export function deleteLabel(s: number | null): string {
  if (s === null) return 'Yo‘q';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${s / 60}d`;
  return `${s / 3600}soat`;
}

export function mediaDraftKeyboard(d: MediaDraft): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      DELETE_PRESETS.map((p) => cb(`${d.deleteAfter === p ? '🔘' : '⚪️'} ${deleteLabel(p)}`, `md:d:${p ?? 0}`)),
      [cb(mark(d.hasSpoiler, 'Spoiler (blur)'), 'md:sp'), cb(mark(d.protectContent, 'Saqlashni taqiqlash'), 'md:prot')],
      [cb('📝 Caption', 'md:cap')],
      [cb('🚀 Hozir yuborish', 'md:now'), cb('📅 Vaqt belgilash', 'md:sched')],
      [cb('❌ Bekor qilish', 'md:x')],
    ],
  };
}

const op = (o: AiOperation, id: string, label = OPERATION_LABELS[o]) => cb(label, `ai:${OPERATION_CODES[o]}:${id}`);

export function aiOperationsKeyboard(editId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [op('fix', editId), op('beautify', editId)],
      [op('shorten', editId), op('expand', editId)],
      [op('formal', editId), op('casual', editId)],
      [cb('🌐 Tarjima', `ai:tl:${editId}`)],
    ],
  };
}

export function aiTranslateKeyboard(editId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [op('tr_uz', editId, '🇺🇿 O‘zbek'), op('tr_ru', editId, '🇷🇺 Rus'), op('tr_en', editId, '🇬🇧 Ingliz')],
      [cb('⬅️ Orqaga', `ai:bk:${editId}`)],
    ],
  };
}

/** copy_text buttons are limited to 256 chars — longer texts get a "send as code block" button. */
export function aiResultKeyboard(editId: string, resultText: string): InlineKeyboardMarkup {
  const copy: InlineButton = resultText.length <= 256
    ? { text: '📋 Nusxalash', copy_text: { text: resultText } }
    : cb('📋 Nusxalash', `ai:cp:${editId}`);
  return {
    inline_keyboard: [
      [cb('🔁 Qayta tahrirlash', `ai:re:${editId}`), copy],
      [cb('🌐 Tarjima', `ai:tl:${editId}`), op('shorten', editId)],
      [cb('📄 Original matn', `ai:or:${editId}`), cb('🔍 Taqqoslash', `ai:cm:${editId}`)],
      [cb('🛠 Boshqa amallar', `ai:bk:${editId}`)],
    ],
  };
}

export function settingsKeyboard(available: AiProviderName[], active: AiProviderName): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      available.map((p) => cb(`${p === active ? '🔘' : '⚪️'} ${p === 'claude' ? 'Claude' : 'OpenAI'}`, `st:ai:${p}`)),
      [cb('🔄 Business ulanishni tekshirish', 'st:bc')],
    ],
  };
}

export function tasksKeyboard(items: Array<{ label: string; data: string }>): InlineKeyboardMarkup {
  return {
    inline_keyboard: [...items.map((i) => [cb(i.label.slice(0, 60), i.data)]), [cb('🔄 Yangilash', 'tk:r')]],
  };
}
