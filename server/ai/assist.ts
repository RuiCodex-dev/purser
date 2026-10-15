import { computeLedger } from "../domain/ledger.ts";
import { format } from "../domain/money.ts";
import type { PurserEvent } from "../domain/types.ts";
import type { Gemini } from "./gemini.ts";

// ---- Receipts ------------------------------------------------------------------

export interface ReceiptRead {
  merchant: string;
  date?: string;
  currency: string;
  total: number;
  lines: { label: string; amount: number }[];
}

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    date: { type: "string", description: "As printed" },
    currency: { type: "string", description: "ISO 4217 code" },
    total: { type: "number", description: "The amount actually paid, including tax" },
    lines: { type: "array", items: { type: "object", properties: { label: { type: "string" }, amount: { type: "number" } }, required: ["label", "amount"] } },
    legible: { type: "boolean", description: "false if this is not a readable receipt" },
  },
  required: ["merchant", "currency", "total", "lines", "legible"],
};

export async function readReceipt(llm: Gemini, mimeType: string, base64: string): Promise<{ ok: true; receipt: ReceiptRead; model: string } | { ok: false; error: string }> {
  if (!llm.available) return { ok: false, error: "Receipt reading needs a model key (GEMINI_API_KEY). Enter the cost by hand instead." };
  if (!/^image\/(png|jpe?g|webp|heic)$/.test(mimeType)) return { ok: false, error: "Upload a PNG, JPEG or WebP photo of the receipt." };
  const r = await llm.json<ReceiptRead & { legible: boolean }>({
    system: "You read shop receipts. Report only what is printed. If the image is not a receipt or the total is unreadable, set legible to false.",
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: base64 } }, { text: "Read this receipt." }] }],
    schema: RECEIPT_SCHEMA,
    temperature: 0,
  });
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.value.legible || !(r.value.total > 0)) return { ok: false, error: "That image does not look like a readable receipt." };
  const { legible, ...receipt } = r.value;
  return { ok: true, receipt, model: r.model };
}

// ---- Ask the ledger -----------------------------------------------------------------

export const GRID_COLUMNS = ["name", "role", "status", "state", "share", "fronted", "paid", "position"] as const;
type Col = (typeof GRID_COLUMNS)[number];
const NUMERIC = new Set<Col>(["share", "fronted", "paid", "position"]);

export interface GridQuery {
  explanation: string;
  filterModel: Record<string, unknown>;
  sortModel: { colId: string; sort: "asc" | "desc" }[];
  by: "model" | "rules";
}

interface RawQuery {
  explanation: string;
  filters: { column: Col; op: "contains" | "equals" | "greaterThan" | "lessThan"; value: string }[];
  sortColumn?: Col | "none";
  sortDirection?: "asc" | "desc";
}

function toGrid(q: RawQuery, by: GridQuery["by"]): GridQuery {
  const filterModel: Record<string, unknown> = {};
  for (const f of q.filters ?? []) {
    if (!GRID_COLUMNS.includes(f.column)) continue;
    if (NUMERIC.has(f.column)) {
      const n = Number(String(f.value).replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(n)) continue;
      filterModel[f.column] = { filterType: "number", type: f.op === "contains" ? "equals" : f.op, filter: n };
    } else {
      filterModel[f.column] = { filterType: "text", type: f.op === "equals" ? "equals" : "contains", filter: String(f.value).toLowerCase() };
    }
  }
  const sortModel = q.sortColumn && q.sortColumn !== "none" && GRID_COLUMNS.includes(q.sortColumn) ? [{ colId: q.sortColumn, sort: q.sortDirection ?? "desc" }] : [];
  return { explanation: q.explanation, filterModel, sortModel, by };
}

/** Keyword rules: the offline answer, and the floor the model must beat. */
export function askRules(question: string): GridQuery {
  const q = question.toLowerCase();
  const filters: RawQuery["filters"] = [];
  const said: string[] = [];
  const amount = q.match(/(?:over|more than|above|at least|>\s*)\s*\$?\s*(\d+(?:\.\d+)?)/)?.[1];
  const under = q.match(/(?:under|less than|below|<\s*)\s*\$?\s*(\d+(?:\.\d+)?)/)?.[1];
  if (/refund/.test(q)) (filters.push({ column: "state", op: "contains", value: "refund" }), said.push("owed a refund"));
  else if (/reimburs|we owe|owed money|out of pocket|fronted/.test(q)) (filters.push({ column: "position", op: "lessThan", value: "0" }), said.push("the pot owes them money"));
  else if (/owe|unpaid|not paid|haven'?t paid|hasn'?t paid|outstanding|still need|chase|late/.test(q)) (filters.push({ column: "position", op: "greaterThan", value: amount ?? "0" }), said.push(amount ? `owe more than $${amount}` : "still owe money"));
  else if (/settled|paid up|done/.test(q)) (filters.push({ column: "state", op: "contains", value: "settled" }), said.push("are settled"));
  if (/dropped|cancel|out of the trip|left/.test(q)) (filters.push({ column: "status", op: "equals", value: "dropped" }), said.push("dropped out"));
  if (/co-?host/.test(q)) (filters.push({ column: "role", op: "equals", value: "cohost" }), said.push("are co-hosts"));
  if (amount && !filters.some((f) => f.column === "position")) (filters.push({ column: "share", op: "greaterThan", value: amount }), said.push(`share above $${amount}`));
  if (under) (filters.push({ column: "share", op: "lessThan", value: under }), said.push(`share below $${under}`));
  const sortDesc = /largest|biggest|most|highest|top/.test(q);
  const sortAsc = /smallest|least|lowest/.test(q);
  return toGrid(
    {
      explanation: said.length ? `People who ${said.join(" and ")}.` : "I could not map that to a filter; showing everyone.",
      filters,
      sortColumn: sortDesc || sortAsc ? "position" : "none",
      sortDirection: sortAsc ? "asc" : "desc",
    },
    "rules",
  );
}

export async function askLedger(llm: Gemini, ev: PurserEvent, question: string): Promise<GridQuery> {
  if (!llm.available) return askRules(question);
  const r = await llm.json<RawQuery>({
    system:
      "You translate a question about an event's money into filters for a grid. Columns: name (text), role (organizer|cohost|guest), status (active|dropped), " +
      "state (settled|owes|awaiting payer|owed refund|owed reimbursement|nothing due), and numbers in dollars: share, fronted, paid, " +
      "position (>0 means the person still owes the pot, <0 means the pot owes them). Use as few filters as answer the question. explanation: one short sentence.",
    contents: [{ role: "user", parts: [{ text: question }] }],
    schema: {
      type: "object",
      properties: {
        explanation: { type: "string" },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: { type: "string", enum: [...GRID_COLUMNS] },
              op: { type: "string", enum: ["contains", "equals", "greaterThan", "lessThan"] },
              value: { type: "string" },
            },
            required: ["column", "op", "value"],
          },
        },
        sortColumn: { type: "string", enum: [...GRID_COLUMNS, "none"] },
        sortDirection: { type: "string", enum: ["asc", "desc"] },
      },
      required: ["explanation", "filters"],
    },
    temperature: 0,
  });
  return r.ok ? toGrid(r.value, "model") : askRules(question);
}

// ---- Nudges ------------------------------------------------------------------------

export interface Nudge {
  participantId: string;
  name: string;
  amount: string;
  url: string;
  message: string;
  by: "model" | "template";
}

export async function draftNudges(llm: Gemini, ev: PurserEvent, payUrl: (pid: string) => string): Promise<Nudge[]> {
  const l = computeLedger(ev);
  const due = l.rows.filter((r) => r.positionCents > 0 && r.status === "active");
  const base = due.map((r) => ({
    participantId: r.participantId,
    name: r.name,
    amount: format(r.positionCents, ev.currency),
    url: payUrl(r.participantId),
    lines: r.lines.map((x) => x.label),
  }));
  const template = (b: (typeof base)[number]) =>
    `Hi ${b.name}, your share for ${ev.name} is ${b.amount}${ev.collectBy ? `, due ${ev.collectBy}` : ""}. You can pay it here: ${b.url}`;
  if (!llm.available || !base.length) return base.map((b) => ({ ...b, message: template(b), by: "template" as const }));
  const r = await llm.json<{ messages: { participantId: string; message: string }[] }>({
    system:
      "Write one short, friendly payment reminder per person for a group chat (max 2 sentences). Mention the amount and what it covers in plain words, " +
      "include the link exactly as given, no emoji, no guilt-tripping.",
    contents: [{ role: "user", parts: [{ text: JSON.stringify({ event: ev.name, collectBy: ev.collectBy, people: base }) }] }],
    schema: {
      type: "object",
      properties: { messages: { type: "array", items: { type: "object", properties: { participantId: { type: "string" }, message: { type: "string" } }, required: ["participantId", "message"] } } },
      required: ["messages"],
    },
    temperature: 0.6,
  });
  return base.map((b) => {
    const m = r.ok ? r.value.messages.find((x) => x.participantId === b.participantId)?.message : undefined;
    // A drafted message that lost the link or the amount is not sent as-is.
    const good = m && m.includes(b.url) && m.includes(b.amount.replace(/\.00$/, ""));
    return { ...b, message: good ? m! : template(b), by: good ? ("model" as const) : ("template" as const) };
  });
}
