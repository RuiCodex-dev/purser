import { computeLedger, type Ledger } from "./ledger.ts";
import { sum, type Cents } from "./money.ts";
import type { PurserEvent } from "./types.ts";

// The planner is the ledger engine's opinion of what money still has to move.
// It is deterministic, it never talks to PayPal, and the mandate checks every
// agent action against it. When no language model is configured it is also
// the agent: its intents are executed through the same guarded path.

export interface OrderLine {
  label: string;
  amountCents: Cents;
}

export type Intent =
  | {
      kind: "collect";
      participantId: string;
      amountCents: Cents;
      lines: OrderLine[];
      discountCents: Cents;
      supersedes?: string;
    }
  | { kind: "refund"; participantId: string; orderId: string; captureId: string; amountCents: Cents }
  | { kind: "payout_participant"; participantId: string; email: string; amountCents: Cents }
  | { kind: "payout_vendor"; itemId: string; email: string; vendorName: string; amountCents: Cents }
  | { kind: "invoice"; sponsorId: string; amountCents: Cents }
  | { kind: "send_invoice"; sponsorId: string; invoiceId: string }
  | { kind: "remind_invoice"; sponsorId: string; invoiceId: string };

export interface PlanOptions {
  includeReminders?: boolean;
  /** The mandate wants every payout the ledger owes, covered or not, to give the right reason. */
  ignorePot?: boolean;
}

export interface WaitingPayout {
  kind: "payout_participant" | "payout_vendor";
  who: string;
  amountCents: Cents;
}

export function plan(ev: PurserEvent, opts: PlanOptions = {}, ledger: Ledger = computeLedger(ev)): Intent[] {
  const out: Intent[] = [];

  for (const r of ledger.rows) {
    if (r.positionCents <= 0) continue;
    if (r.openOrder && r.openOrder.amountCents === r.positionCents) continue; // already asked
    const netPaid = r.capturedCents - r.refundedCents;
    let lines: OrderLine[];
    let discountCents = 0;
    const itemSum = sum(r.lines.map((l) => l.amountCents));
    const credits = r.frontedCents + r.sponsorCreditCents;
    if (netPaid === 0 && r.payoutCents === 0 && itemSum - credits === r.positionCents && r.lines.length > 0) {
      lines = r.lines.map((l) => ({ label: l.label, amountCents: l.amountCents }));
      discountCents = credits;
    } else {
      lines = [{ label: "Balance due", amountCents: r.positionCents }];
    }
    out.push({
      kind: "collect",
      participantId: r.participantId,
      amountCents: r.positionCents,
      lines,
      discountCents,
      supersedes: r.openOrder?.id,
    });
  }

  for (const s of ev.sponsors) {
    const inv = ev.invoices.filter((i) => i.sponsorId === s.id && i.status !== "CANCELLED");
    const live = inv[inv.length - 1];
    if (!live) out.push({ kind: "invoice", sponsorId: s.id, amountCents: s.amountCents });
    else if (live.status === "DRAFT") out.push({ kind: "send_invoice", sponsorId: s.id, invoiceId: live.id });
    else if (opts.includeReminders && live.status !== "PAID")
      out.push({ kind: "remind_invoice", sponsorId: s.id, invoiceId: live.id });
  }

  const payouts: Extract<Intent, { kind: "payout_participant" | "payout_vendor" }>[] = [];
  for (const r of ledger.rows) {
    if (r.positionCents >= 0) continue;
    let owed = -r.positionCents;
    // Return money on the rail it arrived on first: refund captured payments.
    const orders = ev.orders
      .filter((o) => o.participantId === r.participantId && o.captureId && o.capturedCents - o.refundedCents > 0)
      .slice()
      .reverse();
    for (const o of orders) {
      if (owed <= 0) break;
      const amount = Math.min(owed, o.capturedCents - o.refundedCents);
      out.push({ kind: "refund", participantId: r.participantId, orderId: o.id, captureId: o.captureId!, amountCents: amount });
      owed -= amount;
    }
    if (owed > 0) payouts.push({ kind: "payout_participant", participantId: r.participantId, email: r.email, amountCents: owed });
  }

  for (const v of ledger.vendors) {
    if (v.dueCents > 0)
      payouts.push({ kind: "payout_vendor", itemId: v.itemId, email: v.vendor.email, vendorName: v.vendor.name, amountCents: v.dueCents });
  }

  // Payouts only for money that has arrived. People who fronted costs come
  // before vendors, smaller amounts first, so more people are made whole sooner.
  let available = ledger.totals.potCents + ev.mandate.floatCents;
  payouts.sort((a, b) => (a.kind === b.kind ? a.amountCents - b.amountCents : a.kind === "payout_participant" ? -1 : 1));
  for (const p of payouts) {
    if (opts.ignorePot || p.amountCents <= available) {
      out.push(p);
      available -= p.amountCents;
    }
  }
  return out;
}

/** Payouts the ledger owes but the pot cannot cover yet. */
export function waitingPayouts(ev: PurserEvent, ledger: Ledger = computeLedger(ev)): WaitingPayout[] {
  const planned = new Set(plan(ev, {}, ledger).filter((i) => i.kind === "payout_participant" || i.kind === "payout_vendor").map((i) => JSON.stringify(i)));
  const all: WaitingPayout[] = [];
  for (const r of ledger.rows) {
    if (r.positionCents >= 0) continue;
    const refundable = ev.orders.filter((o) => o.participantId === r.participantId).reduce((s, o) => s + o.capturedCents - o.refundedCents, 0);
    const owed = -r.positionCents - Math.min(refundable, -r.positionCents);
    if (owed > 0 && !planned.has(JSON.stringify({ kind: "payout_participant", participantId: r.participantId, email: r.email, amountCents: owed })))
      all.push({ kind: "payout_participant", who: r.name, amountCents: owed });
  }
  for (const v of ledger.vendors)
    if (v.dueCents > 0 && !planned.has(JSON.stringify({ kind: "payout_vendor", itemId: v.itemId, email: v.vendor.email, vendorName: v.vendor.name, amountCents: v.dueCents })))
      all.push({ kind: "payout_vendor", who: v.vendor.name, amountCents: v.dueCents });
  return all;
}

export function describeIntent(ev: PurserEvent, i: Intent): string {
  const name = (pid: string) => ev.participants.find((p) => p.id === pid)?.name ?? pid;
  const sponsor = (sid: string) => ev.sponsors.find((s) => s.id === sid)?.name ?? sid;
  switch (i.kind) {
    case "collect":
      return `Ask ${name(i.participantId)} to pay their share`;
    case "refund":
      return `Refund ${name(i.participantId)}`;
    case "payout_participant":
      return `Reimburse ${name(i.participantId)}`;
    case "payout_vendor":
      return `Pay ${i.vendorName}`;
    case "invoice":
      return `Invoice ${sponsor(i.sponsorId)}`;
    case "send_invoice":
      return `Send the invoice to ${sponsor(i.sponsorId)}`;
    case "remind_invoice":
      return `Remind ${sponsor(i.sponsorId)} about their invoice`;
  }
}
