import type { VercelRequest, VercelResponse } from "@vercel/node";
import { bot, HELP } from "../../src/bot.js";
import { encrypt } from "../../src/services/crypto.js";
import { isoDate } from "../../src/services/dates.js";
import { exchangeCode } from "../../src/services/google.js";
import { canOpen, createLedger, sheetUrl } from "../../src/services/ledger.js";
import * as store from "../../src/services/store.js";

export const config = { maxDuration: 60 };

function page(
  res: VercelResponse,
  status: number,
  title: string,
  body: string,
) {
  res
    .status(status)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;background:#f6f7f9;color:#1d2433;
display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{background:#fff;border-radius:16px;padding:28px;max-width:420px;box-shadow:0 2px 12px #0001;text-align:center;line-height:1.7}
h1{font-size:22px;margin:0 0 8px}a{color:#2563eb}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const stateId = typeof req.query.state === "string" ? req.query.state : "";

  if (req.query.error) {
    return page(
      res,
      400,
      "اتلغى الربط",
      "<p>ملحوظة: لازم توافق على الصلاحية علشان البوت يقدر يعمل الشيت. ارجع لتليجرام واكتب /start وجرب تاني.</p>",
    );
  }
  if (!code || !stateId)
    return page(
      res,
      400,
      "لينك غير صالح",
      "<p>ارجع لتليجرام واكتب /start.</p>",
    );

  const state = await store.takeOAuthState(stateId);
  if (!state) {
    return page(
      res,
      400,
      "اللينك انتهى",
      "<p>اللينك صالح ربع ساعة ومرة واحدة بس. ارجع لتليجرام واكتب /start علشان تاخد لينك جديد.</p>",
    );
  }

  try {
    const { client, refreshToken, hasScope } = await exchangeCode(code);
    if (!hasScope) {
      await bot.telegram.sendMessage(
        state.chatId,
        "⚠️ الربط ما كملش لأن صلاحية إنشاء الملفات ما اتعلمش عليها. اكتب /start وجرب تاني، وعلّم على كل الصلاحيات.",
      );
      return page(
        res,
        400,
        "ناقص صلاحية",
        "<p>لازم تعلّم على صلاحية «إنشاء ملفات في Google Drive». ارجع لتليجرام واكتب /start.</p>",
      );
    }

    // Reuse the user's old sheet if they're reconnecting and it's still reachable.
    const previous =
      (await store.getUser(state.telegramId))?.spreadsheetId ??
      (await store.previousSheet(state.telegramId));
    const spreadsheetId =
      previous && (await canOpen(client, previous))
        ? previous
        : await createLedger(client, state.name);

    await store.saveUser({
      telegramId: state.telegramId,
      spreadsheetId,
      refreshTokenEnc: encrypt(refreshToken),
      connectedAt: isoDate(),
    });
    await store.rememberSheet(state.telegramId, spreadsheetId);

    const reused = spreadsheetId === previous;
    await bot.telegram.sendMessage(
      state.chatId,
      `✅ تمام، اتربط حساب جوجل${reused ? " ورجعنا لنفس الشيت بتاعك" : " واتعملك شيت جديد"}.\n📄 ${sheetUrl(spreadsheetId)}\n\n${HELP}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return page(
      res,
      200,
      "تم الربط ✅",
      `<p>ارجع لتليجرام وابدأ سجل.</p><p><a href="${sheetUrl(spreadsheetId)}">افتح الشيت بتاعك</a></p>`,
    );
  } catch (error) {
    console.error("OAuth callback failed:", error);
    await bot.telegram
      .sendMessage(
        state.chatId,
        "❌ حصلت مشكلة وأنا بربط حساب جوجل. اكتب /start وجرب تاني.",
      )
      .catch(() => {});
    return page(
      res,
      500,
      "حصلت مشكلة",
      "<p>ارجع لتليجرام واكتب /start وجرب تاني.</p>",
    );
  }
}
