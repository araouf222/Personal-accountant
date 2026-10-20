import type { VercelRequest, VercelResponse } from "@vercel/node";
import { bot } from "../src/bot.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // Telegram echoes the secret we gave it in set-webhook; anything else is not Telegram.
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).send("Unauthorized");
  }

  try {
    await bot.handleUpdate(req.body);
  } catch (err) {
    console.error("Webhook error:", err);
  }
  // Always 200, otherwise Telegram keeps re-sending the same message.
  res.status(200).send("ok");
}
