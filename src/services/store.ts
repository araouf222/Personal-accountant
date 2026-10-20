import { Redis } from "@upstash/redis";
import { config } from "../config.js";
import type { ParsedTransaction } from "../schemas/transaction.js";
import { randomId } from "./crypto.js";
import { isoDate } from "./dates.js";

/**
 * Small key-value store (Upstash Redis, free tier). It holds ONLY:
 * - which Google sheet belongs to which Telegram user, and that user's Google token (encrypted)
 * - short-lived things: sign-in links, unconfirmed entries, daily AI counters, the people list
 * The money data itself lives only in each user's own Google Sheet.
 */
let redis: Redis | null = null;
function db() {
  redis ??= new Redis({ url: config.redisUrl, token: config.redisToken });
  return redis;
}

export interface UserRecord {
  telegramId: number;
  spreadsheetId: string;
  refreshTokenEnc: string;
  connectedAt: string;
}

const DAY = 60 * 60 * 24;

export async function getUser(telegramId: number): Promise<UserRecord | null> {
  return (await db().get<UserRecord>(`user:${telegramId}`)) ?? null;
}

export async function saveUser(user: UserRecord): Promise<void> {
  await db().set(`user:${user.telegramId}`, user);
}

export async function deleteUser(telegramId: number): Promise<void> {
  await db().del(
    `user:${telegramId}`,
    `people:${telegramId}`,
    `last:${telegramId}`,
    `ai:${telegramId}:${isoDate()}`,
  );
}

/** Remembers the sheet id even after disconnecting, so reconnecting can reuse the same sheet. */
export async function rememberSheet(telegramId: number, spreadsheetId: string) {
  await db().set(`sheet:${telegramId}`, spreadsheetId);
}
export async function previousSheet(
  telegramId: number,
): Promise<string | null> {
  return (await db().get<string>(`sheet:${telegramId}`)) ?? null;
}

export interface OAuthState {
  telegramId: number;
  chatId: number;
  name: string;
}

export async function createOAuthState(state: OAuthState): Promise<string> {
  const id = randomId(18);
  await db().set(`oauth:${id}`, state, { ex: 15 * 60 });
  return id;
}

/** One-time use: reading the state also deletes it. */
export async function takeOAuthState(id: string): Promise<OAuthState | null> {
  return (await db().getdel<OAuthState>(`oauth:${id}`)) ?? null;
}

export interface Pending {
  telegramId: number;
  transactions: ParsedTransaction[];
}

export async function savePending(pending: Pending): Promise<string> {
  const id = randomId(6);
  await db().set(`pending:${id}`, pending, { ex: DAY });
  return id;
}

export async function getPending(id: string): Promise<Pending | null> {
  return (await db().get<Pending>(`pending:${id}`)) ?? null;
}

export async function updatePending(
  id: string,
  pending: Pending,
): Promise<void> {
  await db().set(`pending:${id}`, pending, { ex: DAY });
}

export async function deletePending(id: string): Promise<void> {
  await db().del(`pending:${id}`);
}

export async function knownPeople(telegramId: number): Promise<string[]> {
  return (await db().smembers(`people:${telegramId}`)) ?? [];
}

export async function addPeople(
  telegramId: number,
  names: string[],
): Promise<void> {
  const clean = names.filter(Boolean);
  if (clean.length)
    await db().sadd(`people:${telegramId}`, clean[0], ...clean.slice(1));
}

/** The row IDs written by the user's last message, for /undo. */
export async function setLastSaved(
  telegramId: number,
  ids: string[],
): Promise<void> {
  await db().set(`last:${telegramId}`, ids, { ex: 7 * DAY });
}

export async function takeLastSaved(telegramId: number): Promise<string[]> {
  return (await db().getdel<string[]>(`last:${telegramId}`)) ?? [];
}

/** Counts one AI call. Returns false once the user is over today's limit. */
export async function useAiQuota(telegramId: number): Promise<boolean> {
  const key = `ai:${telegramId}:${isoDate()}`;
  const count = await db().incr(key);
  if (count === 1) await db().expire(key, 2 * DAY);
  return count <= config.aiDailyLimit;
}
