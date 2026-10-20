/**
 * End-to-end wiring test: real bot handlers, with Telegram, Redis, Google and Gemini faked.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AiResult, Transaction } from "../src/schemas/transaction.js";

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
process.env.APP_URL = "https://example.vercel.app";
process.env.GOOGLE_CLIENT_ID = "cid";
process.env.GOOGLE_CLIENT_SECRET = "secret";

// ---- fake store
const kv = new Map<string, unknown>();
let aiCount = 0;
mock.module("../src/services/store.js", () => ({
  getUser: async (id: number) => kv.get(`user:${id}`) ?? null,
  saveUser: async (u: { telegramId: number }) =>
    void kv.set(`user:${u.telegramId}`, u),
  deleteUser: async (id: number) => void kv.delete(`user:${id}`),
  rememberSheet: async () => {},
  previousSheet: async () => null,
  createOAuthState: async () => "state123",
  takeOAuthState: async () => null,
  savePending: async (p: unknown) => {
    kv.set("pending:P1", p);
    return "P1";
  },
  getPending: async (id: string) => kv.get(`pending:${id}`) ?? null,
  updatePending: async () => {},
  deletePending: async (id: string) => void kv.delete(`pending:${id}`),
  knownPeople: async () => ["مروة"],
  addPeople: async () => {},
  setLastSaved: async (_: number, ids: string[]) => void kv.set("last", ids),
  takeLastSaved: async () => (kv.get("last") as string[]) ?? [],
  useAiQuota: async () => ++aiCount <= 100,
}));

// ---- fake sheet
let sheet: Transaction[] = [];
mock.module("../src/services/ledger.js", () => ({
  appendTransactions: async (_c: unknown, _id: string, txs: Transaction[]) =>
    void sheet.push(...txs),
  readTransactions: async () => sheet,
  deleteByIds: async (_c: unknown, _id: string, ids: string[]) => {
    const before = sheet.length;
    sheet = sheet.filter((t) => !ids.includes(t.id));
    return before - sheet.length;
  },
  sheetUrl: (id: string) => `https://docs.google.com/spreadsheets/d/${id}`,
}));

// ---- fake Gemini
let nextAi: AiResult;
mock.module("../src/services/ai.js", () => ({ interpret: async () => nextAi }));

const { bot } = await import("../src/bot.js");
const { Telegram } = await import("telegraf");
const { encrypt } = await import("../src/services/crypto.js");

// ---- fake Telegram API: capture what the bot sends
const sent: { method: string; payload: Record<string, unknown> }[] = [];
bot.botInfo = {
  id: 1,
  is_bot: true,
  first_name: "Bot",
  username: "cash_bot",
} as never;
Telegram.prototype.callApi = (async (
  method: string,
  payload: Record<string, unknown>,
) => {
  sent.push({ method, payload });
  return method === "sendMessage" ? { message_id: sent.length } : true;
}) as never;

const USER = { id: 42, is_bot: false, first_name: "Ahmed" };
let updateId = 1;
const textUpdate = (text: string) => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: 42, type: "private" },
    from: USER,
    text,
    ...(text.startsWith("/")
      ? {
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: text.split(" ")[0].length,
            },
          ],
        }
      : {}),
  },
});
const buttonUpdate = (data: string) => ({
  update_id: updateId++,
  callback_query: {
    id: String(updateId),
    from: USER,
    chat_instance: "x",
    data,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: 42, type: "private" },
      text: "q",
    },
  },
});
const lastText = () =>
  String(
    [...sent].reverse().find((s) => s.method === "sendMessage")?.payload.text ??
      "",
  );

const tx = (over: Partial<AiResult["transactions"][number]>) => ({
  type: "out" as const,
  amount: 100,
  currency: null,
  description: "بند",
  category: null,
  person: null,
  source: null,
  date: null,
  receipt_id: null,
  ...over,
});

beforeEach(() => {
  sent.length = 0;
});

describe("bot flow", () => {
  test("new user is asked to connect Google", async () => {
    await bot.handleUpdate(textUpdate("/start") as never);
    expect(lastText()).toContain("اضغط الزرار");
    const markup = JSON.stringify(sent.at(-1)?.payload.reply_markup);
    expect(markup).toContain("accounts.google.com");
    expect(markup).toContain("drive.file");
  });

  test("connected user records two people in one message", async () => {
    kv.set("user:42", {
      telegramId: 42,
      spreadsheetId: "SHEET",
      refreshTokenEnc: encrypt("rt"),
      connectedAt: "2026-10-20",
    });
    nextAi = {
      intent: "transaction",
      transactions: [
        tx({ amount: 2000, person: "مروة", description: "لمروة" }),
        tx({ amount: 100, person: "يحيى", description: "ليحيى" }),
      ],
      query_month: null,
      query_person: null,
      reply: null,
    };
    await bot.handleUpdate(textUpdate("اديت مروة 2000 ويحيى 100") as never);
    expect(sheet).toHaveLength(2);
    expect(lastText()).toContain("اتسجل");
    expect(lastText()).toContain("2,000 ج.م");
  });

  test("income is recorded", async () => {
    nextAi = {
      intent: "transaction",
      transactions: [
        tx({
          type: "in",
          amount: 15000,
          source: "مشروع المول",
          category: "أتعاب مشروع",
        }),
      ],
      query_month: null,
      query_person: null,
      reply: null,
    };
    await bot.handleUpdate(textUpdate("جالي 15000 من مشروع المول") as never);
    expect(sheet.at(-1)?.type).toBe("in");
    expect(sheet.at(-1)?.category).toBe("أتعاب مشروع");
  });

  test("unclear direction asks, then saves on button press", async () => {
    nextAi = {
      intent: "transaction",
      transactions: [
        tx({ type: "unknown", amount: 700, description: "حساب مع خالد" }),
      ],
      query_month: null,
      query_person: null,
      reply: null,
    };
    const before = sheet.length;
    await bot.handleUpdate(textUpdate("700 خالد") as never);
    expect(lastText()).toContain("وارد");
    expect(sheet.length).toBe(before);
    await bot.handleUpdate(buttonUpdate("p:P1:out") as never);
    expect(sheet.length).toBe(before + 1);
    expect(sheet.at(-1)?.type).toBe("out");
  });

  test("/undo removes the last saved entry", async () => {
    const before = sheet.length;
    await bot.handleUpdate(textUpdate("/undo") as never);
    expect(sheet.length).toBe(before - 1);
    expect(lastText()).toContain("اتمسح");
  });

  test("/cashflow shows the month", async () => {
    await bot.handleUpdate(textUpdate("/cashflow") as never);
    const text = lastText();
    expect(text).toContain("الوارد: 15,000 ج.م");
    expect(text).toContain("المنصرف: 2,100 ج.م");
  });

  test("natural question about a person", async () => {
    nextAi = {
      intent: "person_query",
      transactions: [],
      query_month: null,
      query_person: "مروه",
      reply: null,
    };
    await bot.handleUpdate(textUpdate("مروه خدت كام الشهر ده؟") as never);
    expect(lastText()).toContain("2,000 ج.م");
  });

  test("/export sends an Excel file", async () => {
    await bot.handleUpdate(textUpdate("/export") as never);
    expect(sent.some((s) => s.method === "sendDocument")).toBe(true);
  });

  test("group chats are ignored", async () => {
    const u = textUpdate("/cashflow") as {
      message: { chat: { type: string } };
    };
    u.message.chat.type = "group";
    await bot.handleUpdate(u as never);
    expect(sent).toHaveLength(0);
  });
});
