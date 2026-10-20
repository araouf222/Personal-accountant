# 💰 بوت الكاش فلو (Cashflow Bot)

بوت تليجرام تسجل فيه **الوارد والمنصرف** بالكلام العادي أو بصورة الفاتورة أو PDF، وآخر الشهر تعرف حساباتك شكلها إيه.
أي حد يقدر يستخدمه: كل مستخدم بيدخل بحساب جوجل بتاعه، والبوت بيعمله **شيت خاص في الـ Drive بتاعه هو**.

مبني على [agunginsani/expenses-tracker](https://github.com/agunginsani/expenses-tracker) (رخصة MIT)، ومتعدّل علشان:
الوارد والمنصرف مع بعض، أكتر من مستخدم، تسجيل دخول بجوجل، عربي، جنيه مصري، وتوقيت القاهرة.

---

## البوت بيعمل إيه

| تكتب / تبعت | البوت بيعمل |
|---|---|
| جالي 15000 من مشروع المول | 🟢 وارد – أتعاب مشروع – مشروع المول |
| دفعت 500 بنزين | 🔴 منصرف – بنزين |
| اديت مروة 2000 ويحيى 100 | 🔴 حركتين منصرف، كل واحدة باسم صاحبها |
| صورة فاتورة / PDF | 🔴 منصرف بإجمالي الفاتورة (ولو اتبعتت مرتين ما بتتسجلش تاني) |
| 700 خالد | 🤔 يسألك: وارد ولا منصرف؟ |
| صرفت كام الشهر ده؟ | ملخص الشهر |
| مروة خدت كام؟ | كل اللي اديته لمروة الشهر ده بالتاريخ |

**الأوامر:** `/cashflow` · `/person مروة` · `/export` (ملف Excel) · `/sheet` · `/undo` · `/disconnect` · `/help`

**الشيت بتاع كل مستخدم** فيه 3 تابات:
- **الحركات**: كل حركة في صف (التاريخ، النوع، المبلغ، البيان، التصنيف، الشخص، المشروع).
- **ملخص شهري**: الوارد والمنصرف والصافي لكل شهر (بيتحسب لوحده بمعادلات).
- **الأشخاص**: كل شخص، اديته كام وجالي منه كام.

## الخصوصية باختصار
- الفلوس نفسها **مش بتتخزن عندنا**، بتتسجل في شيت المستخدم في الـ Drive بتاعه.
- البوت بياخد صلاحية `drive.file` بس، يعني **يشوف الملفات اللي هو عملها بس**.
- عندنا (Upstash Redis) بيتخزن: رقم تليجرام، رقم الشيت، ومفتاح جوجل **مشفّر** (AES-256)، وقائمة الأسماء.
- الرسايل والصور بتتبعت لـ Gemini علشان تتقرا، ومش بنحتفظ بيها.
- صفحة سياسة الخصوصية جاهزة على `/privacy`.

---

# التشغيل خطوة بخطوة

هتحتاج 5 حسابات مجانية: **تليجرام، Google AI Studio، GitHub، Vercel، Google Cloud**.
الترتيب مهم لأن Google Cloud محتاج لينك البوت من Vercel.

## 1) توكن البوت من BotFather
1. افتح تليجرام وابحث عن **@BotFather** (عليه علامة التوثيق الزرقا).
2. ابعتله `/newbot`، اكتب الاسم اللي هيظهر (مثلاً: كاش فلو)، وبعدين username لازم ينتهي بـ `bot`.
3. هيديك توكن شكله `123456789:AA...`. احفظه، ده `TELEGRAM_BOT_TOKEN`. **ما تبعتهوش لحد.**

## 2) مفتاح Gemini
1. ادخل **aistudio.google.com** بحساب جوجل.
2. **Get API key ← Create API key**، وانسخه. ده `GEMINI_API_KEY`.
3. المجاني ليه حد يومي. لما المستخدمين يكتروا فعّل الدفع من نفس الصفحة، أو قلل `AI_DAILY_LIMIT`.

## 3) ارفع الكود على GitHub
1. اعمل حساب على **github.com** لو مش عندك.
2. **New repository**، سميه `cashflow-bot`. لو عاوز أي حد يطور عليه خليه **Public**.
3. **Add file ← Upload files**، واسحب كل الملفات اللي جوه الفولدر (من غير `node_modules`)، وبعدين **Commit**.

## 4) Vercel + قاعدة Upstash
1. ادخل **vercel.com ← Sign up with GitHub** (خطة Hobby المجانية).
2. **Add New ← Project**، اختار `cashflow-bot` ← **Deploy**. هيفشل أو يشتغل ناقص، عادي، المهم نعرف اللينك.
3. انسخ لينك المشروع، شكله `https://cashflow-bot-xxxx.vercel.app`. ده `APP_URL`.
4. من صفحة المشروع: **Storage ← Create / Marketplace ← Upstash for Redis ← Free**، واربطه بالمشروع.
   ده بيضيف `KV_REST_API_URL` و `KV_REST_API_TOKEN` لوحده.

## 5) Google Cloud (تسجيل الدخول بجوجل)
1. ادخل **console.cloud.google.com** واعمل **New Project** (مثلاً `cashflow-bot`).
2. **APIs & Services ← Library**: فعّل **Google Sheets API** و **Google Drive API**.
3. **Google Auth Platform** (أو OAuth consent screen):
   - **Branding**: اسم التطبيق، إيميلك، Home page = `APP_URL`، Privacy policy = `APP_URL/privacy`، وفي Authorized domains حط دومين Vercel بتاعك (`cashflow-bot-xxxx.vercel.app`).
   - **Audience**: اختار **External**، وضيف إيميلك (وإيميلات اللي هيجربوا معاك) في **Test users**.
   - **Data access ← Add scopes**: علّم على `.../auth/drive.file` بس.
4. **Clients ← Create client ← Web application**:
   - **Authorized redirect URIs**: `APP_URL/api/oauth/callback`
     (مثال: `https://cashflow-bot-xxxx.vercel.app/api/oauth/callback`)
   - انسخ **Client ID** و **Client secret**، دول `GOOGLE_CLIENT_ID` و `GOOGLE_CLIENT_SECRET`.

## 6) حط المتغيرات في Vercel
**Project ← Settings ← Environment Variables**، وضيف:

| الاسم | القيمة |
|---|---|
| `TELEGRAM_BOT_TOKEN` | من الخطوة 1 |
| `GEMINI_API_KEY` | من الخطوة 2 |
| `APP_URL` | لينك Vercel من غير `/` في الآخر |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | من الخطوة 5 |
| `WEBHOOK_SECRET` | كلمة سر عشوائية طويلة، **حروف إنجليزي وأرقام بس** |
| `ENCRYPTION_KEY` | 32 بايت عشوائية base64 (`openssl rand -base64 32`) |
| `ALLOWED_USER_IDS` | (اختياري) أرقام تليجرام مسموح لها، مفصولة بفاصلة. فاضي = الكل |

وبعدين **Deployments ← ⋯ ← Redeploy**.

> ⚠️ `ENCRYPTION_KEY` ما تغيرهوش بعد ما الناس تبدأ تستخدم البوت، وإلا كل المستخدمين هيحتاجوا يربطوا جوجل تاني.

## 7) اربط تليجرام بالبوت (مرة واحدة)
افتح في المتصفح:
```
https://cashflow-bot-xxxx.vercel.app/api/setup?key=WEBHOOK_SECRET بتاعك
```
لو ظهرت «✅ البوت اتربط بتليجرام» يبقى خلاص. افتح البوت في تليجرام واكتب `/start`.

## 8) من التجربة للناس كلها
- طول ما التطبيق في Google Cloud على وضع **Testing**: بس الإيميلات اللي في Test users تقدر تدخل (لحد 100)، **ومفتاح الدخول بيخلص بعد 7 أيام**. ساعتها البوت هيطلب من المستخدم يربط تاني، وهيرجع لنفس الشيت.
- علشان تفتحه للكل: **Audience ← Publish app** (In production). بما إن الصلاحية الوحيدة `drive.file` (غير حساسة)، المراجعة بتبقى أساسية بس. وقبل ما جوجل يوثّق التطبيق، المستخدمين ممكن يشوفوا شاشة تحذير «Google hasn't verified this app».
- للإطلاق الرسمي يفضّل دومين خاص بيك بدل `vercel.app`.

---

## للمطورين
```bash
bun install
bun test          # 23 اختبار: التواريخ، القراءة، التقارير، ورحلة البوت كاملة (Telegram/Google/Gemini متقلّدين)
bun run typecheck
bun start         # تشغيل محلي polling (تسجيل الدخول بجوجل محتاج APP_URL شغال)
```

```
api/webhook.ts          ← تليجرام بيبعت الرسايل هنا (متأمن بـ WEBHOOK_SECRET)
api/oauth/callback.ts   ← رجوع المستخدم من جوجل: يعمل الشيت ويحفظ المفتاح المشفّر
api/setup.ts            ← ربط تليجرام من المتصفح
src/bot.ts              ← كل الأوامر والرسايل والأزرار
src/services/ai.ts      ← Gemini: يفهم الرسالة (وارد/منصرف/سؤال) ويطلع JSON
src/services/ledger.ts  ← الشيت: إنشاء، إضافة، قراءة، مسح
src/services/report.ts  ← ملخص الشهر وتقرير الشخص
src/services/excel.ts   ← ملف Excel للشهر
src/services/store.ts   ← Upstash Redis (بيانات الربط بس)
src/schemas/transaction.ts ← التصنيفات (عدّلها براحتك)
```

**أفكار للتطوير:** يسجل مروة صرفت الفلوس في إيه (تسوية العهدة)، رسايل صوتية، عملة وتوقيت لكل مستخدم، ميزانية شهرية وتنبيه، ملخص أسبوعي تلقائي.

## الرخصة
MIT. شوف `LICENSE`.
