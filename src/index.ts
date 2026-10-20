/**
 * Local run (polling) for testing on your computer: `bun start`.
 * Sign-in with Google still needs APP_URL to point at a deployed callback,
 * so the easiest path is to test on Vercel directly.
 */
import { bot, COMMANDS } from "./bot.js";

await bot.telegram.deleteWebhook();
await bot.telegram.setMyCommands(COMMANDS);
console.log("Bot running in polling mode (local)…");
bot.launch();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
