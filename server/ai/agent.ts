import { createRequire } from "node:module";
import { computeLedger } from "../domain/ledger.ts";
import { format, toDecimal } from "../domain/money.ts";
import { describeIntent, plan } from "../domain/planner.ts";
import type { PurserEvent } from "../domain/types.ts";
import { TOOLKIT_ACTIONS } from "../paypal/live.ts";
import type { Bus } from "../store.ts";
import type { Outcome, Treasury } from "../treasury.ts";
import { toGeminiSchema, type Content, type FunctionDecl, type Gemini } from "./gemini.ts";

const require = createRequire(import.meta.url);
const { PayPalAgentToolkit } = require("@paypal/agent-toolkit/openai");

export interface TraceStep {
  at: string;
  kind: "start" | "thought" | "call" | "result" | "note" | "fallback" | "done";
  text: string;
  tool?: string;
  args?: Record<string, unknown>;
  outcome?: Omit<Outcome, "summary"> & { summary: string };
}

/**
 * The tools the model sees: the Agent Toolkit's own definitions for the
 * actions Purser enables, plus two of Purser's (Payouts are not in the
 * toolkit, and the ledger is Purser's). Schemas come from the toolkit at
 * runtime, so they track the installed version.
 */
export function agentTools(): FunctionDecl[] {
  const tk = new PayPalAgentToolkit({ clientId: "schema-only", clientSecret: "schema-only", configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true } } });
  const wanted = new Set(["create_order", "get_order", "create_refund", "get_refund", "create_invoice", "send_invoice", "send_invoice_reminder", "list_transactions"]);
  const tools: FunctionDecl[] = [];
  for (const t of tk.getTools() as any[]) {
    const f = t.function;
    if (!wanted.has(f.name)) continue;
    const params = toGeminiSchema(structuredClone(f.parameters));
    let description = String(f.description).trim().slice(0, 900);
    if (f.name === "create_order") {
      params.properties.participant_id = { type: "string", description: "Purser participant id (p1, p2, ...) this order collects from. Required by Purser." };
      params.required = [...(params.required ?? []), "participant_id"];
      delete params.properties.returnUrl;
      delete params.properties.cancelUrl;
      delete params.properties.shippingAddress;
      description += "\nPurser sets the return and cancel URLs itself.";
    }
    tools.push({ name: f.name, description: `[PayPal Agent Toolkit] ${description}`, parameters: params });
  }
  tools.push({
    name: "create_payout",
    description:
      "[Purser, PayPal Payouts v1] Send money from the event pot to one email address: a participant who is owed a reimbursement, or a vendor listed on a cost item.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string" },
        amount: { type: "string", description: "Decimal string, e.g. '80.50'" },
        currency: { type: "string" },
        note: { type: "string", description: "Short note shown to the recipient" },
      },
      required: ["email", "amount", "currency", "note"],
    },
  });
  tools.push({
    name: "get_ledger",
    description: "[Purser] Fresh ledger: every participant's share, payments, refunds, payouts and position, plus what the ledger engine says still has to move.",
    parameters: { type: "object", properties: {} },
  });
  return tools;
}

export function ledgerSnapshot(ev: PurserEvent, t: Treasury) {
  const l = computeLedger(ev);
  const fmt = (c: number) => format(c, ev.currency);
  return {
    event: { id: ev.id, name: ev.name, dates: ev.dateLabel, currency: ev.currency, collectBy: ev.collectBy },
    mandate: {
      maxPayout: fmt(ev.mandate.maxPayoutCents),
      maxRefund: fmt(ev.mandate.maxRefundCents),
      vendorPayoutsNeedApproval: !ev.mandate.autoPayVendors,
      payoutsLimitedToMoneyCollected: ev.mandate.floatCents === 0,
    },
    pot: { collected: fmt(l.totals.collectedCents), refunded: fmt(l.totals.refundedCents), paidOut: fmt(l.totals.paidOutCents), balance: fmt(l.totals.potCents) },
    participants: l.rows.map((r) => ({
      id: r.participantId,
      name: r.name,
      email: r.email,
      role: r.role,
      status: r.status,
      share: toDecimal(r.shareCents),
      fronted: toDecimal(r.frontedCents),
      sponsorCredit: toDecimal(r.sponsorCreditCents),
      paid: toDecimal(r.capturedCents - r.refundedCents),
      position: toDecimal(r.positionCents),
      state: r.state,
      openOrder: r.openOrder ? { id: r.openOrder.id, amount: toDecimal(r.openOrder.amountCents), status: r.openOrder.status } : null,
      captures: ev.orders.filter((o) => o.participantId === r.participantId && o.captureId).map((o) => ({ capture_id: o.captureId, captured: toDecimal(o.capturedCents), refunded: toDecimal(o.refundedCents) })),
    })),
    vendors: l.vendors.map((v) => ({ name: v.vendor.name, email: v.vendor.email, for: v.label, due: toDecimal(v.dueCents) })),
    sponsors: ev.sponsors.map((s) => ({ id: s.id, name: s.name, email: s.email, pledged: toDecimal(s.amountCents), invoices: ev.invoices.filter((i) => i.sponsorId === s.id).map((i) => ({ id: i.id, status: i.status, reminders: i.reminders })) })),
    pendingApprovals: ev.approvals.filter((a) => a.status === "pending").map((a) => ({ id: a.id, subject: a.subject, amount: toDecimal(a.amountCents) })),
    ledgerEngineSuggests: plan(ev, { includeReminders: true }, l).map((i) => {
      const c = t.toolCallFor(ev, i);
      return { what: describeIntent(ev, i), tool: c.name, args: c.args };
    }),
  };
}

const SYSTEM = `You are Purser, the treasurer agent for one group event. You move real (sandbox) money through PayPal tools.

How you work:
- The ledger engine does the arithmetic. Use get_ledger and its "ledgerEngineSuggests" list; never compute shares yourself and never invent people, amounts, emails or ids.
- Every money tool is checked by the organizer's mandate against the ledger before it reaches PayPal. A result starting with DENIED explains why: correct the call using the ledger, or skip it. QUEUED means the organizer must approve it; do not retry it.
- create_order always needs participant_id. Use one line item per share line, with the credits as the discount, exactly as suggested.
- Prefer returning money on the rail it came in on: refund a capture before paying out.
- Write any note_to_payer or invoice note in a warm, plain sentence. No emoji.
- Do the work in as few calls as possible, then stop calling tools.

When you are done, reply with a short note for the group chat (3 sentences at most): what was requested, what is waiting for the organizer, and what happens next. Plain text.`;

export class Agent {
  private llm: Gemini;
  private treasury: Treasury;
  private bus: Bus;
  constructor(llm: Gemini, treasury: Treasury, bus: Bus) {
    this.llm = llm;
    this.treasury = treasury;
    this.bus = bus;
  }

  private emit(ev: PurserEvent, trace: TraceStep[], step: Omit<TraceStep, "at">) {
    const s = { at: new Date().toISOString(), ...step };
    trace.push(s);
    this.bus.emit({ type: "trace", eventId: ev.id, step: s });
  }

  async run(ev: PurserEvent, instruction: string): Promise<{ trace: TraceStep[]; note: string; by: "model" | "engine"; model?: string }> {
    const trace: TraceStep[] = [];
    this.emit(ev, trace, { kind: "start", text: instruction });
    if (this.llm.available) {
      const r = await this.runModel(ev, instruction, trace);
      if (r) return r;
      this.emit(ev, trace, { kind: "fallback", text: "The model did not finish; the ledger engine completes the run through the same mandate." });
    } else {
      this.emit(ev, trace, { kind: "fallback", text: "No model key configured: the deterministic treasurer runs the ledger engine's plan through the mandate." });
    }
    const outs = await this.treasury.runPlan(ev, { includeReminders: /remind|nudge|chase/i.test(instruction) });
    for (const o of outs) this.emit(ev, trace, { kind: "result", tool: o.tool, text: o.summary, outcome: o });
    const note = this.templateNote(ev, outs);
    this.emit(ev, trace, { kind: "note", text: note });
    this.emit(ev, trace, { kind: "done", text: "Run finished" });
    ev.note = note;
    this.treasury.touch(ev);
    return { trace, note, by: "engine" };
  }

  private async runModel(ev: PurserEvent, instruction: string, trace: TraceStep[]) {
    const tools = agentTools();
    const contents: Content[] = [
      {
        role: "user",
        parts: [{ text: `Organizer's instruction: ${instruction}\n\nCurrent ledger (JSON):\n${JSON.stringify(ledgerSnapshot(ev, this.treasury))}` }],
      },
    ];
    let model: string | undefined;
    for (let step = 0; step < 10; step++) {
      const r = await this.llm.generate({ system: SYSTEM, contents, tools, temperature: 0.1 });
      if (!r.ok || !r.content) {
        this.emit(ev, trace, { kind: "thought", text: `Model error: ${r.error}` });
        return undefined;
      }
      model = r.model;
      contents.push(r.content);
      if (r.text && r.calls.length) this.emit(ev, trace, { kind: "thought", text: r.text.trim().slice(0, 600) });
      if (!r.calls.length) {
        const note = (r.text ?? "").trim() || "Done.";
        this.emit(ev, trace, { kind: "note", text: note });
        this.emit(ev, trace, { kind: "done", text: `Run finished (${model})` });
        ev.note = note;
        this.treasury.touch(ev);
        return { trace, note, by: "model" as const, model };
      }
      const responses: Content = { role: "user", parts: [] };
      for (const c of r.calls) {
        if (c.name === "get_ledger") {
          this.emit(ev, trace, { kind: "call", tool: c.name, text: "Read the ledger" });
          responses.parts.push({ functionResponse: { id: c.id, name: c.name, response: { ledger: ledgerSnapshot(ev, this.treasury) } } });
          continue;
        }
        this.emit(ev, trace, { kind: "call", tool: c.name, args: c.args, text: c.name });
        const o = await this.treasury.run(ev, c.name, c.args as Record<string, any>, "agent");
        this.emit(ev, trace, { kind: "result", tool: c.name, text: o.summary, outcome: o });
        responses.parts.push({ functionResponse: { id: c.id, name: c.name, response: { result: o.summary, verdict: o.verdict, paypal_id: o.paypalId ?? null } } });
      }
      contents.push(responses);
    }
    this.emit(ev, trace, { kind: "thought", text: "Step limit reached." });
    return undefined;
  }

  templateNote(ev: PurserEvent, outs: Outcome[]): string {
    const asked = outs.filter((o) => o.tool === "create_order" && o.executed && o.ok).length;
    const queued = outs.filter((o) => o.verdict === "approval").length;
    const done = outs.filter((o) => o.executed && o.ok && o.tool !== "create_order").length;
    const parts: string[] = [];
    if (asked) parts.push(`Payment requests went out to ${asked} ${asked === 1 ? "person" : "people"}; each has a personal pay link.`);
    if (done) parts.push(`${done} other PayPal action${done === 1 ? "" : "s"} went through.`);
    if (queued) parts.push(`${queued} payout${queued === 1 ? " is" : "s are"} waiting for the organizer's approval.`);
    if (!parts.length) parts.push("Nothing needed to move: the ledger is settled for now.");
    return parts.join(" ");
  }
}
