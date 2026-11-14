import type { BotContext } from '../context.js';
import type { TgCallbackQuery } from '../../types/telegram.js';
import {
  aiOperationsKeyboard, aiResultKeyboard, aiTranslateKeyboard, confirmKeyboard, mediaDraftKeyboard, mediaTargetsKeyboard,
  storyDraftKeyboard,
} from '../keyboards/index.js';
import { mediaDraftText, settingsScreen, storyDraftText, tasksScreen } from './screens.js';
import { storyDraftFromMedia } from './private.js';
import { CODE_TO_OPERATION, OPERATION_LABELS } from '../../modules/ai-editor/prompts.js';
import { STORY_PERIODS } from '../../modules/stories/story.service.js';
import { DELETE_PRESETS } from '../../modules/timed-media/timed-media.service.js';
import { MAX_DOWNLOAD_BYTES } from '../../services/telegram-client.js';
import { escapeHtml, truncate } from '../../utils/html.js';
import type { AiProviderName } from '../../config/env.js';

export async function handleCallback(c: BotContext, q: TgCallbackQuery): Promise<void> {
  const data = q.data ?? '';
  const msg = q.message;
  const chatId = msg?.chat.id ?? c.d.ownerId;
  const msgId = msg?.message_id;
  const owner = await c.owner();
  const [ns, action, arg] = splitData(data);
  let answered = false;
  const answer = async (text?: string, alert = false) => {
    if (answered) return;
    answered = true;
    await c.d.tg.answerCallbackQuery(q.id, text, alert).catch(() => undefined);
  };

  try {
    switch (ns) {
      // ---------- media picked: story or timed ----------
      case 'mp': {
        const st = await c.d.state.get(c.d.ownerId);
        if (action === 'x' || st.kind !== 'media_pick') {
          await c.d.state.clear(c.d.ownerId);
          await answer(st.kind !== 'media_pick' && action !== 'x' ? 'Eskirgan. Mediani qayta yuboring.' : 'Bekor qilindi');
          if (msgId) await c.edit(chatId, msgId, '🚫 Bekor qilindi.');
          return;
        }
        if (action === 'story') {
          if (st.media.fileSize && st.media.fileSize > MAX_DOWNLOAD_BYTES) {
            await answer('Fayl 20 MB dan katta — bot uni story uchun yuklab ololmaydi.', true);
            return;
          }
          const draft = storyDraftFromMedia(st.media);
          await c.d.state.set(c.d.ownerId, { kind: 'story_draft', draft });
          await answer();
          if (msgId) await c.edit(chatId, msgId, storyDraftText(draft), storyDraftKeyboard(draft), true);
          return;
        }
        if (action === 'timed') {
          const targets = await c.d.media.listTargets(owner);
          await c.d.state.set(c.d.ownerId, {
            kind: 'media_draft',
            draft: { media: st.media, caption: st.media.caption ?? '', deleteAfter: null, hasSpoiler: false, protectContent: false },
          });
          await answer();
          if (msgId) await c.edit(chatId, msgId, 'Qayerga yuboramiz?\n<i>Business chatlar faqat so‘nggi 24 soatda sizga yozgan bo‘lsa ko‘rinadi.</i>', mediaTargetsKeyboard(targets), true);
          return;
        }
        break;
      }

      // ---------- story draft ----------
      case 'sd': {
        const st = await c.d.state.get(c.d.ownerId);
        if (st.kind !== 'story_draft') {
          await answer('Eskirgan. Mediani qayta yuboring.');
          return;
        }
        const d = { ...st.draft };
        if (action === 'x') {
          await c.d.state.clear(c.d.ownerId);
          await answer('Bekor qilindi');
          if (msgId) await c.edit(chatId, msgId, '🚫 Story bekor qilindi.');
          return;
        }
        if (action === 'p' && (STORY_PERIODS as readonly number[]).includes(Number(arg))) d.activePeriod = Number(arg);
        if (action === 'page') d.postToChatPage = !d.postToChatPage;
        if (action === 'prot') d.protectContent = !d.protectContent;
        if (action === 'cap') {
          await c.d.state.set(c.d.ownerId, { kind: 'story_draft', draft: d, awaiting: 'caption' });
          await answer();
          await c.send(chatId, 'Yangi caption yuboring (olib tashlash uchun "-" yuboring):');
          return;
        }
        if (action === 'sched') {
          await c.d.state.set(c.d.ownerId, { kind: 'story_draft', draft: d, awaiting: 'time' });
          await answer();
          await c.send(chatId, `Qachon joylaymiz? (${c.d.timezone})\nMasalan: <code>+30m</code>, <code>18:30</code>, <code>2026-11-20 09:00</code>`, undefined, true);
          return;
        }
        if (action === 'now') {
          await c.d.stories.postNow(owner, d);
          await c.d.state.clear(c.d.ownerId);
          await answer('Navbatga qo‘yildi');
          if (msgId) {
            await c.edit(chatId, msgId, `${storyDraftText(d)}\n\n⏳ Media story formatiga o‘tkazilmoqda va joylanmoqda. Tayyor bo‘lgach xabar beraman.`, undefined, true);
          }
          return;
        }
        await c.d.state.set(c.d.ownerId, { kind: 'story_draft', draft: d });
        await answer();
        if (msgId) await c.edit(chatId, msgId, storyDraftText(d), storyDraftKeyboard(d), true);
        return;
      }

      // ---------- story actions ----------
      case 'sa': {
        if (!arg) break;
        if (action === 'cn') {
          await c.d.stories.cancel(owner, arg);
          await answer('Bekor qilindi');
          await c.send(chatId, '🚫 Rejalashtirilgan story bekor qilindi.');
          return;
        }
        if (action === 'del') {
          await answer();
          await c.send(chatId, 'Storyni o‘chirishni tasdiqlaysizmi?', confirmKeyboard(`sa:dy:${arg}`, `sa:dn:${arg}`));
          return;
        }
        if (action === 'dy') {
          await c.d.stories.deletePosted(owner, arg);
          await answer('O‘chirildi');
          if (msgId) await c.edit(chatId, msgId, '🗑 Story o‘chirildi.');
          return;
        }
        if (action === 'dn') {
          await answer('Bekor');
          if (msgId) await c.edit(chatId, msgId, 'Story o‘chirilmadi.');
          return;
        }
        if (action === 'cap') {
          await c.d.state.set(c.d.ownerId, { kind: 'story_edit_caption', storyId: arg });
          await answer();
          await c.send(chatId, 'Story uchun yangi caption yuboring ("-" — captionsiz):');
          return;
        }
        break;
      }

      // ---------- timed media draft ----------
      case 'md': {
        const st = await c.d.state.get(c.d.ownerId);
        if (st.kind !== 'media_draft') {
          await answer('Eskirgan. Mediani qayta yuboring.');
          return;
        }
        const d = { ...st.draft };
        if (action === 'x') {
          await c.d.state.clear(c.d.ownerId);
          await answer('Bekor qilindi');
          if (msgId) await c.edit(chatId, msgId, '🚫 Bekor qilindi.');
          return;
        }
        if (action === 't') {
          const [kind, idRaw] = (arg ?? '').split(':');
          const targets = await c.d.media.listTargets(owner);
          const t = targets.find((x) => String(x.chatId) === idRaw && (kind === 'b') === (x.kind === 'business'));
          if (!t) {
            await answer('Bu chat endi mavjud emas', true);
            return;
          }
          d.targetChatId = t.chatId;
          d.targetTitle = t.title;
          d.businessConnectionId = t.businessConnectionId;
        }
        if (action === 'd') {
          const v = Number(arg) || null;
          if (DELETE_PRESETS.includes(v)) d.deleteAfter = v;
        }
        if (action === 'sp') d.hasSpoiler = !d.hasSpoiler;
        if (action === 'prot') d.protectContent = !d.protectContent;
        if (action === 'cap') {
          await c.d.state.set(c.d.ownerId, { kind: 'media_draft', draft: d, awaiting: 'caption' });
          await answer();
          await c.send(chatId, 'Caption yuboring ("-" — captionsiz):');
          return;
        }
        if (action === 'sched') {
          await c.d.state.set(c.d.ownerId, { kind: 'media_draft', draft: d, awaiting: 'time' });
          await answer();
          await c.send(chatId, `Qachon yuboramiz? (${c.d.timezone})\nMasalan: <code>+10m</code>, <code>18:30</code>`, undefined, true);
          return;
        }
        if (action === 'now') {
          const row = await c.d.media.create(owner, d, null);
          await c.d.state.clear(c.d.ownerId);
          await answer('Navbatga qo‘yildi');
          if (msgId) await c.edit(chatId, msgId, `${mediaDraftText(d)}\n\n🚀 Yuborilmoqda… (vazifa: ${row.id.slice(0, 8)})`, undefined, true);
          return;
        }
        await c.d.state.set(c.d.ownerId, { kind: 'media_draft', draft: d });
        await answer();
        if (msgId) await c.edit(chatId, msgId, mediaDraftText(d), mediaDraftKeyboard(d), true);
        return;
      }

      // ---------- AI editor ----------
      case 'ai': {
        if (!arg) break;
        if (action === 'tl') {
          await answer();
          if (msgId) await c.d.tg.call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: aiTranslateKeyboard(arg) }).catch(() => undefined);
          return;
        }
        if (action === 'bk') {
          await answer();
          if (msgId) await c.d.tg.call('editMessageReplyMarkup', { chat_id: chatId, message_id: msgId, reply_markup: aiOperationsKeyboard(arg) }).catch(() => undefined);
          return;
        }
        if (action === 'cp') {
          const e = await c.d.editor.get(owner, arg);
          await answer();
          await c.send(chatId, `<pre>${escapeHtml(truncate(e.result_text, 3900))}</pre>`, undefined, true);
          return;
        }
        if (action === 'or') {
          const root = await c.d.editor.original(owner, arg);
          await answer();
          await c.send(chatId, `<b>📄 Original matn:</b>\n\n${escapeHtml(truncate(root.result_text, 3800))}`, aiOperationsKeyboard(root.id), true);
          return;
        }
        if (action === 'cm') {
          const html = await c.d.editor.compare(owner, arg);
          await answer();
          await c.send(chatId, truncate(html, 4000), undefined, true);
          return;
        }
        const op = action === 're' ? 're' : CODE_TO_OPERATION[action ?? ''];
        if (!op) break;
        await answer('AI ishlamoqda…');
        await c.d.tg.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
        const e = op === 're' ? await c.d.editor.regenerate(owner, arg) : await c.d.editor.apply(owner, arg, op);
        const label = OPERATION_LABELS[e.operation as keyof typeof OPERATION_LABELS] ?? e.operation;
        await c.send(chatId, `<b>${escapeHtml(label)}</b>\n\n${escapeHtml(truncate(e.result_text, 3800))}`, aiResultKeyboard(e.id, e.result_text), true);
        return;
      }

      // ---------- group cleaner confirmation ----------
      case 'gc': {
        if (!arg) break;
        if (action === 'no') {
          await c.d.cleaner.cancel(owner, chatId, arg);
          await answer('Bekor qilindi');
          if (msgId) await c.edit(chatId, msgId, '🚫 O‘chirish bekor qilindi.');
          return;
        }
        if (action === 'ok') {
          await answer('O‘chirilmoqda…');
          if (msgId) await c.edit(chatId, msgId, '⏳ O‘chirilmoqda…');
          const res = await c.d.cleaner.execute(owner, arg);
          const text = [
            res.errors.length === 0 ? '✅ Tayyor.' : res.deleted > 0 ? '⚠️ Qisman bajarildi.' : '❌ O‘chirilmadi.',
            `So‘ralgan: ${res.requested}, Telegram’ga yuborilgan: ${res.deleted}`,
            '<i>Telegram allaqachon o‘chgan yoki topilmagan xabarlarni jimgina o‘tkazib yuboradi.</i>',
            ...res.errors.slice(0, 2).map((e) => escapeHtml(e)),
          ].join('\n');
          if (msgId) await c.edit(chatId, msgId, text, undefined, true);
          return;
        }
        break;
      }

      // ---------- scheduled tasks ----------
      case 'tk': {
        if (action === 'r') {
          await answer('Yangilandi');
          await tasksScreen(c, chatId, msgId);
          return;
        }
        if (action === 's' && arg) {
          await c.d.stories.cancel(owner, arg);
          await answer('Story bekor qilindi');
          await tasksScreen(c, chatId, msgId);
          return;
        }
        if (action === 'm' && arg) {
          const r = await c.d.media.cancel(owner, arg);
          await answer(r.what === 'send' ? 'Yuborish bekor qilindi' : 'Auto-delete bekor qilindi');
          await tasksScreen(c, chatId, msgId);
          return;
        }
        break;
      }

      // ---------- settings ----------
      case 'st': {
        if (action === 'ai' && arg && c.d.ai.available().includes(arg as AiProviderName)) {
          await c.d.repo.updateUserSettings(owner.id, { aiProvider: arg as AiProviderName });
          await c.d.repo.log({ user_id: owner.id, module: 'settings', action: `ai-provider:${arg}`, status: 'ok' });
          await c.refreshOwner();
          await answer('Saqlandi');
          await settingsScreen(c, chatId, msgId);
          return;
        }
        if (action === 'bc') {
          const s = await c.d.stories.connectionStatus(owner);
          await answer(s.problem ? 'Muammo bor — Settings’ga qarang' : 'Ulanish yaxshi ✅');
          await settingsScreen(c, chatId, msgId);
          return;
        }
        break;
      }
    }
    await answer('Noma’lum amal');
  } catch (err) {
    await answer('Xatolik', false);
    throw err;
  }
}

/** "md:t:b:123" → ["md","t","b:123"] (third part keeps any further colons). */
export function splitData(data: string): [string, string | undefined, string | undefined] {
  const i = data.indexOf(':');
  if (i < 0) return [data, undefined, undefined];
  const j = data.indexOf(':', i + 1);
  if (j < 0) return [data.slice(0, i), data.slice(i + 1), undefined];
  return [data.slice(0, i), data.slice(i + 1, j), data.slice(j + 1)];
}
