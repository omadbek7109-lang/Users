import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, STRANGER, BOT_ID, callback, connectBusiness, groupMsg, ownerUser, privateMsg, setup } from './helpers.js';
import { MENU } from '../src/bot/keyboards/index.js';
import { actorId, strangerAllowance } from '../src/middleware/owner-only.js';

const lastText = (env: ReturnType<typeof setup>, method = 'sendMessage') => String(env.fake.byMethod(method).at(-1)?.params.text ?? '');

test('security: strangers are refused in private and on buttons', async () => {
  const env = setup();
  await env.router.handle(privateMsg(STRANGER, { text: '/start' }));
  await env.router.handle(privateMsg(STRANGER, { text: 'yana' }));
  assert.equal(env.fake.byMethod('sendMessage').length, 1, 'warned only once');
  assert.match(lastText(env), /faqat egasiga/);

  await env.router.handle(callback(STRANGER, 'sd:now'));
  assert.equal(env.fake.byMethod('answerCallbackQuery').at(-1)!.params.show_alert, true);
  assert.equal(env.fake.byMethod('postStory').length, 0);
});

test('security: stranger group commands are ignored but messages are tracked', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await env.repo.upsertGroup({ chat_id: -1, user_id: owner.id, title: 'G', bot_can_delete: true, track_messages: true });
  await env.router.handle(groupMsg(-1, STRANGER, { text: '/clear' }, 50, Math.floor(env.now().getTime() / 1000)));
  assert.equal(env.repo.deleteTasks.size, 0);
  assert.equal(env.repo.tracked.size, 1);
  assert.equal(env.fake.byMethod('sendMessage').length, 0);
});

test('security: foreign business connection is never stored', async () => {
  const env = setup();
  await env.router.handle({
    update_id: 1,
    business_connection: { id: 'evil', user: { id: STRANGER, is_bot: false, first_name: 'X' }, user_chat_id: STRANGER, date: 1, is_enabled: true, rights: { can_manage_stories: true } },
  });
  assert.equal(env.repo.connections.size, 0);
});

test('owner-only middleware helpers', () => {
  assert.equal(actorId(privateMsg(OWNER, { text: 'x' })), OWNER);
  assert.equal(strangerAllowance(groupMsg(-1, STRANGER, {})), 'track-group');
  assert.equal(strangerAllowance(privateMsg(STRANGER, {})), 'deny');
});

test('flow: business connect → photo → Story → options → post now', async () => {
  const env = setup();
  await env.router.handle({
    update_id: 1,
    business_connection: { id: 'bc_1', user: { id: OWNER, is_bot: false, first_name: 'O' }, user_chat_id: OWNER, date: 1_700_000_000, is_enabled: true, rights: { can_manage_stories: true, can_reply: true } },
  });
  assert.match(lastText(env), /Business ulandi/);

  await env.router.handle(privateMsg(OWNER, { photo: [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90 }, { file_id: 'BIG', file_unique_id: 'b', width: 1080, height: 1920 }], caption: 'Ertalab' }));
  assert.match(lastText(env), /nima qilamiz/);
  await env.router.handle(callback(OWNER, 'mp:story'));
  assert.match(lastText(env, 'editMessageText'), /Yangi story/);
  await env.router.handle(callback(OWNER, 'sd:p:43200'));
  await env.router.handle(callback(OWNER, 'sd:page'));
  await env.router.handle(callback(OWNER, 'sd:now'));
  assert.match(lastText(env, 'editMessageText'), /Tayyor bo‘lgach xabar beraman/);
  await env.drain();

  const post = env.fake.byMethod('postStory')[0]!;
  assert.equal(post.params.active_period, 43200);
  assert.equal(post.params.post_to_chat_page, true);
  assert.equal(post.params.caption, 'Ertalab');
  assert.equal(env.fake.byMethod('getFile')[0]!.params.file_id, 'BIG');
  assert.match(lastText(env), /Story joylandi/);
});

test('flow: story without business connection explains how to connect', async () => {
  const env = setup();
  await env.router.handle(privateMsg(OWNER, { video: { file_id: 'V', file_unique_id: 'v', width: 720, height: 1280, duration: 10 } }));
  await env.router.handle(callback(OWNER, 'mp:story'));
  await env.router.handle(callback(OWNER, 'sd:now'));
  assert.match(lastText(env), /Business ulanmagan/);
});

test('flow: schedule a story by typing a time', async () => {
  const env = setup();
  await connectBusiness(env);
  await env.router.handle(privateMsg(OWNER, { photo: [{ file_id: 'P', file_unique_id: 'p', width: 1, height: 1 }] }));
  await env.router.handle(callback(OWNER, 'mp:story'));
  await env.router.handle(callback(OWNER, 'sd:sched'));
  await env.router.handle(privateMsg(OWNER, { text: '+2h' }));
  assert.match(lastText(env), /rejalashtirildi/);
  assert.equal(env.queue.jobs[0]!.name, 'story.post');
  assert.equal(env.queue.jobs[0]!.delayMs, 2 * 3_600_000);
});

test('flow: AI editor from plain text with result buttons', async () => {
  const env = setup();
  await env.router.handle(privateMsg(OWNER, { text: 'salom qalesan' }));
  const first = env.fake.byMethod('sendMessage').at(-1)!;
  const kb = (first.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data?: string }>> }).inline_keyboard.flat();
  const fixBtn = kb.find((b) => b.callback_data?.startsWith('ai:fx:'))!;
  await env.router.handle(callback(OWNER, fixBtn.callback_data!));
  const res = env.fake.byMethod('sendMessage').at(-1)!;
  assert.match(String(res.params.text), /EDITED/);
  const buttons = (res.params.reply_markup as { inline_keyboard: Array<Array<{ text: string; copy_text?: unknown }>> }).inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.text.includes('Nusxalash') && b.copy_text), 'copy_text button for short text');
  for (const label of ['Qayta tahrirlash', 'Tarjima', 'Qisqartirish', 'Original']) assert.ok(buttons.some((b) => b.text.includes(label)), label);
});

test('flow: group /delete 2 → confirm → deleted', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await env.repo.upsertGroup({ chat_id: -7, user_id: owner.id, title: 'G', bot_can_delete: true, track_messages: true });
  const ts = Math.floor(env.now().getTime() / 1000);
  for (let i = 1; i <= 4; i++) await env.router.handle(groupMsg(-7, STRANGER, { text: `m${i}` }, i, ts));
  await env.router.handle(groupMsg(-7, OWNER, { text: '/delete@pta_test_bot 2' }, 5, ts));
  const confirm = env.fake.byMethod('sendMessage').at(-1)!;
  assert.match(String(confirm.params.text), /oxirgi <b>2<\/b>/);
  const ok = (confirm.params.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![0]!.callback_data;
  assert.equal(env.fake.byMethod('deleteMessages').length, 0);
  await env.router.handle(callback(OWNER, ok, -7, 9));
  assert.deepEqual(env.fake.byMethod('deleteMessages')[0]!.params.message_ids, [4, 3]);
  assert.match(lastText(env, 'editMessageText'), /Tayyor/);
});

test('flow: group command for another bot is ignored', async () => {
  const env = setup();
  const owner = await ownerUser(env);
  await env.repo.upsertGroup({ chat_id: -7, user_id: owner.id, title: 'G', bot_can_delete: true, track_messages: true });
  await env.router.handle(groupMsg(-7, OWNER, { text: '/clear@other_bot' }, 1, Math.floor(env.now().getTime() / 1000)));
  assert.equal(env.repo.deleteTasks.size, 0);
});

test('flow: timed media → target → auto-delete 1 min → send now', async () => {
  const env = setup();
  await env.router.handle(privateMsg(OWNER, { photo: [{ file_id: 'P', file_unique_id: 'p', width: 1, height: 1 }] }));
  await env.router.handle(callback(OWNER, 'mp:timed'));
  await env.router.handle(callback(OWNER, `md:t:c:${OWNER}`));
  await env.router.handle(callback(OWNER, 'md:d:60'));
  await env.router.handle(callback(OWNER, 'md:now'));
  const [task] = [...env.repo.media.values()];
  assert.equal(task!.delete_after_seconds, 60);
  assert.equal(env.queue.jobs[0]!.name, 'media.send');
});

test('menu: every main menu section renders', async () => {
  const env = setup();
  for (const label of Object.values(MENU)) {
    const before = env.fake.byMethod('sendMessage').length;
    await env.router.handle(privateMsg(OWNER, { text: label }));
    assert.equal(env.fake.byMethod('sendMessage').length, before + 1, label);
    assert.ok(!lastText(env).includes('Kutilmagan'), label);
  }
});

test('error handling: unexpected errors are reported to the owner and logged', async () => {
  const env = setup();
  env.fake.handlers.getChatMember = () => { throw new Error('boom'); };
  const owner = await ownerUser(env);
  await env.repo.upsertGroup({ chat_id: -9, user_id: owner.id, title: 'G', bot_can_delete: true, track_messages: true });
  env.repo.listTrackedMessages = async () => { throw new Error('db down'); };
  env.fake.handlers.getChatMember = () => ({ status: 'administrator', user: { id: BOT_ID, is_bot: true, first_name: 'B' }, can_delete_messages: true });
  await env.router.handle(groupMsg(-9, OWNER, { text: '/clear' }, 1, Math.floor(env.now().getTime() / 1000)));
  assert.match(lastText(env), /Kutilmagan xatolik/);
  assert.equal(env.repo.logs.at(-1)!.status, 'error');
});
