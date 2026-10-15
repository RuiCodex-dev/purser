import { randomInt } from "node:crypto";
import { TOOLKIT_VERSION } from "./live.ts";
import type { CallResult, PayPalPort, PayoutItemInput, WebhookEvent } from "./port.ts";

// FixturePayPal replays the documented PayPal sandbox contracts offline:
// Orders v2, Payments v2 refunds, Invoicing v2, Payouts v1, Reporting v1 and
// Webhooks. Response bodies follow the shapes in PayPal's API reference and in
// the Agent Toolkit's handlers (including its USD-only create_order schema), so
// the rest of Purser cannot tell the difference except through `mode`.
// Every simulated webhook is delivered to the same handler real ones use.

const ALNUM = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
function rid(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += ALNUM[randomInt(ALNUM.length)];
  return s;
}
const invoiceId = () => `INV2-${rid(4)}-${rid(4)}-${rid(4)}-${rid(4)}`;
const now = () => new Date().toISOString();
const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

interface FxState {
  orders: Record<string, any>;
  refunds: Record<string, any>;
  invoices: Record<string, any>;
  batches: Record<string, any>;
  requestIds: Record<string, string>;
}

export class FixturePayPal implements PayPalPort {
  readonly mode = "fixtures" as const;
  private s: FxState = { orders: {}, refunds: {}, invoices: {}, batches: {}, requestIds: {} };
  private api = "https://api-m.sandbox.paypal.com";

  private opts: { publicBase: string; onWebhook: (e: WebhookEvent) => Promise<void> | void; settleMs?: number };
  constructor(opts: { publicBase: string; onWebhook: (e: WebhookEvent) => Promise<void> | void; settleMs?: number }) {
    this.opts = opts;
  }

  describe() {
    return { mode: "Offline fixtures (PayPal sandbox contracts)", base: this.api, toolkitVersion: TOOLKIT_VERSION };
  }

  snapshot(): FxState {
    return this.s;
  }

  restore(s: FxState | undefined) {
    if (s) this.s = { ...{ orders: {}, refunds: {}, invoices: {}, batches: {}, requestIds: {} }, ...s };
  }

  private debug() {
    return `fx-${rid(12).toLowerCase()}`;
  }

  private ok(data: any, status = 200): CallResult {
    return { ok: true, status, data, debugId: this.debug() };
  }

  private fail(status: number, name: string, message: string): CallResult {
    // Mirrors both PayPal's error body and the toolkit's LlmError serialisation.
    return { ok: false, status, data: { error: { name, message, status } }, error: message, debugId: this.debug() };
  }

  private emit(event_type: string, resource: any, resource_type: string, summary: string) {
    const e: WebhookEvent = {
      id: `WH-${rid(17)}-${rid(17)}`,
      event_type,
      create_time: now(),
      resource_type,
      resource,
      summary,
    };
    queueMicrotask(() => void this.opts.onWebhook(e));
  }

  // ---- Agent Toolkit tools -------------------------------------------------

  async callTool(name: string, args: Record<string, any>): Promise<CallResult> {
    switch (name) {
      case "create_order":
        return this.createOrder(args);
      case "get_order":
        return this.getOrder(String(args.id));
      case "pay_order": {
        const r = await this.captureOrder(String(args.id), `tool-${args.id}`);
        // The toolkit wraps capture results in { status, response }.
        return r.ok ? this.ok({ status: "success", response: r.data }) : r;
      }
      case "create_refund":
        return this.createRefund(args);
      case "get_refund": {
        const r = this.s.refunds[String(args.refund_id)];
        return r ? this.ok(r) : this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
      }
      case "create_invoice":
        return this.createInvoice(args);
      case "get_invoice": {
        const inv = this.s.invoices[String(args.invoice_id)];
        return inv ? this.ok(inv) : this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
      }
      case "send_invoice":
        return this.sendInvoice(String(args.invoice_id));
      case "send_invoice_reminder":
        return this.remindInvoice(String(args.invoice_id));
      case "cancel_sent_invoice":
        return this.cancelInvoice(String(args.invoice_id));
      case "list_transactions":
        return this.listTransactions();
      default:
        return this.fail(400, "TOOL_NOT_ENABLED", `Tool ${name} is not enabled for Purser`);
    }
  }

  private createOrder(a: Record<string, any>): CallResult {
    // Same validation the toolkit's zod schema applies.
    if (a.currencyCode !== "USD")
      return this.fail(400, "INVALID_PARAMETER", `currencyCode: Invalid enum value. Expected 'USD', received '${a.currencyCode}'`);
    if (!Array.isArray(a.items) || a.items.length === 0) return this.fail(400, "INVALID_PARAMETER", "items: Required");
    const items = a.items.map((i: any) => ({ ...i, quantity: Number(i.quantity ?? 1), taxPercent: Number(i.taxPercent ?? 0) }));
    const sub = items.reduce((s: number, i: any) => s + Number(i.itemCost) * i.quantity, 0);
    const tax = items.reduce((s: number, i: any) => s + (Number(i.itemCost) * i.taxPercent * i.quantity) / 100, 0);
    const total = sub + tax + Number(a.shippingCost ?? 0) - Number(a.discount ?? 0);
    return this.storeOrder(
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: "default",
            amount: {
              currency_code: "USD",
              value: r2(total),
              breakdown: {
                item_total: { currency_code: "USD", value: r2(sub) },
                tax_total: { currency_code: "USD", value: r2(tax) },
                discount: { currency_code: "USD", value: r2(Number(a.discount ?? 0)) },
              },
            },
            items: items.map((i: any) => ({
              name: i.name,
              description: i.description,
              unit_amount: { currency_code: "USD", value: r2(Number(i.itemCost)) },
              quantity: String(i.quantity),
            })),
          },
        ],
      },
      a.returnUrl,
      a.cancelUrl,
    );
  }

  private storeOrder(req: any, returnUrl?: string, cancelUrl?: string): CallResult {
    const id = `${randomInt(1, 9)}${rid(16)}`;
    const order = {
      id,
      intent: req.intent ?? "CAPTURE",
      status: "PAYER_ACTION_REQUIRED",
      payment_source: { paypal: {} },
      purchase_units: req.purchase_units,
      create_time: now(),
      links: [
        { href: `${this.api}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
        { href: `${this.opts.publicBase}/sandbox-sim/checkout?token=${id}`, rel: "payer-action", method: "GET" },
      ],
      _return_url: returnUrl,
      _cancel_url: cancelUrl,
    };
    this.s.orders[id] = order;
    return this.ok(this.publicOrder(order), 200);
  }

  private publicOrder(o: any) {
    const { _return_url, _cancel_url, ...rest } = o;
    return structuredClone(rest);
  }

  async createOrderRest(body: any, requestId: string): Promise<CallResult> {
    const seen = this.s.requestIds[requestId];
    if (seen) return this.ok(this.publicOrder(this.s.orders[seen]), 200);
    const ctx = body?.payment_source?.paypal?.experience_context ?? {};
    const r = this.storeOrder(body, ctx.return_url, ctx.cancel_url);
    this.s.requestIds[requestId] = r.data.id;
    return r;
  }

  async getOrder(id: string): Promise<CallResult> {
    const o = this.s.orders[id];
    return o ? this.ok(this.publicOrder(o)) : this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
  }

  /** Simulator: the buyer approved on the checkout page. Returns the merchant's return URL. */
  approveOrder(id: string): string | undefined {
    const o = this.s.orders[id];
    if (!o || o.status !== "PAYER_ACTION_REQUIRED") return undefined;
    o.status = "APPROVED";
    o.payer = { payer_id: rid(13), email_address: "sb-buyer@personal.example.com", name: { given_name: "Sandbox", surname: "Buyer" } };
    this.emit("CHECKOUT.ORDER.APPROVED", this.publicOrder(o), "checkout-order", `An order has been approved by buyer.`);
    const ret = o._return_url;
    return ret ? `${ret}${ret.includes("?") ? "&" : "?"}token=${id}&PayerID=${o.payer.payer_id}` : undefined;
  }

  cancelUrlFor(id: string): string | undefined {
    return this.s.orders[id]?._cancel_url;
  }

  async captureOrder(id: string, requestId: string): Promise<CallResult> {
    const o = this.s.orders[id];
    if (!o) return this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
    if (o.status === "COMPLETED") {
      if (this.s.requestIds[requestId] === id) return this.ok(this.publicOrder(o), 200);
      return this.fail(422, "ORDER_ALREADY_CAPTURED", "Order already captured.");
    }
    if (o.status !== "APPROVED")
      return this.fail(422, "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.");
    const pu = o.purchase_units[0];
    const capture = {
      id: rid(17),
      status: "COMPLETED",
      amount: { currency_code: pu.amount.currency_code, value: pu.amount.value },
      final_capture: true,
      seller_receivable_breakdown: {
        gross_amount: { currency_code: pu.amount.currency_code, value: pu.amount.value },
        paypal_fee: { currency_code: pu.amount.currency_code, value: r2(Number(pu.amount.value) * 0.0349 + 0.49) },
      },
      supplementary_data: { related_ids: { order_id: id } },
      create_time: now(),
      update_time: now(),
      links: [] as any[],
    };
    capture.links.push({ href: `${this.api}/v2/payments/captures/${capture.id}`, rel: "self", method: "GET" });
    pu.payments ={ captures: [capture], refunds: [] };
    o.status = "COMPLETED";
    this.s.requestIds[requestId] = id;
    this.emit("PAYMENT.CAPTURE.COMPLETED", structuredClone(capture), "capture", `Payment completed for $ ${capture.amount.value} USD`);
    return this.ok(this.publicOrder(o), 201);
  }

  private createRefund(a: Record<string, any>): CallResult {
    const capId = String(a.capture_id);
    const order = Object.values(this.s.orders).find((o: any) =>
      o.purchase_units?.[0]?.payments?.captures?.some((c: any) => c.id === capId),
    ) as any;
    if (!order) return this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
    const pu = order.purchase_units[0];
    const cap = pu.payments.captures.find((c: any) => c.id === capId);
    const refunded = pu.payments.refunds.reduce((s: number, r: any) => s + Number(r.amount.value), 0);
    const remaining = Number(cap.amount.value) - refunded;
    const value = a.amount?.value !== undefined ? Number(a.amount.value) : remaining;
    if (value <= 0 || value > remaining + 1e-9)
      return this.fail(422, "REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.");
    const refundId = rid(17);
    const refund = {
      id: refundId,
      status: "COMPLETED",
      amount: { currency_code: cap.amount.currency_code, value: r2(value) },
      note_to_payer: a.note_to_payer,
      create_time: now(),
      links: [
        { href: `${this.api}/v2/payments/refunds/${refundId}`, rel: "self", method: "GET" },
        { href: `${this.api}/v2/payments/captures/${capId}`, rel: "up", method: "GET" },
      ],
    };
    pu.payments.refunds.push(refund);
    if (refunded + value >= Number(cap.amount.value) - 1e-9) cap.status = "REFUNDED";
    else cap.status = "PARTIALLY_REFUNDED";
    this.s.refunds[refund.id] = refund;
    this.emit("PAYMENT.CAPTURE.REFUNDED", structuredClone(refund), "refund", `A $ ${refund.amount.value} USD capture payment was refunded`);
    return this.ok(structuredClone(refund), 201);
  }

  private createInvoice(a: Record<string, any>): CallResult {
    const id = invoiceId();
    const cur = String(a.currency_code ?? "USD");
    const items = (a.items ?? []).map((i: any) => ({
      name: i.name,
      quantity: String(i.quantity ?? "1"),
      unit_amount: { currency_code: cur, value: r2(Number(i.unit_amount?.value ?? i.unit_amount ?? 0)) },
    }));
    const total = items.reduce((s: number, i: any) => s + Number(i.unit_amount.value) * Number(i.quantity), 0);
    this.s.invoices[id] = {
      id,
      status: "DRAFT",
      detail: { currency_code: cur, note: a.note, invoice_date: a.invoice_date ?? now().slice(0, 10), reference: a.reference },
      invoicer: { business_name: a.invoicer_business_name },
      primary_recipients: a.primary_recipients ?? [],
      items,
      amount: { currency_code: cur, value: r2(total) },
      due_amount: { currency_code: cur, value: r2(total) },
      links: [{ href: `${this.api}/v2/invoicing/invoices/${id}`, rel: "self", method: "GET" }],
    };
    // Invoicing v2 create returns a link description, not the invoice.
    return this.ok({ rel: "self", href: `${this.api}/v2/invoicing/invoices/${id}`, method: "GET" }, 201);
  }

  private sendInvoice(id: string): CallResult {
    const inv = this.s.invoices[id];
    if (!inv) return this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
    if (inv.status !== "DRAFT") return this.fail(422, "INVALID_INVOICE_STATUS", `Invoice status is ${inv.status}.`);
    inv.status = "SENT";
    this.emit("INVOICING.INVOICE.CREATED", { invoice: structuredClone(inv) }, "invoices", "An invoice was sent");
    return this.ok({ rel: "payer-view", href: `${this.opts.publicBase}/sandbox-sim/invoice/${id}`, method: "GET" }, 200);
  }

  private remindInvoice(id: string): CallResult {
    const inv = this.s.invoices[id];
    if (!inv) return this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
    if (inv.status !== "SENT") return this.fail(422, "INVALID_INVOICE_STATUS", `Invoice status is ${inv.status}.`);
    return { ok: true, status: 204, data: null, debugId: this.debug() };
  }

  private cancelInvoice(id: string): CallResult {
    const inv = this.s.invoices[id];
    if (!inv) return this.fail(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.");
    inv.status = "CANCELLED";
    this.emit("INVOICING.INVOICE.CANCELLED", { invoice: structuredClone(inv) }, "invoices", "An invoice was cancelled");
    return { ok: true, status: 204, data: null, debugId: this.debug() };
  }

  /** Simulator: the sponsor pays the invoice from the payer view. */
  payInvoice(id: string): boolean {
    const inv = this.s.invoices[id];
    if (!inv || inv.status !== "SENT") return false;
    inv.status = "PAID";
    inv.payments = {
      paid_amount: { ...inv.amount },
      transactions: [{ payment_id: rid(17), method: "PAYPAL", payment_date: now().slice(0, 10), amount: { ...inv.amount } }],
    };
    inv.due_amount = { currency_code: inv.amount.currency_code, value: "0.00" };
    this.emit("INVOICING.INVOICE.PAID", { invoice: structuredClone(inv) }, "invoices", "An invoice was paid");
    return true;
  }

  invoiceView(id: string) {
    return this.s.invoices[id] ? structuredClone(this.s.invoices[id]) : undefined;
  }

  private listTransactions(): CallResult {
    const tx: any[] = [];
    for (const o of Object.values(this.s.orders) as any[]) {
      for (const c of o.purchase_units?.[0]?.payments?.captures ?? [])
        tx.push({ transaction_info: { transaction_id: c.id, transaction_event_code: "T0006", transaction_amount: c.amount, transaction_status: "S", transaction_initiation_date: c.create_time } });
      for (const r of o.purchase_units?.[0]?.payments?.refunds ?? [])
        tx.push({ transaction_info: { transaction_id: r.id, transaction_event_code: "T1107", transaction_amount: { ...r.amount, value: `-${r.amount.value}` }, transaction_status: "S", transaction_initiation_date: r.create_time } });
    }
    for (const b of Object.values(this.s.batches) as any[])
      for (const i of b.items)
        tx.push({ transaction_info: { transaction_id: i.transaction_id ?? i.payout_item_id, transaction_event_code: "T0000", transaction_amount: { ...i.payout_item.amount, value: `-${i.payout_item.amount.value}` }, transaction_status: i.transaction_status === "SUCCESS" ? "S" : "P", transaction_initiation_date: b.batch_header.time_created } });
    return this.ok({ transaction_details: tx, account_number: "FIXTURE", total_items: tx.length, total_pages: 1, page: 1 });
  }

  // ---- Payouts v1 ------------------------------------------------------------

  async createPayout(batchId: string, subject: string, items: PayoutItemInput[]): Promise<CallResult> {
    const existing = Object.values(this.s.batches).find((b: any) => b.batch_header.sender_batch_header.sender_batch_id === batchId) as any;
    if (existing) return this.fail(400, "USER_BUSINESS_ERROR", "Batch with given sender_batch_id already exists");
    const id = rid(13);
    const batch = {
      batch_header: {
        payout_batch_id: id,
        batch_status: "PENDING",
        time_created: now(),
        sender_batch_header: { sender_batch_id: batchId, email_subject: subject },
        amount: { currency: items[0]?.currency ?? "USD", value: r2(items.reduce((s, i) => s + Number(i.value), 0)) },
      },
      items: items.map((i) => ({
        payout_item_id: rid(13),
        transaction_status: "PENDING",
        payout_batch_id: id,
        payout_item: { recipient_type: "EMAIL", amount: { value: i.value, currency: i.currency }, receiver: i.email, note: i.note, sender_item_id: i.senderItemId },
      })),
    };
    this.s.batches[id] = batch;
    const t = setTimeout(() => this.settleBatch(id), this.opts.settleMs ?? 1500);
    t.unref?.();
    return this.ok(
      {
        batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: batch.batch_header.sender_batch_header },
        links: [{ href: `${this.api}/v1/payments/payouts/${id}`, rel: "self", method: "GET" }],
      },
      201,
    );
  }

  settleBatch(id: string) {
    const b = this.s.batches[id];
    if (!b || b.batch_header.batch_status !== "PENDING") return;
    b.batch_header.batch_status = "SUCCESS";
    for (const i of b.items) {
      i.transaction_status = "SUCCESS";
      i.transaction_id = rid(17);
      this.emit("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", structuredClone(i), "payouts_item", "A payout item has succeeded");
    }
    this.emit("PAYMENT.PAYOUTSBATCH.SUCCESS", structuredClone(b), "payouts", "Payouts batch completed successfully.");
  }

  settleAll() {
    for (const id of Object.keys(this.s.batches)) this.settleBatch(id);
  }

  async getPayoutBatch(id: string): Promise<CallResult> {
    const b = this.s.batches[id];
    return b ? this.ok(structuredClone(b)) : this.fail(404, "INVALID_RESOURCE_ID", "The requested resource ID was not found");
  }

  async verifyWebhook() {
    // Simulated events never reach the HTTP endpoint; they are handed to the
    // handler in-process. Anything arriving over HTTP in fixture mode fails.
    return "FAILURE" as const;
  }
}
