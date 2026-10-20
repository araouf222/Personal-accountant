/**
 * Points Telegram at your Vercel deployment and sets the bot's command menu.
 * Usage:  bun scripts/set-webhook.ts https://your-app.vercel.app
 * Needs TELEGRAM_BOT_TOKEN and WEBHOOK_SECRET in the environment (or a .env file).
 */
import { bot, COMMANDS } from "../src/bot.js";

const url = (process.argv[2] || process.env.APP_URL || "").replace(/\/+$/, "");
const secret = process.env.WEBHOOK_SECRET;

if (!url) {
  console.error(
    "Give the deployment URL: bun scripts/set-webhook.ts https://your-app.vercel.app",
  );
  process.exit(1);
}
if (!process.env.TELEGRAM_BOT_TOKEN || !secret) {
  console.error("TELEGRAM_BOT_TOKEN and WEBHOOK_SECRET must be set.");
  process.exit(1);
}

await bot.telegram.setWebhook(`${url}/api/webhook`, {
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
await bot.telegram.setMyCommands(COMMANDS);
await bot.telegram.setMyDescription(
  "سجل الفلوس اللي بتدخلك واللي بتصرفها بالكلام أو بصورة الفاتورة، وآخر الشهر اعرف حساباتك.",
);
console.log("✅ Webhook set to", `${url}/api/webhook`);
console.log("ℹ️ ", await bot.telegram.getWebhookInfo());
process.exit(0);
