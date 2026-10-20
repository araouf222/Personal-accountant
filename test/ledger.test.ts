/** The real ledger code against an in-memory stand-in for Upstash Redis. */
import { expect, mock, test } from "bun:test";
import type { Transaction } from "../src/schemas/transaction.js";

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
process.env.KV_REST_API_URL = "https://fake.upstash.io";
process.env.KV_REST_API_TOKEN = "t";

const hashes = new Map<string, Map<string, string>>();
mock.module("@upstash/redis", () => ({
  Redis: class {
    async hset(key: string, fields: Record<string, string>) {
      const h = hashes.get(key) ?? new Map();
      for (const [k, v] of Object.entries(fields)) h.set(k, v);
      hashes.set(key, h);
      return Object.keys(fields).length;
    }
    async hgetall(key: string) {
      const h = hashes.get(key);
      return h ? Object.fromEntries(h) : null;
    }
    async hdel(key: string, ...ids: string[]) {
      const h = hashes.get(key);
      return ids.filter((id) => h?.delete(id)).length;
    }
    async del(key: string) {
      return hashes.delete(key) ? 1 : 0;
    }
  },
}));

const ledger = await import("../src/services/ledger.js");

const tx = (id: string, date: string, amount: number): Transaction => ({
  id,
  date,
  type: "out",
  amount,
  currency: "EGP",
  description: "لمروة",
  category: "فلوس لشخص",
  person: "مروة",
  source: "",
  month: date.slice(0, 7),
  createdAt: `${date} 10:00:00`,
});

test("save, read back (sorted, decrypted), delete", async () => {
  await ledger.appendTransactions(42, [
    tx("b", "2026-10-12", 2000),
    tx("a", "2026-10-05", 1000),
  ]);
  await ledger.appendTransactions(7, [tx("z", "2026-10-01", 5)]); // another user

  const stored = [...(hashes.get("tx:42")?.values() ?? [])].join(" ");
  expect(stored).not.toContain("مروة"); // encrypted at rest

  const mine = await ledger.readTransactions(42);
  expect(mine.map((t) => t.id)).toEqual(["a", "b"]);
  expect(mine[1].person).toBe("مروة");

  expect(await ledger.deleteByIds(42, ["a"])).toBe(1);
  expect((await ledger.readTransactions(42)).map((t) => t.id)).toEqual(["b"]);

  await ledger.deleteAll(42);
  expect(await ledger.readTransactions(42)).toEqual([]);
  expect(await ledger.readTransactions(7)).toHaveLength(1); // other user untouched
});
