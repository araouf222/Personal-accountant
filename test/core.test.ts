import { describe, expect, test } from "bun:test";
import { toTransaction } from "../src/bot.js";
import type {
  ParsedTransaction,
  Transaction,
} from "../src/schemas/transaction.js";
import { buildPrompt, parseAiJson } from "../src/services/ai.js";
import { decrypt, encrypt } from "../src/services/crypto.js";
import {
  isoDate,
  monthLabel,
  parseMonthArg,
  shiftMonth,
  westernDigits,
} from "../src/services/dates.js";
import {
  formatMonth,
  formatPerson,
  normalizeName,
  personReport,
  summarizeMonth,
} from "../src/services/report.js";

const NOW = new Date("2026-10-20T04:00:00Z"); // 07:00 in Cairo

function tx(partial: Partial<Transaction>): Transaction {
  const date = partial.date ?? "2026-10-05";
  return {
    id: Math.random().toString(36).slice(2, 10),
    date,
    type: "out",
    amount: 100,
    currency: "EGP",
    description: "x",
    category: "أخرى",
    person: "",
    source: "",
    month: date.slice(0, 7),
    createdAt: "",
    ...partial,
  };
}

describe("dates", () => {
  test("Cairo date", () => {
    expect(isoDate(new Date("2026-10-19T22:30:00Z"))).toBe("2026-10-20"); // after midnight in Cairo
  });
  test("month args", () => {
    expect(parseMonthArg("", NOW)).toBe("2026-10");
    expect(parseMonthArg("الشهر اللي فات", NOW)).toBe("2026-09");
    expect(parseMonthArg("سبتمبر", NOW)).toBe("2026-09");
    expect(parseMonthArg("ديسمبر", NOW)).toBe("2025-12"); // not in the future
    expect(parseMonthArg("مارس ٢٠٢٥", NOW)).toBe("2025-03");
    expect(parseMonthArg("2026-07", NOW)).toBe("2026-07");
    expect(parseMonthArg("7/2026", NOW)).toBe("2026-07");
    expect(parseMonthArg("حاجة غريبة", NOW)).toBeNull();
  });
  test("helpers", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthLabel("2026-10")).toBe("أكتوبر 2026");
    expect(westernDigits("١٥٠٠")).toBe("1500");
  });
});

describe("crypto", () => {
  test("round trip", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const secret = "1//refresh-token-example";
    const enc = encrypt(secret, key);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc, key)).toBe(secret);
  });
});

describe("AI output parsing", () => {
  test("keeps valid movements, drops broken ones", () => {
    const result = parseAiJson(`\`\`\`json
{"intent":"transaction","transactions":[
  {"type":"out","amount":2000,"currency":null,"description":"لمروة","category":"فلوس لشخص","person":"مروة","source":null,"date":null,"receipt_id":null},
  {"type":"out","amount":"abc","description":"bad"},
  {"type":"in","amount":"15000","currency":"EGP","description":"دفعة مشروع المول","category":"أتعاب مشروع","person":null,"source":"مشروع المول","date":"2026-10-19","receipt_id":null}
]}
\`\`\``);
    expect(result.intent).toBe("transaction");
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[1].amount).toBe(15000);
    expect(result.transactions[0].person).toBe("مروة");
  });
  test("unknown intent falls back to other", () => {
    expect(parseAiJson(`{"intent":"weird"}`).intent).toBe("other");
  });
  test("prompt carries known people and categories", () => {
    const p = buildPrompt({
      today: "2026-10-20",
      knownPeople: ["مروة"],
      currency: "EGP",
    });
    expect(p).toContain('"مروة"');
    expect(p).toContain("مستخلص");
  });
});

describe("turning AI output into rows", () => {
  const base: ParsedTransaction = {
    type: "out",
    amount: 2000,
    currency: "جنيه",
    description: "فلوس",
    category: "تصنيف مش موجود",
    person: "مروة",
    source: null,
    date: null,
    receipt_id: "INV-77",
  };
  test("defaults", () => {
    const t = toTransaction(base, "out", NOW);
    expect(t.currency).toBe("EGP");
    expect(t.date).toBe("2026-10-20");
    expect(t.month).toBe("2026-10");
    expect(t.category).toBe("فلوس لشخص");
    expect(t.description).toBe("فلوس [#INV-77]");
  });
});

describe("reports", () => {
  const data = [
    tx({
      type: "in",
      amount: 25000,
      source: "مشروع المول",
      date: "2026-10-01",
    }),
    tx({
      type: "out",
      amount: 1000,
      person: "مروة",
      category: "فلوس لشخص",
      date: "2026-10-05",
    }),
    tx({
      type: "out",
      amount: 2000,
      person: "مروه",
      category: "فلوس لشخص",
      date: "2026-10-12",
    }),
    tx({ type: "out", amount: 500, category: "بنزين", date: "2026-10-13" }),
    tx({
      type: "out",
      amount: 100,
      person: "يحيى",
      category: "فلوس لشخص",
      date: "2026-10-14",
    }),
    tx({ type: "in", amount: 10000, source: "مرتب", date: "2026-09-28" }),
    tx({ type: "out", amount: 4000, date: "2026-09-29" }),
  ];

  test("monthly totals", () => {
    const s = summarizeMonth(data, "2026-10");
    expect(s.income.EGP).toBe(25000);
    expect(s.spending.EGP).toBe(3600);
    expect(s.net.EGP).toBe(21400);
    expect(s.allTimeNet.EGP).toBe(27400); // includes September
    expect(s.people.find((p) => p.person === "مروة")?.given).toBe(3000); // مروه = مروة
    expect(formatMonth(s)).toContain("أكتوبر 2026");
  });

  test("person report merges spellings", () => {
    const r = personReport(data, "مروه", "2026-10");
    expect(r.entries).toHaveLength(2);
    expect(r.monthGiven).toBe(3000);
    expect(formatPerson(r)).toContain("3,000 ج.م");
  });

  test("name normalisation", () => {
    expect(normalizeName("مروة")).toBe(normalizeName("مروه"));
    expect(normalizeName("أحمد")).toBe(normalizeName("احمد"));
    expect(normalizeName("لبنى")).not.toBe(normalizeName("بنى"));
  });

  test("html-escapes user text", () => {
    const r = personReport(
      [tx({ person: "<b>x", description: "a & b" })],
      "<b>x",
      "2026-10",
    );
    expect(formatPerson(r)).toContain("&lt;b&gt;x");
  });
});
