import { GoogleGenAI, type Part } from "@google/genai";
import { config } from "../config.js";
import {
  type AiResult,
  AiResultSchema,
  IN_CATEGORIES,
  OUT_CATEGORIES,
  ParsedTransactionSchema,
} from "../schemas/transaction.js";
import { isoDate } from "./dates.js";

let client: GoogleGenAI | null = null;
function ai() {
  client ??= new GoogleGenAI({ apiKey: config.geminiKey });
  return client;
}

export function buildPrompt(opts: {
  today: string;
  knownPeople: string[];
  currency: string;
}) {
  const people = opts.knownPeople.length
    ? opts.knownPeople.map((p) => `"${p}"`).join(", ")
    : "(none yet)";
  return `You are the engine of a personal cash-flow Telegram bot. Users write mostly in Egyptian Arabic, sometimes English.
They tell you money that came IN (income) or went OUT (spending), send receipt photos / PDF invoices, or ask questions.
Today's date is ${opts.today} (Africa/Cairo).

Return ONLY one JSON object:
{
  "intent": "transaction" | "cashflow_query" | "person_query" | "other",
  "transactions": [ {
      "type": "in" | "out" | "unknown",
      "amount": number,               // positive, total for this movement
      "currency": string | null,      // ISO code; null if not stated
      "description": string,          // short Arabic summary, keep the user's wording
      "category": string | null,      // from the lists below
      "person": string | null,        // the person who RECEIVED money (out) or GAVE money (in), if named
      "source": string | null,        // project / client / place the money relates to, if named
      "date": "YYYY-MM-DD" | null,    // only if stated or printed; resolve relative days (امبارح = yesterday)
      "receipt_id": string | null     // invoice/receipt number printed on the document, if any
  } ],
  "query_month": "YYYY-MM" | null,    // for questions about a month ("الشهر اللي فات")
  "query_person": string | null,      // for questions about one person ("مروة خدت كام؟")
  "reply": string | null              // for intent "other": one short friendly Egyptian Arabic sentence
}

RULES
- IN words: جالي، وصلني، قبضت، استلمت، اتحولي، دخلي، مرتب، مستخلص، دفعة من. OUT words: دفعت، صرفت، اشتريت، حولت لـ، اديت، ادفع، فاتورة.
- A receipt, bill or invoice the user paid is OUT. "دفعت ليحيى 100" is OUT with person "يحيى".
- If you truly cannot tell in vs out, use "unknown" — never guess.
- One message can hold several movements ("دفعت ليحيى 100 ومروة 2000") → one transaction each.
- For a receipt/invoice photo or PDF: ONE transaction with the grand total actually paid (after discounts, including tax).
- Amounts: "1.5 الف"/"1500"/"١٥٠٠" → 1500. "ك" or "k" = thousand. Default currency when not stated: ${opts.currency}.
- Known people already in this user's ledger: ${people}. If a name is the same person with different spelling (مروه/مروة), return the known spelling exactly.
- OUT categories: ${OUT_CATEGORIES.join(" | ")}
- IN categories: ${IN_CATEGORIES.join(" | ")}
  Money given to a person with no clearer purpose → "فلوس لشخص". If the user names a category, use it.
- Questions like "صرفت كام الشهر ده" / "الرصيد كام" → intent "cashflow_query". "مروة خدت كام" → "person_query".
- Greetings or anything unrelated → intent "other" with a short reply explaining they can send income, spending or a receipt photo.`;
}

export async function interpret(
  input:
    | { text: string }
    | { data: Buffer; mimeType: string; caption?: string },
  knownPeople: string[] = [],
): Promise<AiResult> {
  const prompt = buildPrompt({
    today: isoDate(),
    knownPeople,
    currency: config.defaultCurrency,
  });

  const parts: Part[] = [{ text: prompt }];
  if ("text" in input) {
    parts.push({ text: `User message:\n${input.text}` });
  } else {
    parts.push({
      inlineData: {
        data: input.data.toString("base64"),
        mimeType: input.mimeType,
      },
    });
    parts.push({
      text: input.caption
        ? `This is a receipt/invoice. User note: ${input.caption}`
        : "This is a receipt/invoice the user paid.",
    });
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai().models.generateContent({
        model: config.geminiModel,
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", temperature: 0 },
      });
      return parseAiJson(response.text ?? "");
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient = /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(
        message,
      );
      if (!transient || attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  throw lastError;
}

/** Pulls the JSON object out of the model's answer and validates it. */
export function parseAiJson(text: string): AiResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI returned no JSON");
  const raw = AiResultSchema.parse(JSON.parse(match[0]));
  const transactions = raw.transactions.flatMap((t) => {
    const parsed = ParsedTransactionSchema.safeParse(t);
    return parsed.success ? [parsed.data] : [];
  });
  return { ...raw, transactions };
}
