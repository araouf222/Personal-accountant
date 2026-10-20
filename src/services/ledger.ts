import type { OAuth2Client } from "google-auth-library";
import {
  GoogleSpreadsheet,
  type GoogleSpreadsheetWorksheet,
} from "google-spreadsheet";
import { config } from "../config.js";
import {
  type Transaction,
  type TxType,
  TYPE_LABEL,
} from "../schemas/transaction.js";

export const TX_SHEET = "الحركات";
export const MONTHLY_SHEET = "ملخص شهري";
export const PEOPLE_SHEET = "الأشخاص";

/** Column order in the transactions tab (A → K). Formulas below depend on it. */
export const H = {
  id: "المعرف",
  date: "التاريخ",
  type: "النوع",
  amount: "المبلغ",
  currency: "العملة",
  description: "البيان",
  category: "التصنيف",
  person: "الشخص",
  source: "المشروع/المصدر",
  month: "الشهر",
  createdAt: "وقت التسجيل",
} as const;
export const HEADERS = Object.values(H);

const T = `'${TX_SHEET}'`;

export function monthlyFormulas(currency: string) {
  const sum = (type: string) =>
    `=ARRAYFORMULA(IF(A2:A="","",SUMIFS(${T}!D2:D,${T}!J2:J,A2:A,${T}!C2:C,"${type}",${T}!E2:E,"${currency}")))`;
  return {
    header: [
      "الشهر",
      `الوارد (${currency})`,
      `المنصرف (${currency})`,
      "الصافي",
    ],
    row2: [
      `=IFERROR(SORT(UNIQUE(FILTER(${T}!J2:J,${T}!J2:J<>"")),1,FALSE),"")`,
      sum(TYPE_LABEL.in),
      sum(TYPE_LABEL.out),
      `=ARRAYFORMULA(IF(A2:A="","",B2:B-C2:C))`,
    ],
  };
}

export function peopleFormulas(currency: string) {
  const sum = (type: string) =>
    `=ARRAYFORMULA(IF(A2:A="","",SUMIFS(${T}!D2:D,${T}!H2:H,A2:A,${T}!C2:C,"${type}",${T}!E2:E,"${currency}")))`;
  return {
    header: ["الشخص", `اديته (${currency})`, `جالي منه (${currency})`],
    row2: [
      `=IFERROR(SORT(UNIQUE(FILTER(${T}!H2:H,${T}!H2:H<>""))),"")`,
      sum(TYPE_LABEL.out),
      sum(TYPE_LABEL.in),
    ],
  };
}

function open(client: OAuth2Client, spreadsheetId: string) {
  return new GoogleSpreadsheet(spreadsheetId, client);
}

async function writeFormulaSheet(
  sheet: GoogleSpreadsheetWorksheet,
  spec: { header: string[]; row2: string[] },
) {
  await sheet.loadCells("A1:D2");
  spec.header.forEach((v, i) => {
    sheet.getCell(0, i).value = v;
  });
  spec.row2.forEach((f, i) => {
    sheet.getCell(1, i).formula = f;
  });
  await sheet.saveUpdatedCells();
}

/** Creates the user's cash-flow spreadsheet in THEIR Google Drive and returns its id. */
export async function createLedger(
  client: OAuth2Client,
  ownerName: string,
): Promise<string> {
  const currency = config.defaultCurrency;
  const doc = await GoogleSpreadsheet.createNewSpreadsheetDocument(client, {
    title: `كاش فلو${ownerName ? ` – ${ownerName}` : ""}`,
    timeZone: config.timezone,
  });

  const tx = doc.sheetsByIndex[0];
  await tx.updateProperties({
    title: TX_SHEET,
    rightToLeft: true,
    gridProperties: {
      rowCount: 1000,
      columnCount: HEADERS.length,
      frozenRowCount: 1,
    },
  });
  await tx.setHeaderRow(HEADERS);

  const monthly = await doc.addSheet({
    title: MONTHLY_SHEET,
    rightToLeft: true,
    gridProperties: { rowCount: 200, columnCount: 4, frozenRowCount: 1 },
  });
  await writeFormulaSheet(monthly, monthlyFormulas(currency));

  const people = await doc.addSheet({
    title: PEOPLE_SHEET,
    rightToLeft: true,
    gridProperties: { rowCount: 500, columnCount: 3, frozenRowCount: 1 },
  });
  await writeFormulaSheet(people, peopleFormulas(currency));

  return doc.spreadsheetId;
}

/** Checks the bot can still open a sheet (e.g. after reconnecting). */
export async function canOpen(
  client: OAuth2Client,
  spreadsheetId: string,
): Promise<boolean> {
  try {
    const doc = open(client, spreadsheetId);
    await doc.loadInfo();
    return Boolean(doc.sheetsByTitle[TX_SHEET]);
  } catch {
    return false;
  }
}

async function txSheet(client: OAuth2Client, spreadsheetId: string) {
  const doc = open(client, spreadsheetId);
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[TX_SHEET] ?? doc.sheetsByIndex[0];
  await sheet.loadHeaderRow();
  return sheet;
}

export function toRow(t: Transaction): Record<string, string | number> {
  return {
    [H.id]: t.id,
    [H.date]: t.date,
    [H.type]: TYPE_LABEL[t.type],
    [H.amount]: t.amount,
    [H.currency]: t.currency,
    [H.description]: t.description,
    [H.category]: t.category,
    [H.person]: t.person,
    [H.source]: t.source,
    [H.month]: t.month,
    [H.createdAt]: t.createdAt,
  };
}

export function fromRow(obj: Record<string, unknown>): Transaction | null {
  const label = String(obj[H.type] ?? "").trim();
  const type: TxType | null =
    label === TYPE_LABEL.in ? "in" : label === TYPE_LABEL.out ? "out" : null;
  const amount = Number(String(obj[H.amount] ?? "").replace(/,/g, ""));
  const date = String(obj[H.date] ?? "").trim();
  if (!type || !Number.isFinite(amount) || !/^\d{4}-\d{2}-\d{2}/.test(date))
    return null;
  return {
    id: String(obj[H.id] ?? ""),
    date: date.slice(0, 10),
    type,
    amount,
    currency: String(obj[H.currency] || config.defaultCurrency),
    description: String(obj[H.description] ?? ""),
    category: String(obj[H.category] ?? ""),
    person: String(obj[H.person] ?? "").trim(),
    source: String(obj[H.source] ?? "").trim(),
    month: String(obj[H.month] || date.slice(0, 7)),
    createdAt: String(obj[H.createdAt] ?? ""),
  };
}

/** Appends rows. Raw mode keeps dates and month labels as plain text the formulas can match. */
export async function appendTransactions(
  client: OAuth2Client,
  spreadsheetId: string,
  txs: Transaction[],
): Promise<void> {
  const sheet = await txSheet(client, spreadsheetId);
  await sheet.addRows(txs.map(toRow), { raw: true, insert: true });
}

export async function readTransactions(
  client: OAuth2Client,
  spreadsheetId: string,
): Promise<Transaction[]> {
  const sheet = await txSheet(client, spreadsheetId);
  const rows = await sheet.getRows();
  return rows.flatMap((r) => {
    const t = fromRow(r.toObject());
    return t ? [t] : [];
  });
}

/** Deletes rows by ID. Returns how many were removed. */
export async function deleteByIds(
  client: OAuth2Client,
  spreadsheetId: string,
  ids: string[],
): Promise<number> {
  if (!ids.length) return 0;
  const sheet = await txSheet(client, spreadsheetId);
  const rows = await sheet.getRows();
  const targets = rows
    .filter((r) => ids.includes(String(r.get(H.id))))
    .sort((a, b) => b.rowNumber - a.rowNumber); // bottom-up so row numbers stay valid
  for (const row of targets) await row.delete();
  return targets.length;
}

export function sheetUrl(spreadsheetId: string) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}
