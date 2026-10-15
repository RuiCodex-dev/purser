import { randomBytes } from "node:crypto";
import { toCents } from "./money.ts";
import type { CostItem, ItemKind, Mandate, PurserEvent, Role } from "./types.ts";

export interface DraftParticipant {
  name: string;
  email?: string;
  role?: Role;
}
export interface DraftItem {
  label: string;
  kind: ItemKind;
  amount: number;
  paidBy?: string;
  vendorName?: string;
  vendorEmail?: string;
  refundable?: boolean;
  optedIn?: string[];
}
export interface DraftSponsor {
  name: string;
  email?: string;
  amount: number;
  note?: string;
}
export interface EventDraft {
  name: string;
  dateLabel: string;
  location: string;
  currency: string;
  collectBy?: string;
  participants: DraftParticipant[];
  items: DraftItem[];
  sponsors: DraftSponsor[];
}

export const DEFAULT_MANDATE: Mandate = {
  maxPayoutCents: 25_000,
  maxRefundCents: 15_000,
  floatCents: 0,
  autoPayVendors: false,
  extraPayees: [],
};

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");

export function placeholderEmail(name: string, domain = "example.com") {
  return `${slug(name) || "guest"}@${domain}`;
}

/** Validates a draft (from a model or the parser) and returns problems found. */
export function checkDraft(d: EventDraft): string[] {
  const issues: string[] = [];
  if (!d.participants?.length) issues.push("No participants found");
  if (!d.items?.length) issues.push("No costs found");
  const names = new Set((d.participants ?? []).map((p) => p.name.toLowerCase()));
  if (names.size !== (d.participants ?? []).length) issues.push("Two participants share a name");
  for (const i of d.items ?? []) {
    if (!(i.amount > 0)) issues.push(`"${i.label}" has no amount`);
    if (i.paidBy && !names.has(i.paidBy.toLowerCase())) issues.push(`"${i.label}" was paid by ${i.paidBy}, who is not on the list`);
    for (const o of i.optedIn ?? []) if (!names.has(o.toLowerCase())) issues.push(`${o} opted into "${i.label}" but is not on the list`);
  }
  if (!/^[A-Z]{3}$/.test(d.currency ?? "")) issues.push("Currency is not an ISO code");
  return issues;
}

export function buildEvent(d: EventDraft, brief: string): PurserEvent {
  const id = randomBytes(4).toString("hex");
  const participants = d.participants.map((p, n) => ({
    id: `p${n + 1}`,
    name: p.name.trim(),
    email: (p.email?.trim() || placeholderEmail(p.name)).toLowerCase(),
    role: (p.role ?? "guest") as Role,
    status: "active" as const,
  }));
  if (!participants.some((p) => p.role === "organizer") && participants[0]) participants[0].role = "organizer";
  const byName = (n?: string) => participants.find((p) => p.name.toLowerCase() === n?.trim().toLowerCase());
  const items: CostItem[] = d.items.map((i, n) => ({
    id: `i${n + 1}`,
    label: i.label.trim(),
    kind: i.kind,
    amountCents: toCents(i.amount),
    paidById: byName(i.paidBy)?.id,
    vendor: !i.paidBy && i.vendorName ? { name: i.vendorName, email: (i.vendorEmail || placeholderEmail(i.vendorName)).toLowerCase() } : undefined,
    refundable: i.refundable ?? true,
    optedIn: i.optedIn?.length ? i.optedIn.map((o) => byName(o)?.id).filter((x): x is string => Boolean(x)) : undefined,
    source: "brief",
  }));
  const ev: PurserEvent = {
    id,
    name: d.name.trim() || "Untitled event",
    dateLabel: d.dateLabel?.trim() ?? "",
    location: d.location?.trim() ?? "",
    currency: d.currency,
    collectBy: d.collectBy,
    brief,
    createdAt: new Date().toISOString(),
    participants,
    items,
    sponsors: d.sponsors.map((s, n) => ({
      id: `s${n + 1}`,
      name: s.name.trim(),
      email: (s.email || placeholderEmail(s.name)).toLowerCase(),
      amountCents: toCents(s.amount),
      note: s.note,
    })),
    mandate: { ...DEFAULT_MANDATE },
    payTokens: {},
    orders: [],
    refunds: [],
    payouts: [],
    invoices: [],
    approvals: [],
    audit: [],
  };
  for (const p of participants) ev.payTokens[p.id] = randomBytes(12).toString("base64url");
  return ev;
}
