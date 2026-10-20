import { config } from "../config.js";
import type { Transaction } from "../schemas/transaction.js";
import { monthLabel } from "./dates.js";

/** Makes Arabic names comparable: مروه = مروة, أحمد = احمد, ignores diacritics and spacing. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "") // harakat + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Escapes text for Telegram HTML messages. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function money(
  amount: number,
  currency = config.defaultCurrency,
): string {
  const n = Math.round(amount * 100) / 100;
  const text = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return currency === "EGP" ? `${text} ج.م` : `${text} ${currency}`;
}

type Totals = Record<string, number>; // per currency

function add(totals: Totals, currency: string, amount: number) {
  totals[currency] = (totals[currency] ?? 0) + amount;
}

function fmtTotals(totals: Totals): string {
  const entries = Object.entries(totals).filter(([, v]) => v !== 0);
  if (!entries.length) return money(0);
  return entries.map(([c, v]) => money(v, c)).join(" + ");
}

export interface MonthSummary {
  month: string;
  income: Totals;
  spending: Totals;
  net: Totals;
  allTimeNet: Totals;
  topSpending: { category: string; total: number }[];
  topIncome: { source: string; total: number }[];
  people: { person: string; given: number; received: number }[];
  count: number;
}

export function summarizeMonth(
  txs: Transaction[],
  month: string,
): MonthSummary {
  const main = config.defaultCurrency;
  const income: Totals = {};
  const spending: Totals = {};
  const net: Totals = {};
  const allTimeNet: Totals = {};
  const byCategory = new Map<string, number>();
  const bySource = new Map<string, number>();
  const people = new Map<
    string,
    { person: string; given: number; received: number }
  >();
  let count = 0;

  for (const t of txs) {
    const sign = t.type === "in" ? 1 : -1;
    if (t.month <= month) add(allTimeNet, t.currency, sign * t.amount);
    if (t.month !== month) continue;
    count++;
    add(t.type === "in" ? income : spending, t.currency, t.amount);
    add(net, t.currency, sign * t.amount);
    if (t.currency !== main) continue;
    if (t.type === "out") {
      const key = t.category || "أخرى";
      byCategory.set(key, (byCategory.get(key) ?? 0) + t.amount);
    } else {
      const key = t.source || t.person || t.category || "أخرى";
      bySource.set(key, (bySource.get(key) ?? 0) + t.amount);
    }
    if (t.person) {
      const key = normalizeName(t.person);
      const entry = people.get(key) ?? {
        person: t.person,
        given: 0,
        received: 0,
      };
      if (t.type === "out") entry.given += t.amount;
      else entry.received += t.amount;
      people.set(key, entry);
    }
  }

  const top = <K extends string>(m: Map<string, number>, k: K) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(
        ([name, total]) =>
          ({ [k]: name, total }) as Record<K, string> & { total: number },
      );

  return {
    month,
    income,
    spending,
    net,
    allTimeNet,
    topSpending: top(byCategory, "category"),
    topIncome: top(bySource, "source"),
    people: [...people.values()].sort(
      (a, b) => b.given + b.received - (a.given + a.received),
    ),
    count,
  };
}

export function formatMonth(s: MonthSummary): string {
  const lines = [`📊 <b>كاش فلو ${monthLabel(s.month)}</b>`, ""];
  if (!s.count) {
    lines.push("مفيش حركات متسجلة في الشهر ده.");
  } else {
    lines.push(`🟢 الوارد: ${fmtTotals(s.income)}`);
    lines.push(`🔴 المنصرف: ${fmtTotals(s.spending)}`);
    lines.push(`💰 صافي الشهر: ${fmtTotals(s.net)}`);
  }
  lines.push(`🏦 الرصيد من أول التسجيل: ${fmtTotals(s.allTimeNet)}`);

  if (s.topIncome.length) {
    lines.push("", "<b>الوارد جه منين:</b>");
    for (const x of s.topIncome.slice(0, 5))
      lines.push(`• ${esc(x.source)}: ${money(x.total)}`);
  }
  if (s.topSpending.length) {
    lines.push("", "<b>أكبر بنود الصرف:</b>");
    for (const x of s.topSpending.slice(0, 6))
      lines.push(`• ${esc(x.category)}: ${money(x.total)}`);
  }
  const given = s.people.filter((p) => p.given > 0);
  if (given.length) {
    lines.push("", "<b>فلوس اديتها لأشخاص:</b>");
    for (const p of given.slice(0, 8))
      lines.push(`• ${esc(p.person)}: ${money(p.given)}`);
  }
  return lines.join("\n");
}

export interface PersonReport {
  name: string;
  month: string;
  entries: Transaction[];
  monthGiven: number;
  monthReceived: number;
  allGiven: number;
  allReceived: number;
}

export function personReport(
  txs: Transaction[],
  name: string,
  month: string,
): PersonReport {
  const key = normalizeName(name);
  const mine = txs.filter((t) => t.person && normalizeName(t.person) === key);
  const main = config.defaultCurrency;
  const sum = (list: Transaction[], type: "in" | "out") =>
    list
      .filter((t) => t.type === type && t.currency === main)
      .reduce((a, t) => a + t.amount, 0);
  const inMonth = mine.filter((t) => t.month === month);
  return {
    name: mine[0]?.person ?? name,
    month,
    entries: inMonth.sort((a, b) => a.date.localeCompare(b.date)),
    monthGiven: sum(inMonth, "out"),
    monthReceived: sum(inMonth, "in"),
    allGiven: sum(mine, "out"),
    allReceived: sum(mine, "in"),
  };
}

export function formatPerson(r: PersonReport): string {
  const lines = [`👤 <b>${esc(r.name)} – ${monthLabel(r.month)}</b>`, ""];
  if (!r.entries.length) {
    lines.push("مفيش فلوس متسجلة معاه/معاها في الشهر ده.");
  } else {
    for (const t of r.entries) {
      const arrow = t.type === "out" ? "⬅️ اديته" : "➡️ جالي منه";
      const note =
        t.description && t.description !== "بدون بيان"
          ? ` – ${esc(t.description)}`
          : "";
      lines.push(
        `${t.date.slice(5)}  ${arrow} ${money(t.amount, t.currency)}${note}`,
      );
    }
    lines.push("");
    if (r.monthGiven)
      lines.push(`<b>اديته الشهر ده: ${money(r.monthGiven)}</b>`);
    if (r.monthReceived)
      lines.push(`<b>جالي منه الشهر ده: ${money(r.monthReceived)}</b>`);
  }
  if (r.allGiven || r.allReceived) {
    lines.push(
      "",
      `من أول التسجيل: اديته ${money(r.allGiven)} · جالي منه ${money(r.allReceived)}`,
    );
  }
  return lines.join("\n");
}
