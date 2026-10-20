import { config } from "../config.js";

/** YYYY-MM-DD for a moment, in the app timezone (Africa/Cairo by default). */
export function isoDate(date: Date = new Date(), tz = config.timezone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

/** YYYY-MM-DD HH:mm:ss in the app timezone. */
export function timestamp(
  date: Date = new Date(),
  tz = config.timezone,
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}:${p("second")}`;
}

export function monthOf(isoDay: string): string {
  return isoDay.slice(0, 7);
}

export function currentMonth(now: Date = new Date()): string {
  return monthOf(isoDate(now));
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const AR_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

const MONTH_ALIASES: Record<string, number> = {
  يناير: 1,
  فبراير: 2,
  مارس: 3,
  ابريل: 4,
  إبريل: 4,
  أبريل: 4,
  مايو: 5,
  يونيو: 6,
  يونيه: 6,
  يوليو: 7,
  يوليه: 7,
  اغسطس: 8,
  أغسطس: 8,
  سبتمبر: 9,
  اكتوبر: 10,
  أكتوبر: 10,
  نوفمبر: 11,
  ديسمبر: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${AR_MONTHS[m - 1]} ${y}`;
}

/** Turns Arabic-Indic digits into Western ones. */
export function westernDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Reads a month from a short command argument.
 * Accepts: "" (this month), "اللي فات"/"الماضي"/"last", "2026-09", "9/2026", "سبتمبر", "سبتمبر 2025".
 * Returns YYYY-MM, or null if it can't tell.
 */
export function parseMonthArg(
  arg: string,
  now: Date = new Date(),
): string | null {
  const text = westernDigits(arg).trim().toLowerCase();
  const thisMonth = currentMonth(now);
  if (!text || text === "الشهر ده" || text === "this" || text === "now")
    return thisMonth;
  if (/(اللي فات|الماضي|السابق|last|prev)/.test(text))
    return shiftMonth(thisMonth, -1);

  let match = text.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (match) return fmt(Number(match[1]), Number(match[2]));
  match = text.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (match) return fmt(Number(match[2]), Number(match[1]));

  const yearMatch = text.match(/\d{4}/);
  for (const [name, m] of Object.entries(MONTH_ALIASES)) {
    if (text.includes(name)) {
      if (yearMatch) return fmt(Number(yearMatch[0]), m);
      // No year: the most recent such month that isn't in the future.
      const [cy, cm] = thisMonth.split("-").map(Number);
      return fmt(m > cm ? cy - 1 : cy, m);
    }
  }
  return null;
}

function fmt(year: number, month: number): string | null {
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}`;
}
