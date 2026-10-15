import { computeLedger, isOpenOrder, type Ledger } from "./ledger.ts";
import { format, type Cents } from "./money.ts";
import { plan, type Intent } from "./planner.ts";
import type { PurserEvent } from "./types.ts";

// The mandate is the contract between the organizer and the agent. Every tool
// call that can move money is normalised into a MoneyAction and checked here,
// before anything reaches PayPal. The rules are plain code on purpose: a model
// can be talked into things, a comparison against the ledger cannot.

export type MoneyAction =
  | { tool: "create_order"; participantId: string; amountCents: Cents; currency: string; itemsCents: Cents; discountCents: Cents }
  | { tool: "pay_order"; orderId: string }
  | { tool: "create_refund"; captureId: string; amountCents: Cents; currency: string }
  | { tool: "create_payout"; email: string; amountCents: Cents; currency: string }
  | { tool: "create_invoice"; email: string; amountCents: Cents; currency: string }
  | { tool: "send_invoice" | "send_invoice_reminder" | "cancel_sent_invoice"; invoiceId: string }
  | { tool: "read"; name: string };

export type Verdict = "allow" | "approval" | "deny";

export interface Decision {
  verdict: Verdict;
  reasons: string[];
  /** What the ledger expected, for the trace and for the model's retry. */
  expected?: string;
  subject: string;
  amountCents: Cents;
}

const REMINDER_COOLDOWN_MS = 10 * 60 * 1000;

export function evaluate(
  ev: PurserEvent,
  action: MoneyAction,
  opts: { approved?: boolean; now?: number; ledger?: Ledger } = {},
): Decision {
  const ledger = opts.ledger ?? computeLedger(ev);
  const intents = plan(ev, { includeReminders: true, ignorePot: true }, ledger);
  const m = ev.mandate;
  const fmt = (c: Cents) => format(c, ev.currency);
  const deny = (subject: string, amountCents: Cents, reasons: string[], expected?: string): Decision => ({
    verdict: "deny",
    reasons,
    expected,
    subject,
    amountCents,
  });
  const ok = (subject: string, amountCents: Cents, reasons: string[], needsApproval: string[]): Decision => {
    if (needsApproval.length && !opts.approved)
      return { verdict: "approval", reasons: [...reasons, ...needsApproval], subject, amountCents };
    return {
      verdict: "allow",
      reasons: needsApproval.length ? [...reasons, "Approved by the organizer"] : reasons,
      subject,
      amountCents,
    };
  };

  switch (action.tool) {
    case "read":
      return { verdict: "allow", reasons: ["Read-only"], subject: action.name, amountCents: 0 };

    case "create_order": {
      const p = ev.participants.find((x) => x.id === action.participantId);
      const subject = p ? `Collect from ${p.name}` : "Collect";
      if (!p) return deny(subject, action.amountCents, [`No participant "${action.participantId}" in this event`]);
      if (p.status !== "active") return deny(subject, action.amountCents, [`${p.name} has dropped out`]);
      if (action.currency !== ev.currency)
        return deny(subject, action.amountCents, [`Currency ${action.currency} is not the event currency ${ev.currency}`]);
      if (action.itemsCents - action.discountCents !== action.amountCents)
        return deny(subject, action.amountCents, ["Line items minus discount do not add up to the order total"]);
      const want = intents.find((i): i is Extract<Intent, { kind: "collect" }> => i.kind === "collect" && i.participantId === p.id);
      const row = ledger.rows.find((r) => r.participantId === p.id)!;
      if (!want) {
        const why =
          row.openOrder && row.openOrder.amountCents === row.positionCents
            ? `${p.name} already has an open request for ${fmt(row.positionCents)}`
            : `The ledger says ${p.name} owes nothing right now`;
        return deny(subject, action.amountCents, [why], fmt(Math.max(0, row.positionCents)));
      }
      if (want.amountCents !== action.amountCents)
        return deny(subject, action.amountCents, [`The ledger says ${p.name} owes ${fmt(want.amountCents)}, not ${fmt(action.amountCents)}`], fmt(want.amountCents));
      return ok(subject, action.amountCents, [`Matches the ledger: ${p.name} owes ${fmt(want.amountCents)}`], []);
    }

    case "pay_order": {
      const o = ev.orders.find((x) => x.id === action.orderId);
      if (!o) return deny("Capture", 0, [`Order ${action.orderId} does not belong to this event`]);
      if (o.status === "COMPLETED") return deny("Capture", o.amountCents, ["Already captured"]);
      if (!isOpenOrder(o)) return deny("Capture", o.amountCents, [`Order is ${o.status}`]);
      return ok("Capture payment", o.amountCents, ["Payer approved this order"], []);
    }

    case "create_refund": {
      const o = ev.orders.find((x) => x.captureId === action.captureId);
      if (!o) return deny("Refund", action.amountCents, [`Capture ${action.captureId} does not belong to this event`]);
      const p = ev.participants.find((x) => x.id === o.participantId);
      const subject = `Refund ${p?.name ?? "payer"}`;
      if (action.currency !== ev.currency) return deny(subject, action.amountCents, ["Wrong currency"]);
      const left = o.capturedCents - o.refundedCents;
      if (action.amountCents <= 0 || action.amountCents > left)
        return deny(subject, action.amountCents, [`Only ${fmt(left)} of this capture is refundable`]);
      const want = intents.find((i): i is Extract<Intent, { kind: "refund" }> => i.kind === "refund" && i.captureId === action.captureId);
      if (!want) return deny(subject, action.amountCents, ["The ledger owes this person nothing"], fmt(0));
      if (action.amountCents > want.amountCents)
        return deny(subject, action.amountCents, [`The ledger owes ${fmt(want.amountCents)} on this capture, not ${fmt(action.amountCents)}`], fmt(want.amountCents));
      const extra: string[] = [];
      if (action.amountCents > m.maxRefundCents) extra.push(`Above the ${fmt(m.maxRefundCents)} refund limit`);
      return ok(subject, action.amountCents, [`Matches the ledger: refund ${fmt(want.amountCents)}`], extra);
    }

    case "create_payout": {
      const email = action.email.trim().toLowerCase();
      if (action.currency !== ev.currency) return deny("Payout", action.amountCents, ["Wrong currency"]);
      if (action.amountCents <= 0) return deny("Payout", action.amountCents, ["Amount must be positive"]);
      const person = intents.find(
        (i): i is Extract<Intent, { kind: "payout_participant" }> => i.kind === "payout_participant" && i.email.toLowerCase() === email,
      );
      const vendor = intents.find(
        (i): i is Extract<Intent, { kind: "payout_vendor" }> => i.kind === "payout_vendor" && i.email.toLowerCase() === email,
      );
      const extra: string[] = [];
      let subject: string;
      let reasons: string[];
      if (person) {
        const p = ev.participants.find((x) => x.id === person.participantId)!;
        subject = `Reimburse ${p.name}`;
        if (action.amountCents > person.amountCents)
          return deny(subject, action.amountCents, [`The ledger owes ${p.name} ${fmt(person.amountCents)}`], fmt(person.amountCents));
        reasons = [`Matches the ledger: ${p.name} is owed ${fmt(person.amountCents)}`];
      } else if (vendor) {
        subject = `Pay ${vendor.vendorName}`;
        if (action.amountCents > vendor.amountCents)
          return deny(subject, action.amountCents, [`${vendor.vendorName} is owed ${fmt(vendor.amountCents)}`], fmt(vendor.amountCents));
        reasons = [`Matches the ledger: ${vendor.vendorName} is owed ${fmt(vendor.amountCents)}`];
        if (!m.autoPayVendors) extra.push("Vendor payouts need approval under this mandate");
      } else if (m.extraPayees.map((e) => e.toLowerCase()).includes(email)) {
        subject = `Pay ${email}`;
        reasons = ["Payee is on the organizer's trusted list"];
        extra.push("Not derived from the ledger, so a human must confirm the amount");
      } else {
        return deny("Payout", action.amountCents, [`${email} is not a participant, a listed vendor or a trusted payee`]);
      }
      // Hard rule, not an approval: money leaves the pot only once it has arrived
      // (plus whatever float the organizer chose to front from the business balance).
      if (action.amountCents > ledger.totals.potCents + m.floatCents)
        return deny(subject, action.amountCents, [
          `The pot holds ${fmt(ledger.totals.potCents)}${m.floatCents ? ` plus a ${fmt(m.floatCents)} float` : ""}; this payout waits until the money is collected`,
        ]);
      if (action.amountCents > m.maxPayoutCents) extra.push(`Above the ${fmt(m.maxPayoutCents)} payout limit`);
      return ok(subject, action.amountCents, reasons, extra);
    }

    case "create_invoice": {
      const email = action.email.trim().toLowerCase();
      const s = ev.sponsors.find((x) => x.email.toLowerCase() === email);
      if (!s) return deny("Invoice", action.amountCents, [`${email} is not a sponsor of this event`]);
      const subject = `Invoice ${s.name}`;
      if (action.currency !== ev.currency) return deny(subject, action.amountCents, ["Wrong currency"]);
      const want = intents.find((i) => i.kind === "invoice" && i.sponsorId === s.id);
      if (!want) return deny(subject, action.amountCents, [`${s.name} already has an invoice`]);
      if (action.amountCents !== s.amountCents)
        return deny(subject, action.amountCents, [`${s.name} pledged ${fmt(s.amountCents)}`], fmt(s.amountCents));
      return ok(subject, action.amountCents, [`Matches the pledge of ${fmt(s.amountCents)}`], []);
    }

    case "send_invoice":
    case "send_invoice_reminder":
    case "cancel_sent_invoice": {
      const inv = ev.invoices.find((x) => x.id === action.invoiceId);
      if (!inv) return deny("Invoice", 0, [`Invoice ${action.invoiceId} does not belong to this event`]);
      const s = ev.sponsors.find((x) => x.id === inv.sponsorId);
      const subject = `${action.tool === "send_invoice" ? "Send" : action.tool === "cancel_sent_invoice" ? "Cancel" : "Remind"} ${s?.name ?? "sponsor"}`;
      if (action.tool === "send_invoice" && inv.status !== "DRAFT") return deny(subject, inv.amountCents, [`Invoice is ${inv.status}, not a draft`]);
      if (action.tool === "send_invoice_reminder") {
        if (inv.status === "PAID") return deny(subject, inv.amountCents, ["Invoice is already paid"]);
        if (inv.status === "DRAFT") return deny(subject, inv.amountCents, ["Invoice has not been sent yet"]);
        const now = opts.now ?? Date.now();
        if (inv.lastReminderAt && now - Date.parse(inv.lastReminderAt) < REMINDER_COOLDOWN_MS)
          return deny(subject, inv.amountCents, ["A reminder went out less than ten minutes ago"]);
      }
      if (action.tool === "cancel_sent_invoice")
        return ok(subject, inv.amountCents, ["Cancelling a sent invoice"], ["Cancelling an invoice needs a human"]);
      return ok(subject, inv.amountCents, ["Invoice belongs to this event"], []);
    }
  }
}
