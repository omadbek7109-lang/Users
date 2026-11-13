# Personal Telegram AI Assistant

Shaxsiy Telegram akkauntingizni rasmiy **Telegram Bot API + Telegram Business** orqali boshqaradigan yordamchi bot.
Faqat egasining (`OWNER_TELEGRAM_ID`) buyruqlarini bajaradi.

| Modul | Nima qiladi |
|---|---|
| 📸 **Stories Manager** | Rasm/video → caption → 6/12/24/48 soat, "profilda saqlash", "himoyalash" → hozir yoki rejalashtirib joylash; caption tahrirlash, o‘chirish, holat va xato sababi |
| 🗑 **Group Cleaner** | Guruhda `/delete N`, `/cleanlinks`, `/clear`, `/cancel` — admin huquqi tekshiriladi, har doim tasdiqlash, tarix saqlanadi |
| ✨ **AI Message Editor** | Imlo, chiroyli yozish, qisqartirish, kengaytirish, rasmiy/oddiy uslub, uz/ru/en tarjima, taqqoslash; Claude ↔ OpenAI almashtirish |
| ⏱ **Timed Media** | Rasm/video’ni belgilangan vaqtda yuborish va 10s / 1d / 1 soat / 24 soatdan keyin avtomatik o‘chirish |
| 📅 📊 ⚙️ | Rejalashtirilgan vazifalar (bekor qilish), faoliyat loglari, sozlamalar |

## Telegram API imkoniyatlari — halol tahlil

Hamma narsa rasmiy metodlar asosida: `postStory`, `editStory`, `deleteStory`, `getBusinessConnection`,
`deleteMessages`, `deleteBusinessMessages`, `getChatMember`, `sendPhoto/sendVideo`, `getFile`.

- **Stories** faqat Telegram Business orqali ishlaydi (Bot API 9.0+). Kerak: Telegram **Premium**, bot Business’ga ulangan va **"Manage stories"** (`can_manage_stories`) huquqi yoqilgan.
- `active_period` faqat **6, 12, 24, 48 soat** bo‘lishi mumkin (rasmiy cheklov).
- Story media’sini `file_id` bilan qayta ishlatib bo‘lmaydi — bot faylni yuklab olib qayta yuklaydi. Bot API `getFile` limiti **20 MB**.
- Story **privacy** (kimlar ko‘radi: kontaktlar/yaqin do‘stlar) Bot API’da **mavjud emas**. Bor narsalar: `post_to_chat_page` (profilda saqlash) va `protect_content` (screenshot/forward himoyasi).
- Story ko‘rishlar soni yoki "story hali faolmi" ni o‘qish metodi **yo‘q**. Bot holatni o‘z bazasidan ko‘rsatadi (joylangan vaqt + arxivga o‘tish vaqti).
- `editStory` uchun media majburiy — caption o‘zgartirilganda asl media qayta yuklanadi.
- **Group Cleaner**: bot guruh tarixini o‘qiy olmaydi. U faqat qo‘shilgandan keyin **o‘zi qabul qilgan** xabarlarni (ID va metadata, matnsiz) eslab qoladi. Telegram faqat **48 soatdan yosh** xabarlarni o‘chirishga ruxsat beradi; bir so‘rovda ko‘pi bilan 100 ta.
- **Shaxsiy akkaunt chatlaridagi** eski xabarlarni bot o‘qimaydi va o‘chirmaydi.
- **Timed Media**: Bot API’da **view-once (bir marta ko‘riladigan) media yo‘q** va qabul qiluvchi mediani **ko‘rganini aniqlab bo‘lmaydi**. Shuning uchun bu modul **vaqt bo‘yicha o‘chirish** qiladi. Qo‘shimcha himoya: spoiler (blur) va `protect_content`.
- Business chatlarga yuborish faqat **so‘nggi 24 soatda sizga yozgan** chatlarga mumkin (`can_reply` qoidasi).

## Arxitektura

```
src/
├── bot/            router (framework-agnostic), handlers, keyboards, commands
├── modules/        stories · group-cleaner · ai-editor · timed-media (biznes mantiq)
├── services/       telegram-client (fetch, rasmiy metodlar), AI provayderlar, BullMQ, Redis state, logger
├── database/       Repository interfeysi · Supabase va in-memory implementatsiya
├── middleware/     owner-only himoya
├── jobs/           navbat protsessori (story.post, media.send, media.delete)
├── config/         env validatsiya
└── index.ts        ishga tushirish (grammY long polling + BullMQ worker + health server)
supabase/migrations  SQL sxema (RLS, FK, indekslar)
tests/               62 ta test (unit, integration, Telegram API mock, permission, error, security)
```

- **grammY** yangilanishlarni qabul qiladi (long polling, avtomatik qayta ulanish), mantiq esa `Router`da — shuning uchun to‘liq testlanadi.
- **BullMQ + Redis** — rejalashtirilgan story/media va auto-delete; 3 marta qayta urinish (exponential backoff), oxirgi xatoda egasiga xabar.
- **Supabase** — server `service_role` kaliti bilan ishlaydi; barcha jadvallarda RLS yoqilgan va `anon/authenticated` uchun hech qanday ruxsat yo‘q.
- Supabase Storage **ishlatilmaydi**: Telegram `file_id` bot uchun doimiy, media nusxalanmaydi.

## O‘rnatish

### 1. Bot
1. @BotFather → `/newbot` → token oling.
2. @BotFather → Bot Settings → **Business Mode** → yoqing.
3. Telegram ID’ingizni bilib oling (masalan @userinfobot).

### 2. Supabase
1. supabase.com’da loyiha yarating.
2. SQL Editor’da `supabase/migrations/20261113000000_init.sql` ni ishga tushiring (yoki `supabase db push`).
3. Project Settings → API: `Project URL` va **service_role** kalitini oling (faqat serverga!).

### 3. Redis
Upstash, Render Key Value yoki Railway Redis — `REDIS_URL` (`rediss://...`).

### 4. Sozlash va ishga tushirish
```bash
cp .env.example .env      # qiymatlarni to‘ldiring
npm install
npm run dev               # lokal
npm test                  # testlar
npm run build && npm start
```

### 5. Telegram Business’ni ulash (Stories uchun)
Telegram → Settings → **Telegram Business** → **Chatbots** → botingiz username’ini kiriting →
huquqlarda **Manage stories** (va xohlasangiz Reply, Delete sent messages) ni yoqing. Bot sizga ulanish holatini yozadi.

### 6. Group Cleaner
Botni guruhga **o‘zingiz** qo‘shing (boshqa odam qo‘shsa bot chiqib ketadi), admin qiling va **Delete messages** huquqini bering.

## Deploy (Render)
Repo’da `render.yaml` bor: Render → New → Blueprint → repo’ni tanlang → maxfiy qiymatlarni dashboard’da kiriting.
Bot **Background Worker** sifatida ishlaydi (long polling, public URL shart emas). Railway’da: `npm run build` / `npm start`, env’larni Variables’ga qo‘shing.

## Xavfsizlik
- Bot faqat `OWNER_TELEGRAM_ID` ga xizmat qiladi; begonalar tugmalari rad etiladi, begona Business ulanishi saqlanmaydi.
- API kalitlari faqat serverda (`.env`, Render/Railway variables). `.env` `.gitignore`da; CI repo’da token/kalit borligini tekshiradi.
- Loglar va `action_logs` avtomatik tozalanadi (bot token, `sk-...`, JWT, Bearer, Redis parol, `business_connection_id`).
- Guruh xabarlarining **matni saqlanmaydi** — faqat ID, vaqt va "link bormi" belgisi; 3 kundan keyin o‘chiriladi.
- O‘chirish (guruh, story) har doim tasdiqlash talab qiladi; guruh tasdig‘i 10 daqiqa amal qiladi.

## Holat

| Funksiya | Holat |
|---|---|
| Stories: joylash, rejalashtirish, caption tahrirlash, o‘chirish, xato sababi | ✅ yozilgan, mock testlardan o‘tgan · ⚙️ real ishlashi uchun Premium + Business ulanish kerak |
| Group Cleaner: /delete N, /cleanlinks, /clear, /cancel, tasdiqlash, tarix | ✅ yozilgan, testlangan · ⚙️ bot admin bo‘lishi kerak |
| AI Editor: 9 amal, tugmalar, taqqoslash, Claude/OpenAI almashtirish | ✅ yozilgan, testlangan · ⚙️ API kaliti kerak |
| Timed Media: rejalashtirish, auto-delete, bekor qilish, tarix, retry | ✅ yozilgan, testlangan · ⚙️ Redis kerak |
| Supabase sxema + RLS | ✅ yozilgan · ⚙️ migratsiyani loyihangizda ishga tushirish kerak |
| Erkin tilda buyruq berish ("ertaga 9da story joyla") | ❌ hali yo‘q — hozir menyu + matn → AI editor |
| Story privacy, ko‘rishlar soni, view-once media | 🚫 Bot API’da mavjud emas |
