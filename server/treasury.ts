import { randomBytes, randomUUID } from "node:crypto";
import { computeLedger } from "./domain/ledger.ts";
import { toCents, toDecimal, format, type Cents } from "./domain/money.ts";
import { evaluate, type MoneyAction, type Verdict } from "./domain/policy.ts";
import { plan, type Intent } from "./domain/planner.ts";
import type { AuditEntry, OrderRec, PurserEvent } from "./domain/types.ts";
import type { CallResult, PayPalPort, WebhookEvent } from "./paypal/port.ts";
import type { Bus, Store } from "./store.ts";

export interface Outcome {
  tool: string;
  verdict: Verdict;
  reasons: string[];
  expected?: string;
  subject: string;
  amountCents: Cents;
  executed: boolean;
  ok?: boolean;
  paypalId?: string;
  debugId?: string;
  error?: string;
  approvalId?: string;
  /** Short result handed back to the model. */
  summary: string;
}

export type Actor = AuditEntry["actor"];

export const MONEY_TOOLS = new Set([
  "create_order",
  "pay_order",
  "create_refund",
  "create_payout",
  "create_invoice",
  "send_invoice",
  "send_invoice_reminder",
  "cancel_sent_invoice",
]);
export const READ_TOOLS = new Set(["get_order", "get_invoice", "get_refund", "list_transactions"]);

const shortId = () => randomBytes(5).toString("hex");

export class Treasury {
  private store: Store;
  readonly pp: PayPalPort;
  private bus: Bus;
  private publicBase: string;
  constructor(store: Store, pp: PayPalPort, bus: Bus, publicBase: string) {
    this.store = store;
    this.pp = pp;
    this.bus = bus;
    this.publicBase = publicBase;
  }

  // ---- bookkeeping -----------------------------------------------------------

  audit(ev: PurserEvent, e: Omit<AuditEntry, "id" | "at">) {
    const entry: AuditEntry = { id: shortId(), at: new Date().toISOString(), ...e };
    ev.audit.push(entry);
    if (ev.audit.length > 1000) ev.audit.splice(0, ev.audit.length - 1000);
    this.bus.emit({ type: "audit", eventId: ev.id, entry });
    return entry;
  }

  /** A pending approval whose action the ledger no longer supports is expired, not left to be clicked. */
  expireStale(ev: PurserEvent) {
    for (const a of ev.approvals) {
      if (a.status !== "pending") continue;
      const n = this.normalize(ev, a.tool, a.args as Record<string, any>);
      const d = "error" in n ? undefined : evaluate(ev, n.action, { approved: true });
      if (!d || d.verdict === "deny") {
        a.status = "expired";
        a.resolvedAt = new Date().toISOString();
        a.result = `Expired: ${d ? d.reasons.join("; ") : "invalid"}`;
        this.audit(ev, { actor: "system", action: a.subject, detail: `Approval expired because the ledger changed (${d?.reasons[0] ?? "invalid"})`, amountCents: a.amountCents });
      }
    }
  }

  touch(ev: PurserEvent) {
    this.expireStale(ev);
    this.store.save();
    this.bus.emit({ type: "event", eventId: ev.id });
  }

  payUrl(ev: PurserEvent, participantId: string): string {
    if (!ev.payTokens[participantId]) ev.payTokens[participantId] = randomBytes(12).toString("base64url");
    return `${this.publicBase}/pay/${ev.payTokens[participantId]}`;
  }

  // ---- intents <-> tool calls --------------------------------------------------

  /** The tool call that would carry out a planner intent. */
  toolCallFor(ev: PurserEvent, i: Intent): { name: string; args: Record<string, unknown> } {
    const cur = ev.currency;
    switch (i.kind) {
      case "collect":
        return {
          name: "create_order",
          args: {
            participant_id: i.participantId,
            currencyCode: cur,
            items: i.lines.map((l) => ({ name: l.label.slice(0, 120), quantity: 1, itemCost: Number(toDecimal(l.amountCents)), itemTotal: Number(toDecimal(l.amountCents)) })),
            discount: Number(toDecimal(i.discountCents)),
          },
        };
      case "refund":
        return {
          name: "create_refund",
          args: { capture_id: i.captureId, amount: { currency_code: cur, value: toDecimal(i.amountCents) }, note_to_payer: `Refund from ${ev.name}` },
        };
      case "payout_participant":
        return { name: "create_payout", args: { email: i.email, amount: toDecimal(i.amountCents), currency: cur, note: `Reimbursement for ${ev.name}` } };
      case "payout_vendor":
        return { name: "create_payout", args: { email: i.email, amount: toDecimal(i.amountCents), currency: cur, note: `Payment for ${ev.name}` } };
      case "invoice": {
        const s = ev.sponsors.find((x) => x.id === i.sponsorId)!;
        return {
          name: "create_invoice",
          args: {
            currency_code: cur,
            invoicer_business_name: ev.name.slice(0, 300),
            note: s.note ?? `Contribution to ${ev.name}`,
            primary_recipients: [{ billing_info: { business_name: s.name, email_address: s.email } }],
            items: [{ name: `Contribution: ${ev.name}`.slice(0, 200), quantity: "1", unit_amount: { currency_code: cur, value: toDecimal(i.amountCents) } }],
          },
        };
      }
      case "send_invoice":
        return { name: "send_invoice", args: { invoice_id: i.invoiceId, send_to_recipient: true, note: `Thank you for supporting ${ev.name}.` } };
      case "remind_invoice":
        return { name: "send_invoice_reminder", args: { invoice_id: i.invoiceId, subject: `Reminder: ${ev.name}`, note: "A friendly reminder about your contribution." } };
    }
  }

  /** Turns a raw tool call into the action the mandate understands. */
  normalize(ev: PurserEvent, name: string, args: Record<string, any>): { action: MoneyAction; call: Record<string, any> } | { error: string } {
    try {
      switch (name) {
        case "create_order": {
          const pid = String(args.participant_id ?? "");
          const items: any[] = Array.isArray(args.items) ? args.items : [];
          if (!items.length) return { error: "items are required" };
          let itemsCents = 0;
          for (const it of items) {
            const q = Number(it.quantity ?? 1);
            const line = toCents(it.itemCost) * q;
            if (it.itemTotal !== undefined && toCents(it.itemTotal) !== line) return { error: `itemTotal of "${it.name}" is not itemCost x quantity` };
            itemsCents += line;
          }
          const discountCents = toCents(args.discount ?? 0);
          const token = ev.payTokens[pid] ?? "";
          return {
            action: { tool: "create_order", participantId: pid, amountCents: itemsCents - discountCents, currency: String(args.currencyCode ?? ""), itemsCents, discountCents },
            call: {
              currencyCode: args.currencyCode,
              items: items.map((it) => ({ name: String(it.name).slice(0, 127), quantity: Number(it.quantity ?? 1), itemCost: Number(it.itemCost), itemTotal: Number(it.itemTotal ?? Number(it.itemCost) * Number(it.quantity ?? 1)), ...(it.description ? { description: String(it.description).slice(0, 127) } : {}) })),
              discount: Number(args.discount ?? 0),
              // The mandate pins where payers return to; the model cannot redirect them.
              returnUrl: `${this.publicBase}/pay/return?e=${ev.id}&p=${encodeURIComponent(pid)}`,
              cancelUrl: `${this.publicBase}/pay/${token}?cancelled=1`,
            },
          };
        }
        case "pay_order":
          return { action: { tool: "pay_order", orderId: String(args.id ?? "") }, call: { id: args.id } };
        case "create_refund": {
          const captureId = String(args.capture_id ?? "");
          const o = ev.orders.find((x) => x.captureId === captureId);
          const cents = args.amount?.value !== undefined ? toCents(args.amount.value) : o ? o.capturedCents - o.refundedCents : 0;
          const cur = String(args.amount?.currency_code ?? ev.currency);
          return {
            action: { tool: "create_refund", captureId, amountCents: cents, currency: cur },
            // Never send an implicit full refund: the amount is always explicit.
            call: { capture_id: captureId, amount: { currency_code: cur, value: toDecimal(cents) }, ...(args.note_to_payer ? { note_to_payer: String(args.note_to_payer).slice(0, 255) } : {}) },
          };
        }
        case "create_payout": {
          const cents = toCents(args.amount ?? 0);
          return {
            action: { tool: "create_payout", email: String(args.email ?? ""), amountCents: cents, currency: String(args.currency ?? ev.currency) },
            call: { email: String(args.email ?? ""), amountCents: cents, currency: String(args.currency ?? ev.currency), note: String(args.note ?? `Payout from ${ev.name}`).slice(0, 255) },
          };
        }
        case "create_invoice": {
          const email = String(args.primary_recipients?.[0]?.billing_info?.email_address ?? "");
          const cur = String(args.currency_code ?? "");
          let cents = 0;
          for (const it of args.items ?? []) cents += toCents(it.unit_amount?.value ?? 0) * Number(it.quantity ?? 1);
          return { action: { tool: "create_invoice", email, amountCents: cents, currency: cur }, call: args };
        }
        case "send_invoice":
        case "send_invoice_reminder":
        case "cancel_sent_invoice":
          return { action: { tool: name, invoiceId: String(args.invoice_id ?? "") }, call: args };
        default:
          if (READ_TOOLS.has(name)) return { action: { tool: "read", name }, call: args };
          return { error: `Tool ${name} is not available to Purser` };
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  // ---- the guarded executor ----------------------------------------------------

  /** One money move at a time per event: the mandate is evaluated and the call made under the same lock. */
  private locks = new Map<string, Promise<unknown>>();

  run(ev: PurserEvent, name: string, args: Record<string, any>, actor: Actor, opts: { approvalId?: string } = {}): Promise<Outcome> {
    const prev = this.locks.get(ev.id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.runUnlocked(ev, name, args, actor, opts));
    const tail = next.catch(() => undefined);
    this.locks.set(ev.id, tail);
    void tail.then(() => {
      if (this.locks.get(ev.id) === tail) this.locks.delete(ev.id);
    });
    return next;
  }

  private async runUnlocked(ev: PurserEvent, name: string, args: Record<string, any>, actor: Actor, opts: { approvalId?: string }): Promise<Outcome> {
    const n = this.normalize(ev, name, args);
    if ("error" in n) {
      this.audit(ev, { actor, action: name, detail: `Rejected: ${n.error}`, verdict: "deny" });
      this.touch(ev);
      return { tool: name, verdict: "deny", reasons: [n.error], subject: name, amountCents: 0, executed: false, summary: `DENIED: ${n.error}` };
    }
    const d = evaluate(ev, n.action, { approved: Boolean(opts.approvalId) });
    const base: Outcome = { tool: name, verdict: d.verdict, reasons: d.reasons, expected: d.expected, subject: d.subject, amountCents: d.amountCents, executed: false, summary: "" };

    if (d.verdict === "deny") {
      this.audit(ev, { actor, action: d.subject, detail: d.reasons.join("; "), amountCents: d.amountCents, verdict: "deny" });
      this.touch(ev);
      return { ...base, summary: `DENIED by the mandate: ${d.reasons.join("; ")}${d.expected ? ` (ledger expects ${d.expected})` : ""}` };
    }
    if (d.verdict === "approval") {
      const existing = ev.approvals.find((a) => a.status === "pending" && a.tool === name && JSON.stringify(a.args) === JSON.stringify(args));
      const approval = existing ?? {
        id: shortId(),
        createdAt: new Date().toISOString(),
        tool: name,
        args,
        subject: d.subject,
        amountCents: d.amountCents,
        reasons: d.reasons,
        status: "pending" as const,
      };
      if (!existing) ev.approvals.push(approval);
      this.audit(ev, { actor, action: d.subject, detail: `Waiting for the organizer: ${d.reasons.join("; ")}`, amountCents: d.amountCents, verdict: "approval" });
      this.touch(ev);
      return { ...base, approvalId: approval.id, summary: `QUEUED for organizer approval (${approval.id}): ${d.reasons.join("; ")}` };
    }

    let r: CallResult;
    try {
      r = await this.dispatch(ev, name, n.action, n.call);
    } catch (e) {
      // A network failure or timeout is not a PayPal answer. Nothing is recorded
      // in the ledger, and the next run re-plans from what PayPal confirmed.
      r = { ok: false, status: 0, data: null, error: `Could not reach PayPal (${(e as Error).message || "network error"}); nothing was recorded, try again` };
    }
    const paypalId = this.idOf(name, r);
    this.audit(ev, {
      actor,
      action: d.subject,
      detail: r.ok ? `${name} succeeded` : `${name} failed: ${r.error}`,
      amountCents: d.amountCents,
      verdict: "allow",
      paypalId,
      debugId: r.debugId,
    });
    this.touch(ev);
    return {
      ...base,
      executed: true,
      ok: r.ok,
      paypalId,
      debugId: r.debugId,
      error: r.ok ? undefined : r.error,
      summary: r.ok ? `OK ${name}${paypalId ? ` ${paypalId}` : ""}: ${d.reasons.join("; ")}` : `PayPal error on ${name}: ${r.error}`,
    };
  }

  private idOf(name: string, r: CallResult): string | undefined {
    if (!r.ok || !r.data) return undefined;
    const d = r.data;
    if (name === "create_invoice") return String(d.href ?? "").split("/").pop();
    if (name === "create_payout") return d.batch_header?.payout_batch_id;
    if (name === "pay_order") return d.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? d.id;
    return d.id;
  }

  private async dispatch(ev: PurserEvent, name: string, action: MoneyAction, call: Record<string, any>): Promise<CallResult> {
    switch (action.tool) {
      case "create_order": {
        let r: CallResult;
        if (ev.currency === "USD") r = await this.pp.callTool("create_order", call);
        else r = await this.pp.createOrderRest(this.orderBody(ev, call), `order-${ev.id}-${action.participantId}-${action.amountCents}-${ev.orders.length}`);
        if (r.ok) this.recordOrder(ev, action.participantId, action.amountCents, r.data, ev.currency === "USD" ? "agent-toolkit" : "rest");
        return r;
      }
      case "pay_order": {
        const r = await this.pp.captureOrder(action.orderId, `capture-${action.orderId}`);
        if (r.ok) this.applyOrder(ev, r.data);
        return r;
      }
      case "create_refund": {
        const r = await this.pp.callTool("create_refund", call);
        if (r.ok) this.applyRefund(ev, r.data, action.captureId);
        return r;
      }
      case "create_payout": {
        const isVendor = ev.items.find((i) => i.vendor?.email.toLowerCase() === action.email.toLowerCase() && !i.paidById);
        const p = ev.participants.find((x) => x.email.toLowerCase() === action.email.toLowerCase());
        const senderItemId = `${ev.id}-${shortId()}`;
        const batchId = `purser-${ev.id}-${Date.now().toString(36)}`;
        const r = await this.pp.createPayout(batchId, `${ev.name}: payout`, [
          { email: action.email, value: toDecimal(action.amountCents), currency: action.currency, note: String(call.note), senderItemId },
        ]);
        if (r.ok)
          ev.payouts.push({
            batchId: r.data.batch_header.payout_batch_id,
            senderItemId,
            payee: isVendor ? { type: "vendor", itemId: isVendor.id } : { type: "participant", participantId: p?.id ?? "" },
            email: action.email,
            amountCents: action.amountCents,
            status: r.data.batch_header.batch_status ?? "PENDING",
            createdAt: new Date().toISOString(),
          });
        return r;
      }
      case "create_invoice": {
        const r = await this.pp.callTool("create_invoice", call);
        if (r.ok) {
          const s = ev.sponsors.find((x) => x.email.toLowerCase() === action.email.toLowerCase())!;
          ev.invoices.push({ id: String(r.data.href ?? r.data.id).split("/").pop()!, sponsorId: s.id, amountCents: action.amountCents, status: "DRAFT", reminders: 0, createdAt: new Date().toISOString() });
        }
        return r;
      }
      case "send_invoice":
      case "send_invoice_reminder":
      case "cancel_sent_invoice": {
        const r = await this.pp.callTool(action.tool, call);
        const inv = ev.invoices.find((x) => x.id === action.invoiceId)!;
        if (r.ok) {
          if (action.tool === "send_invoice") inv.status = "SENT";
          if (action.tool === "cancel_sent_invoice") inv.status = "CANCELLED";
          if (action.tool === "send_invoice_reminder") {
            inv.reminders += 1;
            inv.lastReminderAt = new Date().toISOString();
          }
        }
        return r;
      }
      case "read":
        return this.pp.callTool(action.name, call);
    }
  }

  private orderBody(ev: PurserEvent, call: Record<string, any>) {
    const cur = ev.currency;
    const itemTotal = call.items.reduce((s: number, i: any) => s + toCents(i.itemCost) * i.quantity, 0);
    const disc = toCents(call.discount ?? 0);
    return {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: cur,
            value: toDecimal(itemTotal - disc),
            breakdown: { item_total: { currency_code: cur, value: toDecimal(itemTotal) }, discount: { currency_code: cur, value: toDecimal(disc) } },
          },
          items: call.items.map((i: any) => ({ name: i.name, quantity: String(i.quantity), unit_amount: { currency_code: cur, value: toDecimal(toCents(i.itemCost)) } })),
        },
      ],
      payment_source: { paypal: { experience_context: { return_url: call.returnUrl, cancel_url: call.cancelUrl, user_action: "PAY_NOW", brand_name: ev.name.slice(0, 127) } } },
    };
  }

  // ---- applying PayPal state to the ledger ---------------------------------------

  recordOrder(ev: PurserEvent, participantId: string, amountCents: Cents, data: any, via: OrderRec["via"]) {
    for (const o of ev.orders)
      if (o.participantId === participantId && (["CREATED", "PAYER_ACTION_REQUIRED"].includes(o.status) || (o.status === "APPROVED" && o.declinedAt))) o.status = "SUPERSEDED";
    const link = (data.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    ev.orders.push({
      id: data.id,
      participantId,
      amountCents,
      status: data.status ?? "CREATED",
      approveUrl: link?.href,
      capturedCents: 0,
      refundedCents: 0,
      createdAt: new Date().toISOString(),
      via,
    });
    this.payUrl(ev, participantId);
  }

  applyOrder(ev: PurserEvent, data: any) {
    const o = ev.orders.find((x) => x.id === data?.id);
    if (!o) return;
    if (data.status && o.status !== "SUPERSEDED") o.status = data.status;
    const pay = data.purchase_units?.[0]?.payments;
    const caps = (pay?.captures ?? []).filter((c: any) => ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].includes(c.status));
    if (caps.length) {
      o.captureId = caps[0].id;
      o.capturedCents = caps.reduce((s: number, c: any) => s + toCents(c.amount.value), 0);
      if (o.status === "SUPERSEDED") o.status = "COMPLETED";
    }
    for (const rf of pay?.refunds ?? []) this.applyRefund(ev, rf, o.captureId);
  }

  applyRefund(ev: PurserEvent, rf: any, captureId?: string) {
    const capId = captureId ?? String((rf.links ?? []).find((l: any) => l.rel === "up")?.href ?? "").split("/").pop();
    const o = ev.orders.find((x) => x.captureId === capId);
    if (!o || ev.refunds.some((r) => r.id === rf.id)) return;
    if (rf.status && !["COMPLETED", "PENDING"].includes(rf.status)) return;
    const cents = toCents(rf.amount.value);
    ev.refunds.push({ id: rf.id, orderId: o.id, captureId: capId!, participantId: o.participantId, amountCents: cents, status: rf.status ?? "COMPLETED", createdAt: new Date().toISOString() });
    o.refundedCents += cents;
  }

  applyPayoutItem(ev: PurserEvent, item: any) {
    const sid = item?.payout_item?.sender_item_id;
    const rec = ev.payouts.find((p) => p.senderItemId === sid);
    if (!rec) return false;
    rec.itemId = item.payout_item_id ?? rec.itemId;
    rec.status = item.transaction_status ?? rec.status;
    return true;
  }

  // ---- webhooks and reconciliation -----------------------------------------------

  private findEventFor(pred: (ev: PurserEvent) => boolean): PurserEvent | undefined {
    return this.store.data.events.find(pred);
  }

  async handleWebhook(e: WebhookEvent, source: "paypal" | "fixture"): Promise<{ handled: boolean; eventId?: string }> {
    if (this.store.data.seenWebhooks.includes(e.id)) return { handled: false };
    this.store.data.seenWebhooks.push(e.id);
    if (this.store.data.seenWebhooks.length > 5000) this.store.data.seenWebhooks.splice(0, 1000);
    const r = e.resource ?? {};
    let ev: PurserEvent | undefined;
    let detail = e.summary ?? e.event_type;
    switch (e.event_type) {
      case "CHECKOUT.ORDER.APPROVED": {
        ev = this.findEventFor((x) => x.orders.some((o) => o.id === r.id));
        if (ev) {
          const o = ev.orders.find((x) => x.id === r.id)!;
          if (o.status === "SUPERSEDED") {
            // The payer approved an older request whose amount the ledger has since
            // changed. Never capture it: an uncaptured approval charges nothing and lapses.
            this.audit(ev, { actor: "webhook", action: "Ignored approval of a replaced request", detail: `${e.event_type} (${source}); the payer is asked for the current amount instead`, paypalId: r.id, amountCents: o.amountCents });
            this.touch(ev);
            return { handled: true, eventId: ev.id };
          }
          if (o.status !== "COMPLETED") {
            o.status = "APPROVED";
            o.declinedAt = undefined; // a fresh approval, possibly with another funding source
            this.audit(ev, { actor: "webhook", action: "Order approved", detail: `${e.event_type} (${source})`, paypalId: r.id, amountCents: o.amountCents });
            await this.capture(ev, r.id, "system");
          }
          return { handled: true, eventId: ev.id };
        }
        break;
      }
      case "PAYMENT.CAPTURE.COMPLETED": {
        const orderId = r.supplementary_data?.related_ids?.order_id;
        ev = this.findEventFor((x) => x.orders.some((o) => o.id === orderId));
        if (ev) {
          const o = ev.orders.find((x) => x.id === orderId)!;
          if (!o.captureId) {
            o.captureId = r.id;
            o.capturedCents = toCents(r.amount.value);
            o.status = "COMPLETED";
          }
          detail = `Capture ${r.id} completed (${format(toCents(r.amount.value), r.amount.currency_code)})`;
        }
        break;
      }
      case "PAYMENT.CAPTURE.REFUNDED": {
        const capId = String((r.links ?? []).find((l: any) => l.rel === "up")?.href ?? "").split("/").pop();
        ev = this.findEventFor((x) => x.orders.some((o) => o.captureId === capId));
        if (ev) this.applyRefund(ev, r, capId);
        break;
      }
      case "INVOICING.INVOICE.PAID":
      case "INVOICING.INVOICE.CANCELLED":
      case "INVOICING.INVOICE.REFUNDED": {
        const inv = r.invoice ?? r;
        ev = this.findEventFor((x) => x.invoices.some((i) => i.id === inv.id));
        if (ev) ev.invoices.find((i) => i.id === inv.id)!.status = inv.status ?? e.event_type.split(".").pop()!;
        break;
      }
      case "PAYMENT.PAYOUTSBATCH.SUCCESS":
      case "PAYMENT.PAYOUTSBATCH.DENIED":
      case "PAYMENT.PAYOUTSBATCH.PROCESSING": {
        const id = r.batch_header?.payout_batch_id;
        ev = this.findEventFor((x) => x.payouts.some((p) => p.batchId === id));
        if (ev) for (const it of r.items ?? []) this.applyPayoutItem(ev, it);
        break;
      }
      default:
        if (e.event_type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
          ev = this.findEventFor((x) => x.payouts.some((p) => p.senderItemId === r.payout_item?.sender_item_id));
          if (ev) this.applyPayoutItem(ev, r);
        }
    }
    if (!ev) {
      this.store.save();
      return { handled: false };
    }
    this.audit(ev, { actor: "webhook", action: e.event_type, detail: `${detail} (${source === "paypal" ? "verified" : "simulated"})`, paypalId: r.id ?? r.invoice?.id ?? r.batch_header?.payout_batch_id ?? r.payout_item_id });
    this.touch(ev);
    return { handled: true, eventId: ev.id };
  }

  /** Pulls current state from PayPal for everything still in flight. */
  async reconcile(ev: PurserEvent): Promise<number> {
    let changes = 0;
    for (const o of ev.orders.filter((x) => ["PAYER_ACTION_REQUIRED", "APPROVED", "CREATED"].includes(x.status))) {
      const r = await this.pp.getOrder(o.id);
      if (!r.ok) continue;
      const before = o.status;
      this.applyOrder(ev, r.data);
      // A declined approval waits for the payer to pick another funding source.
      if (o.status === "APPROVED" && !o.declinedAt) await this.capture(ev, o.id, "system");
      if (o.status !== before) changes++;
    }
    const batches = new Set(ev.payouts.filter((p) => ["PENDING", "PROCESSING", "UNCLAIMED", "ONHOLD"].includes(p.status.toUpperCase())).map((p) => p.batchId));
    for (const b of batches) {
      const r = await this.pp.getPayoutBatch(b);
      if (r.ok) for (const it of r.data.items ?? []) if (this.applyPayoutItem(ev, it)) changes++;
    }
    for (const inv of ev.invoices.filter((i) => i.status === "SENT")) {
      const r = await this.pp.callTool("get_invoice", { invoice_id: inv.id });
      if (r.ok && r.data?.status && r.data.status !== inv.status) {
        inv.status = r.data.status;
        changes++;
      }
    }
    this.audit(ev, { actor: "system", action: "Reconciled with PayPal", detail: `${changes} change(s)` });
    this.touch(ev);
    return changes;
  }

  /** The deterministic treasurer: carries out the plan through the same guard. */
  async runPlan(ev: PurserEvent, opts: { includeReminders?: boolean } = {}): Promise<Outcome[]> {
    const out: Outcome[] = [];
    const tried = new Set<string>();
    // Re-plan after each pass: some steps only exist once an earlier one ran
    // (an invoice can be sent only after it was created).
    for (let pass = 0; pass < 4; pass++) {
      const fresh = plan(ev, opts).filter((i) => !tried.has(JSON.stringify(i)));
      if (!fresh.length) break;
      for (const i of fresh) {
        tried.add(JSON.stringify(i));
        const call = this.toolCallFor(ev, i);
        out.push(await this.run(ev, call.name, call.args, "agent"));
      }
    }
    return out;
  }

  async decideApproval(ev: PurserEvent, approvalId: string, approve: boolean): Promise<Outcome | undefined> {
    const a = ev.approvals.find((x) => x.id === approvalId && x.status === "pending");
    if (!a) return undefined;
    a.resolvedAt = new Date().toISOString();
    if (!approve) {
      a.status = "rejected";
      this.audit(ev, { actor: "organizer", action: a.subject, detail: "Rejected by the organizer", amountCents: a.amountCents });
      this.touch(ev);
      return undefined;
    }
    a.status = "approved";
    this.audit(ev, { actor: "organizer", action: a.subject, detail: "Approved by the organizer", amountCents: a.amountCents });
    const r = await this.run(ev, a.tool, a.args as Record<string, any>, "organizer", { approvalId: a.id });
    a.status = r.executed && r.ok ? "executed" : "failed";
    a.result = r.summary;
    this.touch(ev);
    return r;
  }

  private captures = new Map<string, Promise<Outcome | undefined>>();

  /** Capture once, however many paths (return URL, webhook, reconcile) ask for it. */
  capture(ev: PurserEvent, orderId: string, actor: Actor): Promise<Outcome | undefined> {
    const o = ev.orders.find((x) => x.id === orderId);
    if (!o || o.status === "COMPLETED") return Promise.resolve(undefined);
    const inflight = this.captures.get(orderId);
    if (inflight) return inflight;
    const p = this.run(ev, "pay_order", { id: orderId }, actor).finally(() => this.captures.delete(orderId));
    this.captures.set(orderId, p);
    return p;
  }

  newRequestId() {
    return randomUUID();
  }

  ledger(ev: PurserEvent) {
    return computeLedger(ev);
  }
}
