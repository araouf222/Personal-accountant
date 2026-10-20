import { z } from "zod";

/** Household categories. Edit freely — the AI picks from these lists. */
export const OUT_CATEGORIES = [
  "أكل وبقالة",
  "مطاعم وتيك أواي",
  "فواتير (كهربا/مية/غاز/نت/موبايل)",
  "إيجار وسكن",
  "عربية ومواصلات",
  "بنزين",
  "تعليم ومدارس",
  "صحة وعلاج",
  "لبس",
  "مستلزمات البيت",
  "تشطيب وصيانة",
  "خروج وترفيه",
  "هدايا ومناسبات",
  "فلوس لشخص",
  "أخرى",
] as const;

export const IN_CATEGORIES = [
  "مرتب",
  "أتعاب مشروع",
  "مستخلص",
  "دفعة عميل",
  "إيجار وارد",
  "فلوس من شخص",
  "أخرى",
] as const;

export const TYPE_LABEL = { in: "وارد", out: "منصرف" } as const;
export type TxType = keyof typeof TYPE_LABEL;

const nullableString = z
  .string()
  .nullish()
  .transform((v) => (v?.trim() ? v.trim() : null));

/** One money movement as the AI reads it. */
export const ParsedTransactionSchema = z.object({
  type: z.enum(["in", "out", "unknown"]).catch("unknown"),
  amount: z.coerce.number().positive(),
  currency: nullableString,
  description: z.string().trim().min(1).catch("بدون بيان"),
  category: nullableString,
  person: nullableString,
  source: nullableString,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .catch(null),
  receipt_id: nullableString,
});

export const AiResultSchema = z.object({
  intent: z
    .enum(["transaction", "cashflow_query", "person_query", "other"])
    .catch("other"),
  // Each movement is validated on its own (see ai.ts) so one bad item doesn't drop the rest.
  transactions: z.array(z.unknown()).catch([]).default([]),
  query_month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullish()
    .catch(null),
  query_person: nullableString,
  reply: nullableString,
});

export type ParsedTransaction = z.infer<typeof ParsedTransactionSchema>;
export type AiResult = Omit<z.infer<typeof AiResultSchema>, "transactions"> & {
  transactions: ParsedTransaction[];
};

/** A row as stored in the user's sheet. */
export interface Transaction {
  id: string;
  date: string; // YYYY-MM-DD
  type: TxType;
  amount: number;
  currency: string;
  description: string;
  category: string;
  person: string;
  source: string;
  month: string; // YYYY-MM (helper column for the summary formulas)
  createdAt: string;
}
