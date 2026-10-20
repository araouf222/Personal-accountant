/**
 * All settings come from environment variables (Vercel → Settings → Environment Variables).
 * See .env.example for the full list and what each one is for.
 */

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export const config = {
  get telegramToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  /** Random string; Telegram sends it back in a header so we know a webhook call is real. */
  get webhookSecret() {
    return optional("WEBHOOK_SECRET");
  },
  get geminiKey() {
    return required("GEMINI_API_KEY");
  },
  get geminiModel() {
    return optional("GEMINI_MODEL", "gemini-flash-latest");
  },
  get googleClientId() {
    return required("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret() {
    return required("GOOGLE_CLIENT_SECRET");
  },
  /** Public address of the deployment, e.g. https://my-cashflow-bot.vercel.app */
  get appUrl() {
    return required("APP_URL").replace(/\/+$/, "");
  },
  /** 32 random bytes, base64. Used to encrypt each user's Google token at rest. */
  get encryptionKey() {
    return required("ENCRYPTION_KEY");
  },
  get timezone() {
    return optional("APP_TIMEZONE", "Africa/Cairo");
  },
  get defaultCurrency() {
    return optional("DEFAULT_CURRENCY", "EGP");
  },
  /** How many AI-read messages each user gets per day (protects the shared Gemini key). */
  get aiDailyLimit() {
    return Number(optional("AI_DAILY_LIMIT", "60"));
  },
  /** Optional comma-separated Telegram IDs. Empty = anyone can use the bot. */
  get allowedUserIds(): Set<number> {
    return new Set(
      optional("ALLOWED_USER_IDS")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
  },
  get redisUrl() {
    return findEnv(["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]);
  },
  get redisToken() {
    return findEnv(["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"]);
  },
};

/**
 * Vercel's Upstash integration may add a custom prefix (e.g. STORAGE_KV_REST_API_URL),
 * so accept the exact names first, then any variable that ends with one of them.
 */
function findEnv(names: string[]): string {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value?.trim() && names.some((n) => key.endsWith(`_${n}`)))
      return value.trim();
  }
  throw new Error(`Missing environment variable: ${names.join(" or ")}`);
}
