import { Redis } from "@upstash/redis";
import { config } from "../config.js";
import type { Transaction } from "../schemas/transaction.js";
import { decrypt, encrypt } from "./crypto.js";

/**
 * Each user's movements live in one Redis hash: tx:<telegramId> → { id: encrypted JSON }.
 * Every entry is encrypted with ENCRYPTION_KEY, so the raw database shows nothing readable.
 * (Google Sheets storage can be added later as an extra; see git history.)
 */
let redis: Redis | null = null;
function db() {
  redis ??= new Redis({
    url: config.redisUrl,
    token: config.redisToken,
    automaticDeserialization: false,
  });
  return redis;
}

const key = (userId: number) => `tx:${userId}`;

export async function appendTransactions(
  userId: number,
  txs: Transaction[],
): Promise<void> {
  if (!txs.length) return;
  const fields: Record<string, string> = {};
  for (const t of txs) fields[t.id] = encrypt(JSON.stringify(t));
  await db().hset(key(userId), fields);
}

export async function readTransactions(userId: number): Promise<Transaction[]> {
  const all = (await db().hgetall<Record<string, string>>(key(userId))) ?? {};
  const out: Transaction[] = [];
  for (const value of Object.values(all)) {
    try {
      out.push(JSON.parse(decrypt(String(value))) as Transaction);
    } catch (error) {
      console.warn("Skipping unreadable entry:", error);
    }
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
  );
}

/** Deletes entries by ID. Returns how many were removed. */
export async function deleteByIds(
  userId: number,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  return db().hdel(key(userId), ...ids);
}

/** Removes every movement the user recorded. */
export async function deleteAll(userId: number): Promise<void> {
  await db().del(key(userId));
}
