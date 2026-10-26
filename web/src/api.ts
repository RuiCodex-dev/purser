// Thin client for the Purser API. Types mirror server/domain where the UI needs them.

export type Verdict = "allow" | "approval" | "deny";

export interface Participant {
  id: string;
  name: string;
  email: string;
  role: "organizer" | "cohost" | "guest";
  status: "active" | "dropped";
}
export interface CostItem {
  id: string;
  label: string;
  kind: "shared" | "per_head";
  amountCents: number;
  paidById?: string;
  vendor?: { name: string; email: string };
  refundable: boolean;
  optedIn?: string[];
  source: "brief" | "receipt" | "manual";
}
export interface OrderRec {
  id: string;
  participantId: string;
  amountCents: number;
  status: string;
  approveUrl?: string;
  captureId?: string;
  capturedCents: number;
  refundedCents: number;
  via: string;
}
export interface Approval {
  id: string;
  createdAt: string;
  tool: string;
  subject: string;
  amountCents: number;
  reasons: string[];
  status: string;
  result?: string;
}
export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  amountCents?: number;
  verdict?: Verdict;
  paypalId?: string;
  debugId?: string;
}
export interface PurserEvent {
  id: string;
  name: string;
  dateLabel: string;
  location: string;
  currency: string;
  collectBy?: string;
  brief: string;
  participants: Participant[];
  items: CostItem[];
  sponsors: { id: string; name: string; email: string; amountCents: number }[];
  mandate: { maxPayoutCents: number; maxRefundCents: number; floatCents: number; autoPayVendors: boolean; extraPayees: string[] };
  orders: OrderRec[];
  refunds: { id: string; participantId: string; amountCents: number; status: string }[];
  payouts: { batchId: string; itemId?: string; email: string; amountCents: number; status: string; payee: any }[];
  invoices: { id: string; sponsorId: string; amountCents: number; status: string; reminders: number }[];
  approvals: Approval[];
  audit: AuditEntry[];
  note?: string;
}
export interface LedgerRow {
  participantId: string;
  name: string;
  email: string;
  role: Participant["role"];
  status: Participant["status"];
  lines: { itemId: string; label: string; amountCents: number }[];
  shareCents: number;
  frontedCents: number;
  sponsorCreditCents: number;
  netCents: number;
  capturedCents: number;
  refundedCents: number;
  payoutCents: number;
  positionCents: number;
  openOrder?: OrderRec;
  state: string;
}
export interface Ledger {
  currency: string;
  rows: LedgerRow[];
  vendors: { itemId: string; label: string; vendor: { name: string; email: string }; amountCents: number; paidCents: number; dueCents: number }[];
  totals: Record<string, number>;
}
export interface EventView {
  event: PurserEvent;
  ledger: Ledger;
  plan: { kind: string; what: string; amountCents?: number }[];
  waiting: { kind: string; who: string; amountCents: number }[];
  payLinks: Record<string, string>;
}
export interface Health {
  ok: boolean;
  paypal: { mode: "sandbox" | "fixtures"; label: string; toolkit: string; serverSdk: string | null; webhookVerification: string };
  ai: { configured: boolean; model: string | null };
  publicBase: string;
}
export interface TraceStep {
  at: string;
  kind: "start" | "thought" | "call" | "result" | "note" | "fallback" | "done";
  text: string;
  tool?: string;
  args?: Record<string, unknown>;
  outcome?: { verdict: Verdict; subject: string; amountCents: number; executed: boolean; ok?: boolean; paypalId?: string; debugId?: string; reasons: string[]; summary: string; approvalId?: string };
}
export interface Draft {
  name: string;
  dateLabel: string;
  location: string;
  currency: string;
  collectBy?: string;
  participants: { name: string; email?: string; role?: string }[];
  items: { label: string; kind: string; amount: number; paidBy?: string; vendorName?: string; vendorEmail?: string; refundable?: boolean; optedIn?: string[] }[];
  sponsors: { name: string; email?: string; amount: number }[];
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((data as any).error ?? `HTTP ${res.status}`));
  return data as T;
}

export const api = {
  health: () => call<Health>("GET", "/api/health"),
  events: () => call<{ id: string; name: string; dateLabel: string; currency: string; people: number; totals: Record<string, number> }[]>("GET", "/api/events"),
  event: (id: string) => call<EventView>("GET", `/api/events/${id}`),
  sample: () => call<{ text: string }>("GET", "/api/sample-brief"),
  parse: (text: string) => call<{ draft: Draft; issues: string[]; by: string; model?: string; note?: string }>("POST", "/api/briefs/parse", { text }),
  create: (draft: Draft, brief: string) => call<EventView>("POST", "/api/events", { draft, brief }),
  demo: () => call<EventView>("POST", "/api/demo"),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/events/${id}`),
  agent: (id: string, instruction: string) => call<{ trace: TraceStep[]; note: string; by: string; model?: string; view: EventView }>("POST", `/api/events/${id}/agent`, { instruction }),
  reconcile: (id: string) => call<{ changes: number; view: EventView }>("POST", `/api/events/${id}/reconcile`),
  decide: (id: string, aid: string, decision: "approve" | "reject") => call<{ outcome: TraceStep["outcome"] | null; view: EventView }>("POST", `/api/events/${id}/approvals/${aid}`, { decision }),
  ask: (id: string, question: string) => call<{ explanation: string; filterModel: Record<string, unknown>; sortModel: { colId: string; sort: "asc" | "desc" }[]; by: string }>("POST", `/api/events/${id}/ask`, { question }),
  nudges: (id: string) => call<{ participantId: string; name: string; amount: string; url: string; message: string; by: string }[]>("GET", `/api/events/${id}/nudges`),
  receipt: (id: string, mimeType: string, data: string) => call<{ ok: boolean; receipt?: { merchant: string; date?: string; currency: string; total: number; lines: { label: string; amount: number }[] }; error?: string; model?: string }>("POST", `/api/events/${id}/receipt`, { mimeType, data }),
  addItem: (id: string, item: Record<string, unknown>) => call<EventView>("POST", `/api/events/${id}/items`, item),
  removeItem: (id: string, itemId: string) => call<EventView>("DELETE", `/api/events/${id}/items/${itemId}`),
  drop: (id: string, pid: string, rejoin = false) => call<EventView>("POST", `/api/events/${id}/participants/${pid}/${rejoin ? "rejoin" : "drop"}`),
  mandate: (id: string, m: Record<string, unknown>) => call<EventView>("PUT", `/api/events/${id}/mandate`, m),
};

export function money(cents: number | undefined, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format((cents ?? 0) / 100);
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
