import { splitEvenly, sum, type Cents } from "./money.ts";
import type { CostItem, OrderRec, Participant, PurserEvent } from "./types.ts";

export interface ShareLine {
  itemId: string;
  label: string;
  amountCents: Cents;
}

export type RowState =
  | "settled"
  | "owes"
  | "awaiting payer"
  | "owed refund"
  | "owed reimbursement"
  | "nothing due";

export interface LedgerRow {
  participantId: string;
  name: string;
  email: string;
  role: Participant["role"];
  status: Participant["status"];
  lines: ShareLine[];
  shareCents: Cents;
  frontedCents: Cents;
  sponsorCreditCents: Cents;
  netCents: Cents;
  capturedCents: Cents;
  refundedCents: Cents;
  payoutCents: Cents;
  /** > 0: the person owes the pot. < 0: the pot owes the person. */
  positionCents: Cents;
  openOrder?: OrderRec;
  state: RowState;
}

export interface VendorDue {
  itemId: string;
  label: string;
  vendor: { name: string; email: string };
  amountCents: Cents;
  paidCents: Cents;
  dueCents: Cents;
}

export interface Ledger {
  currency: string;
  rows: LedgerRow[];
  vendors: VendorDue[];
  totals: {
    costCents: Cents;
    sponsorCents: Cents;
    sponsorPaidCents: Cents;
    collectedCents: Cents;
    refundedCents: Cents;
    paidOutCents: Cents;
    potCents: Cents;
    outstandingCents: Cents;
    owedOutCents: Cents;
  };
}

const OPEN_ORDER = new Set(["CREATED", "PAYER_ACTION_REQUIRED", "APPROVED"]);
const FAILED_PAYOUT = new Set(["FAILED", "RETURNED", "BLOCKED", "REVERSED", "DENIED", "CANCELED"]);

/** Who carries a share of this item right now. Order follows the participant list. */
export function carriers(item: CostItem, participants: Participant[]): Participant[] {
  const pool = item.optedIn ? participants.filter((p) => item.optedIn!.includes(p.id)) : participants;
  // A person who dropped out still carries non-refundable costs.
  return pool.filter((p) => p.status === "active" || !item.refundable);
}

export function itemShares(item: CostItem, participants: Participant[]): Map<string, Cents> {
  const who = carriers(item, participants).map((p) => p.id);
  if (item.kind === "per_head") return new Map(who.map((id) => [id, item.amountCents]));
  return splitEvenly(item.amountCents, who);
}

export function itemTotal(item: CostItem, participants: Participant[]): Cents {
  if (item.kind === "per_head") return item.amountCents * carriers(item, participants).length;
  return item.amountCents;
}

export function isOpenOrder(o: OrderRec): boolean {
  return OPEN_ORDER.has(o.status);
}

export function payoutCounts(status: string): boolean {
  return !FAILED_PAYOUT.has(status.toUpperCase());
}

export function computeLedger(ev: PurserEvent): Ledger {
  const lines = new Map<string, ShareLine[]>();
  for (const p of ev.participants) lines.set(p.id, []);
  for (const item of ev.items) {
    for (const [pid, cents] of itemShares(item, ev.participants)) {
      if (cents !== 0) lines.get(pid)?.push({ itemId: item.id, label: item.label, amountCents: cents });
    }
  }

  const active = ev.participants.filter((p) => p.status === "active").map((p) => p.id);
  const sponsorCents = sum(ev.sponsors.map((s) => s.amountCents));
  const credit = splitEvenly(sponsorCents, active);

  const rows: LedgerRow[] = ev.participants.map((p) => {
    const myLines = lines.get(p.id) ?? [];
    const shareCents = sum(myLines.map((l) => l.amountCents));
    const frontedCents = sum(ev.items.filter((i) => i.paidById === p.id).map((i) => itemTotal(i, ev.participants)));
    const sponsorCreditCents = credit.get(p.id) ?? 0;
    const netCents = shareCents - frontedCents - sponsorCreditCents;
    const myOrders = ev.orders.filter((o) => o.participantId === p.id);
    const capturedCents = sum(myOrders.map((o) => o.capturedCents));
    const refundedCents = sum(myOrders.map((o) => o.refundedCents));
    const payoutCents = sum(
      ev.payouts
        .filter((x) => x.payee.type === "participant" && x.payee.participantId === p.id && payoutCounts(x.status))
        .map((x) => x.amountCents),
    );
    const positionCents = netCents - (capturedCents - refundedCents) + payoutCents;
    const openOrder = myOrders.find(isOpenOrder);
    let state: RowState;
    if (positionCents > 0) state = openOrder && openOrder.amountCents === positionCents ? "awaiting payer" : "owes";
    else if (positionCents < 0) state = capturedCents - refundedCents > 0 ? "owed refund" : "owed reimbursement";
    else state = capturedCents > 0 || frontedCents > 0 ? "settled" : "nothing due";
    return {
      participantId: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      status: p.status,
      lines: myLines,
      shareCents,
      frontedCents,
      sponsorCreditCents,
      netCents,
      capturedCents,
      refundedCents,
      payoutCents,
      positionCents,
      openOrder,
      state,
    };
  });

  const vendors: VendorDue[] = ev.items
    .filter((i) => i.vendor && !i.paidById)
    .map((i) => {
      const amountCents = itemTotal(i, ev.participants);
      const paidCents = sum(
        ev.payouts
          .filter((x) => x.payee.type === "vendor" && x.payee.itemId === i.id && payoutCounts(x.status))
          .map((x) => x.amountCents),
      );
      return { itemId: i.id, label: i.label, vendor: i.vendor!, amountCents, paidCents, dueCents: amountCents - paidCents };
    });

  const collectedCents = sum(rows.map((r) => r.capturedCents));
  const refundedCents = sum(rows.map((r) => r.refundedCents));
  const paidOutCents = sum(ev.payouts.filter((x) => payoutCounts(x.status)).map((x) => x.amountCents));
  const sponsorPaidCents = sum(ev.invoices.filter((i) => i.status === "PAID").map((i) => i.amountCents));

  return {
    currency: ev.currency,
    rows,
    vendors,
    totals: {
      costCents: sum(ev.items.map((i) => itemTotal(i, ev.participants))),
      sponsorCents,
      sponsorPaidCents,
      collectedCents,
      refundedCents,
      paidOutCents,
      potCents: collectedCents - refundedCents + sponsorPaidCents - paidOutCents,
      outstandingCents: sum(rows.filter((r) => r.positionCents > 0).map((r) => r.positionCents)),
      owedOutCents:
        sum(rows.filter((r) => r.positionCents < 0).map((r) => -r.positionCents)) +
        sum(vendors.map((v) => Math.max(0, v.dueCents))),
    },
  };
}
