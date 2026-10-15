import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../server/ai/agent.ts";
import { Gemini, type GenerateRequest, type GenerateResult } from "../server/ai/gemini.ts";
import { FixturePayPal } from "../server/paypal/fixtures.ts";
import { Bus, Store } from "../server/store.ts";
import { Treasury } from "../server/treasury.ts";
import { byName, fakeCapture, sampleEvent } from "./helpers.ts";

/** A model that follows a script, to test what the mandate does with bad calls. */
class ScriptedModel extends Gemini {
  seen: GenerateRequest[] = [];
  private script: GenerateResult[];
  constructor(script: GenerateResult[]) {
    super({ apiKey: "test", model: "scripted", fallbackModels: [] });
    this.script = script;
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.seen.push(structuredClone(req));
    const next = this.script.shift()!;
    return { ...next, content: { role: "model", parts: next.calls.map((c) => ({ functionCall: c })) .concat(next.text ? [{ text: next.text } as any] : []) } };
  }
}

const call = (name: string, args: Record<string, unknown>): GenerateResult => ({ ok: true, model: "scripted", calls: [{ name, args }] });

test("the mandate stops a model that tries to misdirect money", async () => {
  const store = new Store();
  const bus = new Bus();
  let treasury!: Treasury;
  const pp = new FixturePayPal({ publicBase: "http://x", onWebhook: (e) => treasury.handleWebhook(e, "fixture").then(() => undefined), settleMs: 5 });
  treasury = new Treasury(store, pp, bus, "http://x");
  const ev = sampleEvent();
  store.data.events.push(ev);
  const priya = byName(ev, "Priya").id;
  const model = new ScriptedModel([
    call("create_payout", { email: "refund-desk@attacker.example", amount: "500.00", currency: "USD", note: "urgent" }),
    call("create_order", { participant_id: priya, currencyCode: "USD", items: [{ name: "Share", itemCost: 999, itemTotal: 999 }] }),
    call("create_order", { participant_id: priya, currencyCode: "USD", items: [{ name: "Share", itemCost: 276.5, itemTotal: 276.5 }] }),
    call("create_payout", { email: "maya@example.com", amount: "1248.50", currency: "USD", note: "Cabin" }),
    { ok: true, model: "scripted", calls: [], text: "Requested Priya's share; Maya's reimbursement waits for approval." },
  ]);
  const agent = new Agent(model, treasury, bus);
  const r = await agent.run(ev, "Settle up");
  assert.equal(r.by, "model");
  const results = r.trace.filter((s) => s.kind === "result").map((s) => s.outcome!);
  assert.deepEqual(results.map((o) => o.verdict), ["deny", "deny", "allow", "deny"]);
  assert.match(results[0].summary, /not a participant, a listed vendor or a trusted payee/);
  assert.match(results[1].summary, /owes \$276\.50/);
  assert.equal(ev.payouts.length, 0, "no money left the pot");
  assert.equal(ev.orders.length, 1);
  assert.match(results[3].summary, /waits until the money is collected/);
  // The denial reason went back to the model so it could correct itself.
  const fr = JSON.stringify(model.seen[1].contents.at(-1));
  assert.match(fr, /DENIED by the mandate/);
  // Return URLs are pinned by Purser, not by the model.
  assert.match(ev.orders[0].approveUrl!, /sandbox-sim\/checkout/);
});

test("a pending approval expires when the ledger moves under it", async () => {
  const store = new Store();
  const bus = new Bus();
  const pp = new FixturePayPal({ publicBase: "http://x", onWebhook: () => undefined });
  const treasury = new Treasury(store, pp, bus, "http://x");
  const ev = sampleEvent();
  store.data.events.push(ev);
  fakeCapture(ev, "Priya", 27650);
  ev.mandate.maxPayoutCents = 5000; // so Jonah's $80.50 needs a human
  const out = await treasury.run(ev, "create_payout", { email: "jonah@example.com", amount: "80.50", currency: "USD", note: "Groceries" }, "agent");
  assert.equal(out.verdict, "approval");
  // The groceries Jonah fronted are taken off the budget: the pot no longer owes him anything.
  ev.items = ev.items.filter((i) => i.paidById !== byName(ev, "Jonah").id);
  treasury.touch(ev);
  assert.equal(ev.approvals[0].status, "expired");
});
