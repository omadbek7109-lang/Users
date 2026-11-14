# Personal Telegram AI Assistant

Shaxsiy Telegram akkauntingiz bilan rasmiy **Telegram Bot API + Telegram Business** orqali ishlaydigan yordamchi bot.
Faqat egasining (`OWNER_TELEGRAM_ID`) buyruqlarini bajaradi.

> **Holat:** kod build qilinadi, typecheck va barcha avtomatik testlardan o‘tadi (pastda). Lekin bot **haqiqiy Telegram akkaunti bilan hali sinalmagan**.
> Telegram javoblari testlarda mock qilingan. So‘rov formatlari rasmiy API ta’riflari bilan avtomatik solishtirilgan, ammo Telegram serveri ularni qabul qilishini faqat real ishga tushirish ko‘rsatadi.

## Tekshiruv natijalari (CI, `personal-telegram-ai` branch)

| Tekshiruv | Nima bilan | Natija |
|---|---|---|
| `npm ci` + `npm run build` | Haqiqiy paketlar (lockfile) | ✅ |
| Typecheck (strict, `src` + `tests`) | grammy 1.46.0, bullmq 5.81.5, ioredis 5.11.1, supabase-js 2.119.0, sharp 0.35.5, ffmpeg-static 5.3.0, TypeScript 5.9.3 | ✅ |
| Unit + oqim testlari | Mock Telegram API | ✅ 70/70 |
| API kontrakti | `@grammyjs/types` 5.0.0 (rasmiy hujjatdan generatsiya qilingan): 20 xil so‘rovning har bir parametri | ✅ 4/4 |
| BullMQ / Redis | Haqiqiy Redis 7: kechiktirish, retry, bekor qilish, restart, Redis ma’lumoti yo‘qolishi | ✅ 6/6 |
| Media konvertatsiya | Haqiqiy sharp + ffmpeg-static (libx265), natija ffprobe bilan tekshiriladi | ✅ 4/4 |
| Supabase RLS | Haqiqiy Postgres 16, Supabase’ning default grant’lari bilan | ✅ 7/7 |
| Smoke start | Konfiguratsiyasiz ishga tushirish aniq xato bilan to‘xtashi | ✅ |
| `npm audit --omit=dev` | | 0 zaiflik |

Lokal ishga tushirish:
```bash
npm test                         # unit (mock)
REDIS_URL=redis://localhost:6379 DATABASE_URL=postgresql://postgres@localhost/postgres npm run test:integration
```

## Modullar bo‘yicha hisobot

### 📸 Stories Manager
**Ishlaydi (kodda):** rasm yoki video → caption → 6/12/24/48 soat → "profilda saqlash" (`post_to_chat_page`) va "himoyalash" (`protect_content`) → hozir yoki belgilangan vaqtda joylash. Shuningdek caption tahrirlash (`editStory`), o‘chirish (`deleteStory`) va xato sababini ko‘rsatish.
Media rasmiy talablarga avtomatik moslanadi:
- rasm → **1080×1920 JPEG, ≤10 MB**;
- video → **H.265, 720×1280, har soniyada key-frame, faststart MP4, ≤30 MB, ≤60 s**; ovozsiz video uchun `is_animation`.

Joylash navbat orqali bajariladi va natija xabar qilib yuboriladi.

**Ishlamaydi / API’da yo‘q:**
- story privacy (kontaktlar, yaqin do‘stlar) — Bot API’da bunday parametr yo‘q;
- ko‘rishlar sonini yoki "story hali faolmi"ni o‘qish — bunday metod yo‘q (holat botning o‘z bazasidan ko‘rsatiladi);
- 20 MB dan katta fayl (`getFile` limiti).

Video 60 soniyaga qisqartiriladi va 9:16 ga markazdan kesiladi. **Real Telegram serverida sinalmagan.**

**Ruxsat:** Telegram **Premium**; bot Telegram Business → Chatbots’ga ulangan bo‘lishi; **Manage stories** (`can_manage_stories`) huquqi.

**Konfiguratsiya:** `BOT_TOKEN`, BotFather’da Business Mode yoqilgan, Redis (navbat). ffmpeg `ffmpeg-static` orqali avtomatik o‘rnatiladi; o‘zingizning binaringizni `FFMPEG_PATH` bilan berishingiz mumkin. Server uchun 1 GB RAM tavsiya etiladi (H.265 kodlash og‘ir; 60 s video starter serverda 1–2 daqiqa olishi mumkin).

### 🗑 Group Cleaner
**Ishlaydi:** guruhda `/delete N`, `/cleanlinks`, `/clear`, `/cancel`.
- Har safar tasdiqlash so‘raladi (10 daqiqa amal qiladi).
- Admin huquqi `getChatMember` bilan buyruq berilganda **va** tasdiqlanganda qayta tekshiriladi.
- 48 soatlik qoida ham tasdiqlash paytida qayta tekshiriladi (15 daqiqa xavfsizlik zaxirasi bilan).
- O‘chirish 100 tadan paketlarda bajariladi, tarix `delete_tasks` jadvalida saqlanadi.
- Begona odam qo‘shgan guruhdan bot chiqib ketadi. Guruh supergroupga aylanganda sozlamalar yangi ID’ga ko‘chiriladi.

**Ishlamaydi:** bot guruh tarixini o‘qiy olmaydi. U faqat qo‘shilgandan keyin **o‘zi olgan** xabarlarni biladi (metadata, matn saqlanmaydi). 48 soatdan eski xabarlar o‘chmaydi (Telegram cheklovi). Telegram allaqachon o‘chgan xabarlarni jimgina o‘tkazib yuboradi, shuning uchun aniq son kafolatlanmaydi.

**Ruxsat:** botni guruhga **ega o‘zi** qo‘shishi, uni admin qilishi va **Delete messages** huquqini berishi kerak. Admin bot barcha xabarlarni oladi, privacy mode’ni o‘chirish shart emas.

**Konfiguratsiya:** qo‘shimcha sozlama shart emas.

### ✨ AI Message Editor
**Ishlaydi:** imlo tuzatish, chiroyli yozish, qisqartirish, kengaytirish, rasmiy va oddiy uslub, uz/ru/en tarjima, original matn bilan taqqoslash. Tugmalar: Qayta tahrirlash, Nusxalash (256 belgigacha `copy_text`, undan uzunlari kod bloki sifatida), Tarjima, Qisqartirish, Original.
Claude va OpenAI o‘rtasida Settings’dan almashtiriladi. Kalitlar faqat serverda saqlanadi va loglarda yashiriladi.

**Ishlamaydi:** 4000 belgidan uzun matn. Erkin tildagi buyruqlar ("ertaga 9 da story joyla") ham yo‘q — oddiy matn AI editorga yuboriladi. AI javobi kelguncha (60 s gacha) bot keyingi xabarlarni navbatda ushlab turadi. **Haqiqiy AI API bilan sinalmagan** (so‘rov formati unit testda tekshirilgan).

**Ruxsat:** yo‘q.

**Konfiguratsiya:** `ANTHROPIC_API_KEY` (+ `CLAUDE_MODEL`, default `claude-sonnet-5-5`) va/yoki `OPENAI_API_KEY` + `OPENAI_MODEL`, hamda `AI_PROVIDER`.

### ⏱ Timed Media
**Ishlaydi:** rasm yoki videoni tanlangan chatga hozir yoki belgilangan vaqtda yuborish. Chat bo‘lishi mumkin:
- bot bilan shaxsiy chat;
- ro‘yxatdagi guruh;
- so‘nggi 24 soatda sizga yozgan Business chat.

Yuborilgandan keyin 10 s / 1 d / 1 soat / 24 soatda avtomatik o‘chiriladi (`deleteMessage` yoki `deleteBusinessMessages`). Spoiler va `protect_content` qo‘shish mumkin. Bekor qilish, tarix, qayta urinish va egasiga xabar berish bor.

**Ishlamaydi / API’da yo‘q:** bir marta ko‘riladigan (view-once) media yuborib bo‘lmaydi, qabul qiluvchi mediani **ko‘rganini aniqlab bo‘lmaydi**. Bu modul faqat **vaqt bo‘yicha o‘chiradi**. Yuborish "kamida bir marta" kafolatiga ega: yuborishning aynan o‘rtasida server o‘chib qolsa, media ikki marta ketishi mumkin.

**Ruxsat:** guruhda bot xabar yubora olishi kerak. Business chatlar uchun `can_reply` va o‘chirish uchun `can_delete_outgoing_messages` kerak.

**Konfiguratsiya:** Redis.

### 📅 Scheduler (barcha rejalashtirilgan ishlar)
**Ishlaydi:** BullMQ + Redis. Har bir ish 3 marta qayta uriniladi (exponential backoff). Bekor qilingan ish bajarilmaydi, bir xil ID bilan qayta qo‘shilsa dublikat bo‘lmaydi.
**Restart xavfsizligi:**
- kechiktirilgan ishlar Redis’da saqlanadi va yangi jarayon ularni bajaradi;
- Redis ma’lumoti yo‘qolsa, ishga tushishda `reconcileJobs` Supabase’dagi vazifalardan navbatni qayta tiklaydi;
- vaqti o‘tib ketgan vazifalar darhol bajariladi;
- yuklash o‘rtasida uzilgan story **qayta joylanmaydi** (dublikat bo‘lmasligi uchun), u "failed" bo‘ladi va sababi ko‘rsatiladi.

**Konfiguratsiya:** `REDIS_URL`. Redis’da `maxmemory-policy noeviction` bo‘lishi kerak. Persistence (AOF) tavsiya etiladi; usiz ham reconcile ishlarni tiklaydi.

### 🔐 Supabase va xavfsizlik
- Barcha 10 jadvalda RLS yoqilgan va policy yo‘q.
- `anon`/`authenticated` uchun jadval, sequence va funksiya huquqlari olib tashlangan. Supabase’ning default grant’lari bilan haqiqiy Postgres’da tekshirilgan: ruxsat berilib qolsa ham RLS qatorlarni ko‘rsatmaydi.
- Server faqat **service_role** kaliti bilan ishlaydi. Bu kalit RLS’ni chetlab o‘tadi, shuning uchun u faqat server env’ida turishi kerak (frontend yoki repo’da hech qachon).
- Bot faqat egasiga xizmat qiladi. Begona Business ulanishi saqlanmaydi, begonalar tugmalari rad etiladi.
- Loglarda token, `sk-…` kalitlar, JWT, Bearer, Redis paroli va `business_connection_id` yashiriladi. CI har push’da repo’dan maxfiy kalit qidiradi.
- Keyingi migratsiyalarda yangi jadval qo‘shilsa, unda ham RLS yoqing va `anon/authenticated`dan huquqni oling (`tests/integration/rls.int.test.ts` buni tekshiradi).

## O‘rnatish

1. **Bot:** @BotFather → `/newbot` → token oling; Bot Settings → **Business Mode** → yoqing. Telegram ID’ingizni bilib oling (masalan @userinfobot).
2. **Supabase:** loyiha yarating va `supabase/migrations/` dagi ikkala SQL faylni tartib bilan ishga tushiring (SQL Editor yoki `supabase db push`). `Project URL` va **service_role** kalitini oling.
3. **Redis:** Upstash, Render Key Value yoki Railway Redis → `REDIS_URL` (`rediss://…`), eviction policy `noeviction`.
4. **Ishga tushirish:**
   ```bash
   cp .env.example .env   # to‘ldiring (.env avtomatik o‘qiladi)
   npm ci
   npm run dev            # yoki: npm run build && npm start
   ```
5. **Telegram Business:** Settings → Telegram Business → Chatbots → bot username → **Manage stories** (va kerak bo‘lsa Reply, Delete messages) huquqlarini yoqing. Bot ulanish holatini sizga yozadi.
6. **Guruh:** botni o‘zingiz qo‘shing → admin → **Delete messages**.

### Deploy (Render)
`render.yaml` bor: Render → New → Blueprint → repo’ni tanlang → maxfiy qiymatlarni dashboard’da kiriting. Bot **Background Worker** sifatida long polling bilan ishlaydi. Railway’da: build `npm ci && npm run build`, start `npm start`.

### Birinchi real sinov (tavsiya etiladigan tartib)
1. `/start` → menyu chiqadi; begona akkauntdan yozilganda rad javobi keladi.
2. Settings → "Business ulanishni tekshirish" → huquqlar ✅.
3. Kichik rasm → Story → 6 soat → Hozir joylash → "✅ Story joylandi" xabari keladi va story profilda ko‘rinadi.
4. 10 soniyali video bilan ham xuddi shunday sinab ko‘ring.
5. Test guruhida `/delete 2` → tasdiqlash → ikkita xabar o‘chadi.
6. Timed Media → o‘zingizga, 10 s auto-delete → xabar kelib, keyin o‘chadi.
7. Story’ni +2 daqiqaga rejalashtiring → botni qayta ishga tushiring → story baribir joylanadi.

## Arxitektura
```
src/
├── bot/            router (framework-agnostic), handlers, keyboards, commands
├── modules/        stories (+ media-prep) · group-cleaner · ai-editor · timed-media
├── services/       telegram-client (rasmiy metodlar), AI, BullMQ, Redis state, logger
├── database/       Repository · Supabase / in-memory implementatsiya
├── jobs/           processor · reconcile (restart tiklash)
├── middleware/     owner-only
├── config/         env validatsiya
└── index.ts        grammY long polling + BullMQ worker + reconcile + health server
supabase/migrations  sxema, RLS, grant’lar
tests/               unit (mock) · tests/integration (real Redis/Postgres/ffmpeg, API kontrakt)
scripts/             print-api-docs.mjs — rasmiy API matnini node_modules’dan ko‘rsatadi (`npm run api-docs`)
```
