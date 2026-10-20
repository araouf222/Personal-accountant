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
import { authUrl, clientFor, isAuthGone, revoke } from "./services/google.js";
import {
  appendTransactions,
  deleteByIds,
  readTransactions,
  sheetUrl,
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
/sheet – لينك الشيت بتاعك
/undo – امسح آخر حاجة اتسجلت
/disconnect – افصل حساب جوجل`;

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

async function connectPrompt(ctx: Context, intro: string) {
  if (!ctx.from || !ctx.chat) return;
  const state = await store.createOAuthState({
    telegramId: ctx.from.id,
    chatId: ctx.chat.id,
    name: ctx.from.first_name ?? "",
  });
  await ctx.reply(
    `${intro}\n\nاضغط الزرار، ادخل بحساب جوجل بتاعك ووافق. هعملك شيت "كاش فلو" في الـ Drive بتاعك، وأنا مش هقدر أشوف أي ملف تاني غيره.\n\n(اللينك صالح ربع ساعة)`,
    Markup.inlineKeyboard([
      Markup.button.url("🔗 اربط حساب جوجل", authUrl(state)),
    ]),
  );
}

async function requireUser(ctx: Context): Promise<UserRecord | null> {
  if (!ctx.from) return null;
  const user = await store.getUser(ctx.from.id);
  if (!user) {
    await connectPrompt(
      ctx,
      "أهلاً! 👋 قبل ما نبدأ محتاج تربط حساب جوجل علشان أسجل حساباتك في شيت خاص بيك.",
    );
    return null;
  }
  return user;
}

/** Runs sheet work; if Google access is gone, asks the user to reconnect. */
async function withSheet<T>(
  ctx: Context,
  user: UserRecord,
  work: (client: ReturnType<typeof clientFor>) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work(clientFor(user.refreshTokenEnc));
  } catch (error) {
    if (isAuthGone(error)) {
      await store.rememberSheet(user.telegramId, user.spreadsheetId);
      await store.deleteUser(user.telegramId);
      await connectPrompt(
        ctx,
        "⚠️ صلاحية الوصول لحساب جوجل انتهت أو اتلغت. اربط الحساب تاني وهكمل على نفس الشيت.",
      );
      return undefined;
    }
    throw error;
  }
}

// ---------------------------------------------------------------- commands

bot.start(async (ctx) => {
  const user = await store.getUser(ctx.from.id);
  if (!user) {
    await connectPrompt(
      ctx,
      "أهلاً بيك في بوت الكاش فلو 💰\nسجل الفلوس اللي بتدخلك واللي بتصرفها بالكلام أو بصورة الفاتورة، وآخر الشهر تعرف حساباتك شكلها إيه.",
    );
    return;
  }
  await ctx.reply(`أهلاً تاني 👋\n\n${HELP}`, HTML);
});

bot.help((ctx) => ctx.reply(HELP, HTML));

bot.command("sheet", async (ctx) => {
  const user = await requireUser(ctx);
  if (user) await ctx.reply(`📄 الشيت بتاعك:\n${sheetUrl(user.spreadsheetId)}`);
});

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
  const txs = await withSheet(ctx, user, (c) =>
    readTransactions(c, user.spreadsheetId),
  );
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

bot.command("disconnect", async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await ctx.reply(
    "متأكد إنك عاوز تفصل حساب جوجل؟\nالشيت هيفضل عندك في الـ Drive زي ما هو، بس البوت مش هيقدر يسجل فيه لحد ما تربط تاني.",
    Markup.inlineKeyboard([
      Markup.button.callback("أيوه افصل", "disc:yes"),
      Markup.button.callback("لأ", "disc:no"),
    ]),
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
  const saved = await withSheet(ctx, user, async (client) => {
    // Skip receipts already recorded (same printed invoice number).
    const receipts = txs
      .map((t) => t.description.match(/\[#(.+)\]$/)?.[0])
      .filter(Boolean);
    let toSave = txs;
    let skipped = 0;
    if (receipts.length) {
      const existing = await readTransactions(client, user.spreadsheetId);
      toSave = txs.filter((t) => {
        const tag = t.description.match(/\[#(.+)\]$/)?.[0];
        const dup = tag && existing.some((e) => e.description.endsWith(tag));
        if (dup) skipped++;
        return !dup;
      });
    }
    if (toSave.length)
      await appendTransactions(client, user.spreadsheetId, toSave);
    return { toSave, skipped };
  });
  if (!saved) return;

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
  const removed = await withSheet(ctx, user, (c) =>
    deleteByIds(c, user.spreadsheetId, ids),
  );
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
  const txs = await withSheet(ctx, user, (c) =>
    readTransactions(c, user.spreadsheetId),
  );
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
  const txs = await withSheet(ctx, user, (c) =>
    readTransactions(c, user.spreadsheetId),
  );
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
  const txs = await withSheet(ctx, user, (c) =>
    readTransactions(c, user.spreadsheetId),
  );
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

bot.action("disc:no", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("تمام، مفيش حاجة اتغيرت 👍");
});

bot.action("disc:yes", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await store.getUser(ctx.from.id);
  if (user) {
    await revoke(user.refreshTokenEnc);
    await store.rememberSheet(user.telegramId, user.spreadsheetId);
    await store.deleteUser(user.telegramId);
  }
  await ctx.editMessageText(
    "اتفصل ✅ الشيت لسه في الـ Drive بتاعك. لو حبيت ترجع اكتب /start.",
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
  { command: "sheet", description: "لينك الشيت بتاعك" },
  { command: "undo", description: "امسح آخر تسجيل" },
  { command: "help", description: "إزاي تستخدم البوت" },
  { command: "disconnect", description: "افصل حساب جوجل" },
];
