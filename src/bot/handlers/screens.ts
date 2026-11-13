import type { BotContext } from '../context.js';
import type { InlineKeyboardMarkup } from '../../types/telegram.js';
import { connectionProblemText } from '../../modules/stories/story.service.js';
import { deleteLabel, settingsKeyboard, tasksKeyboard } from '../keyboards/index.js';
import { escapeHtml, truncate } from '../../utils/html.js';
import type { MediaTaskRow } from '../../database/types.js';
import type { MediaDraft, StoryDraft } from '../../services/state-store.js';

const MEDIA_STATUS: Record<MediaTaskRow['status'], string> = {
  scheduled: '📅 Kutilmoqda', sent: '✅ Yuborilgan', deleted: '🗑 O‘chirilgan', failed: '❌ Xato', cancelled: '🚫 Bekor',
};

export async function storiesScreen(c: BotContext, chatId: number) {
  const owner = await c.owner();
  const st = await c.d.stories.connectionStatus(owner);
  const lines = ['<b>📸 Stories Manager</b>', ''];
  if (st.problem) lines.push(`⚠️ ${escapeHtml(connectionProblemText(st.problem))}`);
  else lines.push('✅ Telegram Business ulangan, "Manage stories" huquqi bor.');
  lines.push('', 'Story joylash uchun menga <b>rasm yoki video</b> yuboring.',
    '<i>Eslatma: Bot API story privacy (kimlar ko‘radi) sozlamasini bermaydi — faqat "profilda saqlash" va "himoyalash" mavjud. Story ko‘rishlar sonini olish metodi ham yo‘q.</i>');

  const recent = await c.d.repo.listStories(owner.id, ['scheduled', 'posting', 'posted', 'failed'], 5);
  const kb: InlineKeyboardMarkup = { inline_keyboard: [] };
  recent.forEach((s, i) => {
    lines.push('', `<b>#${i + 1}</b> ${escapeHtml(c.d.stories.describe(s, c.fmt))}`);
    if (s.status === 'posted') kb.inline_keyboard.push([
      { text: `✏️ #${i + 1} caption`, callback_data: `sa:cap:${s.id}` },
      { text: `🗑 #${i + 1} o‘chirish`, callback_data: `sa:del:${s.id}` },
    ]);
    if (s.status === 'scheduled') kb.inline_keyboard.push([{ text: `🚫 #${i + 1} bekor qilish`, callback_data: `sa:cn:${s.id}` }]);
  });
  await c.send(chatId, truncate(lines.join('\n')), kb.inline_keyboard.length ? kb : undefined, true);
}

export async function cleanerScreen(c: BotContext, chatId: number) {
  const owner = await c.owner();
  const groups = await c.d.repo.listGroups(owner.id);
  const lines = [
    '<b>🗑 Group Cleaner</b>', '',
    '1) Botni guruhga <b>o‘zingiz</b> qo‘shing (boshqalar qo‘shsa bot guruhdan chiqib ketadi).',
    '2) Botni admin qiling va "Delete messages" huquqini bering.',
    '3) Guruhda buyruqlar: <code>/delete 10</code>, <code>/cleanlinks</code>, <code>/clear</code>, <code>/cancel</code>',
    '',
    '<i>Cheklovlar: bot faqat o‘zi guruhga qo‘shilgandan keyin <b>ko‘rgan</b> xabarlarni biladi; Telegram faqat 48 soatdan yosh xabarlarni o‘chirishga ruxsat beradi. Har bir o‘chirish tasdiqlash talab qiladi.</i>',
    '', '<b>Guruhlar:</b>',
  ];
  if (!groups.length) lines.push('— hali guruh yo‘q');
  for (const g of groups) lines.push(`${g.bot_can_delete ? '✅' : '⚠️'} ${escapeHtml(g.title ?? String(g.chat_id))}${g.bot_can_delete ? '' : ' — o‘chirish huquqi yo‘q'}`);
  await c.send(chatId, lines.join('\n'), undefined, true);
}

export async function editorScreen(c: BotContext, chatId: number) {
  const owner = await c.owner();
  const provider = c.d.ai.get(owner.settings?.aiProvider).name;
  await c.send(chatId, [
    '<b>✨ AI Message Editor</b>', '',
    'Menga istalgan matnni yuboring — imloni tuzataman, chiroyli yozaman, qisqartiraman/kengaytiraman, uslubini o‘zgartiraman yoki tarjima qilaman (uz/ru/en).',
    '', `Joriy AI: <b>${provider === 'claude' ? 'Claude' : 'OpenAI'}</b> (⚙️ Settings’da almashtiriladi)`,
  ].join('\n'), undefined, true);
}

export async function timedScreen(c: BotContext, chatId: number) {
  const owner = await c.owner();
  const recent = await c.d.repo.listMediaTasks(owner.id, ['scheduled', 'sent', 'deleted', 'failed', 'cancelled'], 8);
  const lines = [
    '<b>⏱ Timed Media</b>', '',
    'Menga <b>rasm yoki video</b> yuboring va "⏱ Timed Media"ni tanlang: qayerga, qachon yuborish va necha vaqtdan keyin o‘chirishni belgilaysiz.',
    '',
    '<i>Muhim: bu <b>vaqt bo‘yicha o‘chirish</b>. Bot API orqali "bir marta ko‘riladigan" (view-once) media yuborib bo‘lmaydi va qabul qiluvchi mediani ko‘rganini aniqlash imkoni yo‘q. Mavjud himoyalar: spoiler (blur) va saqlash/forwardni taqiqlash.</i>',
  ];
  if (recent.length) lines.push('', '<b>Tarix:</b>');
  for (const t of recent) {
    lines.push(`${MEDIA_STATUS[t.status]} · ${escapeHtml(t.target_title ?? String(t.target_chat_id))} · ${c.fmt(t.sent_at ?? t.send_at)}` +
      (t.delete_after_seconds ? ` · auto-delete ${deleteLabel(t.delete_after_seconds)}` : ''));
  }
  await c.send(chatId, truncate(lines.join('\n')), undefined, true);
}

export async function tasksScreen(c: BotContext, chatId: number, editMessageId?: number) {
  const owner = await c.owner();
  const stories = await c.d.repo.listStories(owner.id, ['scheduled'], 10);
  const media = await c.d.repo.listMediaTasks(owner.id, ['scheduled', 'sent'], 20);
  const pendingDelete = media.filter((m) => m.status === 'sent' && m.delete_at);
  const pendingSend = media.filter((m) => m.status === 'scheduled');
  const lines = ['<b>📅 Scheduled Tasks</b>'];
  const items: Array<{ label: string; data: string }> = [];
  if (!stories.length && !pendingSend.length && !pendingDelete.length) lines.push('', 'Rejalashtirilgan vazifa yo‘q.');
  if (stories.length) lines.push('', '<b>Stories:</b>');
  stories.forEach((s, i) => {
    lines.push(`S${i + 1}. ${s.media_type === 'photo' ? 'Rasm' : 'Video'} → ${c.fmt(s.scheduled_at)}`);
    items.push({ label: `🚫 S${i + 1} storyni bekor qilish`, data: `tk:s:${s.id}` });
  });
  if (pendingSend.length) lines.push('', '<b>Media yuborish:</b>');
  pendingSend.forEach((m, i) => {
    lines.push(`M${i + 1}. ${escapeHtml(m.target_title ?? String(m.target_chat_id))} → ${c.fmt(m.send_at)}`);
    items.push({ label: `🚫 M${i + 1} yuborishni bekor qilish`, data: `tk:m:${m.id}` });
  });
  if (pendingDelete.length) lines.push('', '<b>Auto-delete kutilmoqda:</b>');
  pendingDelete.forEach((m, i) => {
    lines.push(`D${i + 1}. ${escapeHtml(m.target_title ?? String(m.target_chat_id))} → ${c.fmt(m.delete_at!)}`);
    items.push({ label: `♻️ D${i + 1} o‘chirmaslik`, data: `tk:m:${m.id}` });
  });
  const text = truncate(lines.join('\n'));
  if (editMessageId) await c.edit(chatId, editMessageId, text, tasksKeyboard(items), true);
  else await c.send(chatId, text, tasksKeyboard(items), true);
}

export async function logsScreen(c: BotContext, chatId: number) {
  const owner = await c.owner();
  const logs = await c.d.repo.listLogs(owner.id, 15);
  const icon = { ok: '✅', error: '❌', info: 'ℹ️' } as const;
  const lines = ['<b>📊 Activity Logs</b> (so‘nggi 15)', ''];
  if (!logs.length) lines.push('Hali hech narsa yo‘q.');
  for (const l of logs) lines.push(`${icon[l.status]} ${c.fmt(l.created_at)} · ${escapeHtml(l.module)} · ${escapeHtml(l.action)}`);
  await c.send(chatId, lines.join('\n'), undefined, true);
}

export async function settingsScreen(c: BotContext, chatId: number, editMessageId?: number) {
  const owner = await c.owner();
  const active = c.d.ai.get(owner.settings?.aiProvider).name;
  const conn = await c.d.repo.getActiveBusinessConnection(owner.id);
  const r = conn?.rights ?? {};
  const yn = (b?: boolean) => (b ? '✅' : '❌');
  const lines = [
    '<b>⚙️ Settings</b>', '',
    `🤖 AI provayder: <b>${active === 'claude' ? 'Claude' : 'OpenAI'}</b>`,
    `🕒 Vaqt zonasi: ${escapeHtml(c.d.timezone)}`,
    '',
    `💼 Telegram Business: ${conn ? (conn.is_enabled ? 'ulangan' : 'o‘chirilgan') : 'ulanmagan'}`,
  ];
  if (conn) {
    lines.push(
      `  ${yn(r.can_manage_stories)} Stories boshqarish`,
      `  ${yn(r.can_reply)} Xabar yuborish (24 soat qoidasi)`,
      `  ${yn(r.can_delete_outgoing_messages ?? r.can_delete_sent_messages)} O‘zi yuborganini o‘chirish`,
    );
  }
  const kb = settingsKeyboard(c.d.ai.available(), active);
  if (editMessageId) await c.edit(chatId, editMessageId, lines.join('\n'), kb, true);
  else await c.send(chatId, lines.join('\n'), kb, true);
}

export function storyDraftText(d: StoryDraft): string {
  return [
    '<b>📸 Yangi story</b>',
    `Media: ${d.media.type === 'photo' ? 'rasm' : `video${d.media.duration ? ` (${d.media.duration}s)` : ''}`}`,
    `Davomiylik: ${d.activePeriod / 3600} soat`,
    `Profilda saqlash: ${d.postToChatPage ? 'ha' : 'yo‘q'} · Himoyalash: ${d.protectContent ? 'ha' : 'yo‘q'}`,
    `Caption: ${d.caption ? escapeHtml(truncate(d.caption, 300)) : '<i>yo‘q</i>'}`,
  ].join('\n');
}

export function mediaDraftText(d: MediaDraft): string {
  return [
    '<b>⏱ Timed Media</b>',
    `Qayerga: ${escapeHtml(d.targetTitle ?? '—')}`,
    `Auto-delete: ${deleteLabel(d.deleteAfter)}`,
    `Spoiler: ${d.hasSpoiler ? 'ha' : 'yo‘q'} · Saqlashni taqiqlash: ${d.protectContent ? 'ha' : 'yo‘q'}`,
    `Caption: ${d.caption ? escapeHtml(truncate(d.caption, 300)) : '<i>yo‘q</i>'}`,
    '',
    '<i>Ko‘rilganini aniqlab bo‘lmaydi — o‘chirish faqat vaqt bo‘yicha.</i>',
  ].join('\n');
}
