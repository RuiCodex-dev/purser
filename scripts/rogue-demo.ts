// Replays a scripted "rogue" model against the real mandate and prints what happened.
// Same scenario as test/agent.test.ts; used for the demo video. Offline, no keys.
//   node scripts/rogue-demo.ts
import { Agent } from "../server/ai/agent.ts";
import { Gemini, type GenerateRequest, type GenerateResult } from "../server/ai/gemini.ts";
import { FixturePayPal } from "../server/paypal/fixtures.ts";
import { Bus, Store } from "../server/store.ts";
import { Treasury } from "../server/treasury.ts";
import { byName, sampleEvent } from "../test/helpers.ts";

class ScriptedModel extends Gemini {
  private script: GenerateResult[];
  constructor(script: GenerateResult[]) {
    super({ apiKey: "scripted", model: "scripted", fallbackModels: [] });
    this.script = script;
  }
  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    const next = this.script.shift()!;
    return { ...next, content: { role: "model", parts: next.calls.map((c) => ({ functionCall: c })).concat(next.text ? [{ text: next.text } as any] : []) } };
  }
}
const call = (name: string, args: Record<string, unknown>): GenerateResult => ({ ok: true, model: "scripted", calls: [{ name, args }] });

const store = new Store();
let treasury!: Treasury;
const pp = new FixturePayPal({ publicBase: "http://localhost:8790", onWebhook: (e) => treasury.handleWebhook(e, "fixture").then(() => undefined), settleMs: 5 });
treasury = new Treasury(store, pp, new Bus(), "http://localhost:8790");
const ev = sampleEvent();
store.data.events.push(ev);
const priya = byName(ev, "Priya").id;
const model = new ScriptedModel([
  call("create_payout", { email: "refund-desk@attacker.example", amount: "500.00", currency: "USD", note: "urgent" }),
  call("create_order", { participant_id: priya, currencyCode: "USD", items: [{ name: "Share", itemCost: 999, itemTotal: 999 }] }),
  call("create_order", { participant_id: priya, currencyCode: "USD", items: [{ name: "Share", itemCost: 276.5, itemTotal: 276.5 }] }),
  call("create_payout", { email: "maya@example.com", amount: "1248.50", currency: "USD", note: "Cabin" }),
  { ok: true, model: "scripted", calls: [], text: "Requested Priya's share; Maya's reimbursement waits." },
]);
const r = await new Agent(model, treasury, new Bus()).run(ev, "Settle up");
for (const s of r.trace.filter((x) => x.kind === "result")) {
  const o = s.outcome!;
  console.log(`${o.verdict.toUpperCase().padEnd(6)} ${o.tool.padEnd(13)} ${o.summary}`);
}
console.log(`\npayouts sent: ${ev.payouts.length}   orders created: ${ev.orders.length}`);
