// Runs the treasurer once on the sample event and prints the trace.
// Uses whatever is configured: Gemini if GEMINI_API_KEY is set, the PayPal
// sandbox if PAYPAL_CLIENT_ID/SECRET are set, otherwise the offline fixtures.
import { createApp } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { parseBrief, SAMPLE_BRIEF } from "../server/ai/brief.ts";
import { buildEvent } from "../server/domain/build.ts";
import { computeLedger } from "../server/domain/ledger.ts";
import { format } from "../server/domain/money.ts";

const cfg = { ...loadConfig(), dataDir: undefined };
const app = createApp(cfg);
const t0 = Date.now();
const parsed = await parseBrief(SAMPLE_BRIEF, app.llm);
console.log(`brief parsed by ${parsed.by}${parsed.model ? ` (${parsed.model})` : ""}${parsed.note ? ` - ${parsed.note}` : ""}; issues: ${parsed.issues.length}`);
const ev = buildEvent(parsed.draft, SAMPLE_BRIEF);
app.store.data.events.push(ev);
const r = await app.agent.run(ev, process.argv[2] ?? "Settle up: request what people owe, invoice the sponsor, and return money owed.");
for (const s of r.trace) {
  if (s.kind === "result") console.log(`  ${s.outcome!.verdict.padEnd(8)} ${s.tool}: ${s.text.slice(0, 150)}`);
  else if (s.kind !== "call") console.log(`- ${s.kind}: ${s.text.slice(0, 200)}`);
}
const l = computeLedger(ev);
console.log(`orders ${ev.orders.length}, invoices ${ev.invoices.map((i) => i.status).join(",")}, approvals pending ${ev.approvals.filter((a) => a.status === "pending").length}, outstanding ${format(l.totals.outstandingCents, ev.currency)}`);
console.log(`by ${r.by}${r.model ? ` (${r.model})` : ""} in ${((Date.now() - t0) / 1000).toFixed(1)} s; PayPal: ${app.pp.describe().mode}`);
await app.close();
