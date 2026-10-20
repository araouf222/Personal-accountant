import { type Context, Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { config } from "./config.js";
import {
  IN_CATEGORIES,
  OUT_CATEGORIES,
  type ParsedTransaction,
  type Transaction,
  TYPE_LABEL,
} from "./schemas/transaction.js";
import { interpret } from "./services/ai.js";
import { randomId } from "./services/crypto.js";
import {
  currentMonth,
  isoDate,
  monthLabel,
  parseMonthArg,
  timestamp,
} from "./services/dates.js";
import { monthWorkbook } from "./services/excel.js";
import {
  appendTransactions,
  deleteAll,
  deleteByIds,
  readTransactions,
} from "./services/ledger.js";
import {
  esc,
  formatMonth,
  formatPerson,
  money,
  personReport,
  summarizeMonth,
} from "./services/report.js";
import type { UserRecord } from "./services/store.js";
import * as store from "./services/store.js";

export const bot = new Telegraf(
  process.env.TELEGRAM_BOT_TOKEN || "missing-token",
);
// On Vercel we answer Telegram's HTTP call only after our work is done, so replies go through the API.
bot.telegram.webhookReply = false;

const HTML = {
  parse_mode: "HTML" as const,
  link_preview_options: { is_disabled: true },
};

export const HELP = `<b>إزاي تستخدمني</b>

اكتب زي ما بتتكلم:
• <i>جالي 15000 من مشروع المول</i> ← وارد
• <i>دفعت 500 بنزين</i> ← منصرف
• <i>اديت مروة 2000 ويحيى 100</i> ← منصرف لكل واحد باسمه
• ابعت <b>صورة فاتورة</b> أو <b>PDF</b> ← بتتسجل منصرف

واسأل عادي: <i>صرفت كام الشهر ده؟</i> أو <i>مروة خدت كام؟</i>

<b>الأوامر</b>
/cashflow – الوارد والمنصرف والرصيد (ممكن تكتب بعده شهر: <code>/cashflow سبتمبر</code>)
/person – فلوس شخص معين: <code>/person مروة</code>
/export – ملف Excel للشهر
/undo – امسح آخر حاجة اتسجلت
/deleteall – امسح كل حساباتك من البوت`;

// ---------------------------------------------------------------- guards

bot.use(async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== "private") return; // personal finance → private chats only
  const allowed = config.allowedUserIds;
  if (allowed.size && ctx.from && !allowed.has(ctx.from.id)) {
    if (ctx.message)
      await ctx.reply("البوت ده لسه في مرحلة التجربة ومش متاح للكل. 🙏");
    return;
  }
  return next();
});

/** Every user gets their own private ledger automatically on first use. */
async function requireUser(ctx: Context): Promise<UserRecord | null> {
  if (!ctx.from) return null;
  const existing = await store.getUser(ctx.from.id);
  if (existing) return existing;
  const user = { telegramId: ctx.from.id, joinedAt: isoDate() };
  await store.saveUser(user);
  return user;
}

// ---------------------------------------------------------------- commands

bot.start(async (ctx) => {
  const isNew = !(await store.getUser(ctx.from.id));
  await requireUser(ctx);
  const intro = isNew
    ? "أهلاً بيك في بوت الكاش فلو 💰\nسجل الفلوس اللي بتدخلك واللي بتصرفها بالكلام أو بصورة الفاتورة، وآخر الشهر تعرف حساباتك شكلها إيه.\nحساباتك خاصة بيك لوحدك ومتشفّرة 🔒"
    : "أهلاً تاني 👋";
  await ctx.reply(`${intro}\n\n${HELP}`, HTML);
});

bot.help((ctx) => ctx.reply(HELP, HTML));

bot.command("cashflow", async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const month = parseMonthArg(ctx.payload);
  if (!month)
    return ctx.reply(
      "مش فاهم الشهر ده. جرب مثلاً: /cashflow سبتمبر أو /cashflow 2026-09",
    );
  await sendMonth(ctx, user, month);
});

bot.command("person", async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const words = ctx.payload.trim().split(/\s+/).filter(Boolean);
  if (!words.length)
    return ctx.reply("اكتب الاسم بعد الأمر، مثلاً: /person مروة");
  // Optional month at the end: "/person مروة سبتمبر"
  let month = currentMonth();
  if (words.length > 1) {
    const m = parseMonthArg(words.at(-1) ?? "");
    if (m) {
      month = m;
      words.pop();
    }
  }
  await sendPerson(ctx, user, words.join(" "), month);
});

bot.command("export", async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const month = parseMonthArg(ctx.payload);
  if (!month) return ctx.reply("مش فاهم الشهر ده. جرب مثلاً: /export سبتمبر");
  await ctx.sendChatAction("upload_document");
  const txs = await readTransactions(user.telegramId);
  if (!txs) return;
  const currency = config.defaultCurrency;
  const file = await monthWorkbook(
    month,
    txs,
    summarizeMonth(txs, month),
    currency,
  );
  await ctx.replyWithDocument(
    { source: file, filename: `cashflow-${month}.xlsx` },
    { caption: `📊 تقرير ${monthLabel(month)}` },
  );
});

bot.command("undo", async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const ids = await store.takeLastSaved(user.telegramId);
  await undoIds(ctx, user, ids);
});

bot.command("deleteall", async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await ctx.reply(
    "⚠️ متأكد إنك عاوز تمسح <b>كل</b> حساباتك من البوت؟ مش هينفع ترجعها.\nلو عاوز نسخة الأول اكتب /export.",
    {
      ...HTML,
      ...Markup.inlineKeyboard([
        Markup.button.callback("أيوه امسح كله", "del:yes"),
        Markup.button.callback("لأ", "del:no"),
      ]),
    },
  );
});

// ---------------------------------------------------------------- messages

bot.on(message("text"), async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return ctx.reply(HELP, HTML);
  const user = await requireUser(ctx);
  if (!user) return;
  await handleAi(ctx, user, { text });
});

bot.on(message("photo"), async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  const data = await download(ctx, photo.file_id);
  await handleAi(ctx, user, {
    data,
    mimeType: "image/jpeg",
    caption: ctx.message.caption,
  });
});

bot.on(message("document"), async (ctx) => {
  const doc = ctx.message.document;
  const mime = doc.mime_type ?? "";
  if (mime !== "application/pdf" && !mime.startsWith("image/")) {
    return ctx.reply("بقرا الصور وملفات PDF بس. ابعت الفاتورة كصورة أو PDF.");
  }
  if ((doc.file_size ?? 0) > 15 * 1024 * 1024)
    return ctx.reply("الملف كبير أوي (أقصى حاجة 15 ميجا).");
  const user = await requireUser(ctx);
  if (!user) return;
  const data = await download(ctx, doc.file_id);
  await handleAi(ctx, user, {
    data,
    mimeType: mime,
    caption: ctx.message.caption,
  });
});

bot.on(message("voice"), (ctx) =>
  ctx.reply("لسه مش بفهم الرسايل الصوتية 🙏 اكتبها أو ابعت صورة الفاتورة."),
);

async function download(ctx: Context, fileId: string): Promise<Buffer> {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link.href);
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function handleAi(
  ctx: Context,
  user: UserRecord,
  input: Parameters<typeof interpret>[0],
) {
  if (!(await store.useAiQuota(user.telegramId))) {
    return ctx.reply(
      `وصلت للحد اليومي (${config.aiDailyLimit} رسالة). كمّل بكرة إن شاء الله 🙏`,
    );
  }
  await ctx.sendChatAction("typing");
  const result = await interpret(
    input,
    await store.knownPeople(user.telegramId),
  );

  switch (result.intent) {
    case "cashflow_query":
      return sendMonth(ctx, user, result.query_month ?? currentMonth());
    case "person_query":
      if (result.query_person) {
        return sendPerson(
          ctx,
          user,
          result.query_person,
          result.query_month ?? currentMonth(),
        );
      }
      return ctx.reply("مين؟ اكتب الاسم، مثلاً: /person مروة");
    case "transaction":
      if (result.transactions.length)
        return handleTransactions(ctx, user, result.transactions);
      return ctx.reply(
        "مش قادر أطلع مبلغ من الرسالة دي. جرب تكتبها كده: «دفعت 500 بنزين» أو «جالي 3000 من فلان».",
      );
    default:
      return ctx.reply(
        result.reply ??
          "ابعتلي فلوس دخلتلك أو صرفتها، أو صورة فاتورة. /help للمساعدة.",
      );
  }
}

// ---------------------------------------------------------------- saving

const EGP_ALIASES = /^(egp|le|l\.e|جنيه|ج\.?م|جم|جنية)$/i;

export function toTransaction(
  p: ParsedTransaction,
  type: "in" | "out",
  now = new Date(),
): Transaction {
  const date = p.date ?? isoDate(now);
  const currencyRaw = (p.currency ?? "").trim();
  const currency =
    !currencyRaw || EGP_ALIASES.test(currencyRaw)
      ? config.defaultCurrency
      : currencyRaw.toUpperCase();
  const allowed: readonly string[] =
    type === "in" ? IN_CATEGORIES : OUT_CATEGORIES;
  const fallback = p.person
    ? type === "in"
      ? "فلوس من شخص"
      : "فلوس لشخص"
    : "أخرى";
  const category =
    p.category && allowed.includes(p.category) ? p.category : fallback;
  const description = p.receipt_id
    ? `${p.description} [#${p.receipt_id}]`
    : p.description;
  return {
    id: randomId(6),
    date,
    type,
    amount: Math.round(p.amount * 100) / 100,
    currency,
    description,
    category,
    person: p.person ?? "",
    source: p.source ?? "",
    month: date.slice(0, 7),
    createdAt: timestamp(now),
  };
}

function describe(t: Transaction): string {
  const icon = t.type === "in" ? "🟢" : "🔴";
  const extra = [t.category, t.person, t.source]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  const desc = esc(t.description.split("\n")[0]);
  return `${icon} ${TYPE_LABEL[t.type]} <b>${money(t.amount, t.currency)}</b> – ${desc}\n     ${extra} · ${t.date}`;
}

async function handleTransactions(
  ctx: Context,
  user: UserRecord,
  parsed: ParsedTransaction[],
) {
  if (parsed.some((p) => p.type === "unknown")) {
    const id = await store.savePending({
      telegramId: user.telegramId,
      transactions: parsed,
    });
    const unclear = parsed
      .filter((p) => p.type === "unknown")
      .map(
        (p) =>
          `• ${money(p.amount, p.currency ?? config.defaultCurrency)} – ${esc(p.description)}`,
      )
      .join("\n");
    return ctx.reply(
      `مش متأكد 🤔\n${unclear}\n\nده <b>وارد</b> ولا <b>منصرف</b>؟`,
      {
        ...HTML,
        ...Markup.inlineKeyboard([
          Markup.button.callback("🟢 وارد", `p:${id}:in`),
          Markup.button.callback("🔴 منصرف", `p:${id}:out`),
          Markup.button.callback("✖️ إلغاء", `p:${id}:x`),
        ]),
      },
    );
  }
  await saveAndConfirm(
    ctx,
    user,
    parsed.map((p) => toTransaction(p, p.type as "in" | "out")),
  );
}

async function saveAndConfirm(
  ctx: Context,
  user: UserRecord,
  txs: Transaction[],
) {
  const saved = await (async () => {
    // Skip receipts already recorded (same printed invoice number).
    const receipts = txs
      .map((t) => t.description.match(/\[#(.+)\]$/)?.[0])
      .filter(Boolean);
    let toSave = txs;
    let skipped = 0;
    if (receipts.length) {
      const existing = await readTransactions(user.telegramId);
      toSave = txs.filter((t) => {
        const tag = t.description.match(/\[#(.+)\]$/)?.[0];
        const dup = tag && existing.some((e) => e.description.endsWith(tag));
        if (dup) skipped++;
        return !dup;
      });
    }
    if (toSave.length) await appendTransactions(user.telegramId, toSave);
    return { toSave, skipped };
  })();

  const { toSave, skipped } = saved;
  if (!toSave.length) {
    return ctx.reply(
      "⚠️ الفاتورة دي متسجلة قبل كده (نفس رقم الفاتورة)، فمش هسجلها تاني.",
    );
  }
  await store.setLastSaved(
    user.telegramId,
    toSave.map((t) => t.id),
  );
  await store.addPeople(
    user.telegramId,
    toSave.map((t) => t.person).filter(Boolean),
  );

  const lines = ["✅ <b>اتسجل:</b>", ...toSave.map(describe)];
  if (skipped)
    lines.push("", `⚠️ ${skipped} فاتورة كانت متسجلة قبل كده ومسجلتهاش تاني.`);
  const undoData = `u:${toSave.map((t) => t.id).join(",")}`;
  const buttons = [Markup.button.callback("📊 الشهر ده", "month")];
  if (undoData.length <= 64)
    buttons.unshift(Markup.button.callback("↩️ تراجع", undoData));
  await ctx.reply(lines.join("\n"), {
    ...HTML,
    ...Markup.inlineKeyboard(buttons),
  });
}

async function undoIds(ctx: Context, user: UserRecord, ids: string[]) {
  if (!ids.length) return ctx.reply("مفيش حاجة أتراجع عنها.");
  const removed = await deleteByIds(user.telegramId, ids);
  if (removed === undefined) return;
  await ctx.reply(
    removed
      ? `↩️ اتمسح ${removed === 1 ? "التسجيل" : `${removed} تسجيلات`}.`
      : "التسجيل ده اتمسح قبل كده.",
  );
}

// ---------------------------------------------------------------- reports

async function sendMonth(ctx: Context, user: UserRecord, month: string) {
  await ctx.sendChatAction("typing");
  const txs = await readTransactions(user.telegramId);
  if (!txs) return;
  await ctx.reply(formatMonth(summarizeMonth(txs, month)), {
    ...HTML,
    ...Markup.inlineKeyboard([
      Markup.button.callback("📥 Excel", `x:${month}`),
    ]),
  });
}

async function sendPerson(
  ctx: Context,
  user: UserRecord,
  name: string,
  month: string,
) {
  await ctx.sendChatAction("typing");
  const txs = await readTransactions(user.telegramId);
  if (!txs) return;
  await ctx.reply(formatPerson(personReport(txs, name, month)), HTML);
}

// ---------------------------------------------------------------- buttons

bot.action(/^p:([\w-]+):(in|out|x)$/, async (ctx) => {
  const [, id, choice] = ctx.match;
  const pending = await store.getPending(id);
  if (!pending || pending.telegramId !== ctx.from.id) {
    return ctx.answerCbQuery("الرسالة دي قديمة، ابعتها تاني.");
  }
  await store.deletePending(id);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  if (choice === "x") return ctx.reply("تمام، اتلغت ✖️");
  const user = await requireUser(ctx);
  if (!user) return;
  const txs = pending.transactions.map((p) =>
    toTransaction(p, p.type === "unknown" ? (choice as "in" | "out") : p.type),
  );
  await saveAndConfirm(ctx, user, txs);
});

bot.action(/^u:([\w,-]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await requireUser(ctx);
  if (!user) return;
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await undoIds(ctx, user, ctx.match[1].split(","));
});

bot.action("month", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await requireUser(ctx);
  if (user) await sendMonth(ctx, user, currentMonth());
});

bot.action(/^x:(\d{4}-\d{2})$/, async (ctx) => {
  await ctx.answerCbQuery("بجهز الملف…");
  const user = await requireUser(ctx);
  if (!user) return;
  const month = ctx.match[1];
  const txs = await readTransactions(user.telegramId);
  if (!txs) return;
  const file = await monthWorkbook(
    month,
    txs,
    summarizeMonth(txs, month),
    config.defaultCurrency,
  );
  await ctx.replyWithDocument({
    source: file,
    filename: `cashflow-${month}.xlsx`,
  });
});

bot.action("del:no", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("تمام، مفيش حاجة اتمسحت 👍");
});

bot.action("del:yes", async (ctx) => {
  await ctx.answerCbQuery();
  await deleteAll(ctx.from.id);
  await store.deleteUser(ctx.from.id);
  await ctx.editMessageText(
    "اتمسح كل حاجة ✅ لو حبيت تبدأ من جديد اكتب /start.",
  );
});

// ---------------------------------------------------------------- errors

bot.catch(async (error, ctx) => {
  console.error("Bot error:", error);
  const text = error instanceof Error ? error.message : String(error);
  const busy = /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE/.test(text);
  await ctx
    .reply(
      busy
        ? "⏳ خدمة القراءة مشغولة دلوقتي، جرب كمان دقيقة."
        : "❌ حصلت مشكلة، جرب تاني.",
    )
    .catch(() => {});
});

export const COMMANDS = [
  { command: "cashflow", description: "الوارد والمنصرف والرصيد" },
  { command: "person", description: "فلوس شخص معين" },
  { command: "export", description: "ملف Excel للشهر" },
  { command: "undo", description: "امسح آخر تسجيل" },
  { command: "help", description: "إزاي تستخدم البوت" },
  { command: "deleteall", description: "امسح كل حساباتك" },
];
