import type { VercelRequest, VercelResponse } from "@vercel/node";
import { bot, COMMANDS } from "../src/bot.js";

/**
 * One-time setup from the browser (no computer tools needed):
 *   https://your-app.vercel.app/api/setup?key=YOUR_WEBHOOK_SECRET
 * Connects Telegram to this deployment and sets the bot's command menu.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.key !== secret) {
    return res.status(401).send("Unauthorized");
  }
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  const url = (process.env.APP_URL || `https://${host}`).replace(/\/+$/, "");
  try {
    await bot.telegram.setWebhook(`${url}/api/webhook`, {
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await bot.telegram.setMyCommands(COMMANDS);
    await bot.telegram.setMyDescription(
      "سجل الفلوس اللي بتدخلك واللي بتصرفها بالكلام أو بصورة الفاتورة، وآخر الشهر اعرف حساباتك.",
    );
    await bot.telegram.setMyShortDescription("دفتر وارد ومنصرف خاص بيك 💰");
    const info = await bot.telegram.getWebhookInfo();
    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .send(
        `<html dir="rtl"><body style="font-family:system-ui;padding:24px;line-height:1.8">
<h2>✅ البوت اتربط بتليجرام</h2><p>العنوان: <code>${info.url}</code></p>
<p>افتح البوت في تليجرام واكتب /start</p></body></html>`,
      );
  } catch (error) {
    console.error("Setup failed:", error);
    res
      .status(500)
      .send(`Setup failed: ${error instanceof Error ? error.message : error}`);
  }
}
