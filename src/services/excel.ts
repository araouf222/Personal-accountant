import ExcelJS from "exceljs";
import { type Transaction, TYPE_LABEL } from "../schemas/transaction.js";
import { monthLabel } from "./dates.js";
import type { MonthSummary } from "./report.js";

const GREEN = "FF1B7F4B";
const RED = "FFB3261E";
const HEAD = "FF1F3A5F";

/** A one-month Excel report: summary tab + all movements of the month. */
export async function monthWorkbook(
  month: string,
  txs: Transaction[],
  summary: MonthSummary,
  currency: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Cashflow bot";
  wb.created = new Date();

  // --- Summary
  const s = wb.addWorksheet("الملخص", { views: [{ rightToLeft: true }] });
  s.columns = [{ width: 34 }, { width: 18 }];
  s.addRow([`كاش فلو ${monthLabel(month)}`]).font = { bold: true, size: 14 };
  s.addRow([]);
  const money = (n: number) => Math.round(n * 100) / 100;
  const line = (label: string, value: number, color?: string) => {
    const r = s.addRow([label, money(value)]);
    r.getCell(2).numFmt = "#,##0.00";
    if (color) r.getCell(2).font = { bold: true, color: { argb: color } };
  };
  line(`الوارد (${currency})`, summary.income[currency] ?? 0, GREEN);
  line(`المنصرف (${currency})`, summary.spending[currency] ?? 0, RED);
  line(`صافي الشهر (${currency})`, summary.net[currency] ?? 0);
  line(
    `الرصيد من أول التسجيل (${currency})`,
    summary.allTimeNet[currency] ?? 0,
  );

  const block = (title: string, rows: [string, number][]) => {
    if (!rows.length) return;
    s.addRow([]);
    s.addRow([title]).font = { bold: true };
    for (const [name, value] of rows) line(name, value);
  };
  block(
    "الوارد جه منين",
    summary.topIncome.map((x) => [x.source, x.total]),
  );
  block(
    "المنصرف حسب التصنيف",
    summary.topSpending.map((x) => [x.category, x.total]),
  );
  block(
    "فلوس اديتها لأشخاص",
    summary.people.filter((p) => p.given > 0).map((p) => [p.person, p.given]),
  );

  // --- Movements
  const t = wb.addWorksheet("الحركات", {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
  });
  t.columns = [
    { header: "التاريخ", key: "date", width: 12 },
    { header: "النوع", key: "type", width: 9 },
    {
      header: "المبلغ",
      key: "amount",
      width: 13,
      style: { numFmt: "#,##0.00" },
    },
    { header: "العملة", key: "currency", width: 8 },
    { header: "البيان", key: "description", width: 40 },
    { header: "التصنيف", key: "category", width: 24 },
    { header: "الشخص", key: "person", width: 14 },
    { header: "المشروع/المصدر", key: "source", width: 20 },
  ];
  const header = t.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } };

  const rows = txs
    .filter((x) => x.month === month)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const x of rows) {
    const r = t.addRow({ ...x, type: TYPE_LABEL[x.type] });
    r.getCell("amount").font = {
      color: { argb: x.type === "in" ? GREEN : RED },
    };
    r.getCell("description").alignment = { wrapText: true, vertical: "top" };
  }
  if (rows.length) t.autoFilter = { from: "A1", to: `H${rows.length + 1}` };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
