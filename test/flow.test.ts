import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, type App } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { agentTools } from "../server/ai/agent.ts";

async function start(): Promise<{ app: App; base: string }> {
  const cfg = loadConfig(process.cwd(), {
    PURSER_DATA_DIR: "memory",
    PURSER_PAYPAL_MODE: "fixtures",
    PURSER_FIXTURE_SETTLE_MS: "10",
    PORT: "0",
  } as NodeJS.ProcessEnv);
  const app = createApp(cfg, { webRoot: "does-not-exist" });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  // Pages and PayPal return links must point at this test server.
  (app.treasury as any).publicBase = base;
  (app.pp as any).opts.publicBase = base;
  return { app, base };
}

const api = async (base: string, path: string, init: RequestInit & { json?: unknown } = {}) => {
  const res = await fetch(base + path, {
    ...init,
    headers: { "Content-Type": "application/json" },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    redirect: "manual",
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, location: res.headers.get("location") };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("end to end in fixture mode: plan, pay, capture, approve, payout, drop-out refund", async () => {
  const { app, base } = await start();
  try {
    const health = await api(base, "/api/health");
    assert.equal(health.data.paypal.mode, "fixtures");
    assert.match(health.data.paypal.toolkit, /@paypal\/agent-toolkit \d/);

    const created = await api(base, "/api/demo", { method: "POST" });
    assert.equal(created.status, 201);
    const id = created.data.event.id;

    // 1. The treasurer runs (no model key: deterministic, same mandate).
    const run = await api(base, `/api/events/${id}/agent`, { method: "POST", json: { instruction: "Settle up" } });
    assert.equal(run.status, 200);
    assert.equal(run.data.by, "engine");
    let v = run.data.view;
    assert.equal(v.event.orders.length, 6, "one order per person who owes");
    assert.ok(v.event.orders.every((o: any) => o.status === "PAYER_ACTION_REQUIRED" && o.via === "agent-toolkit"));
    assert.equal(v.event.invoices.length, 1);
    assert.equal(v.event.invoices[0].status, "SENT", "invoice created then sent in the same run");
    assert.equal(v.event.approvals.length, 0, "nothing to approve yet");
    assert.equal(v.event.payouts.length, 0, "no payout attempted: the pot is empty");

    // 2. Priya opens her pay link, approves in the simulator, comes back, gets captured.
    const priya = v.event.participants.find((p: any) => p.name === "Priya");
    const link = new URL(v.payLinks[priya.id]).pathname;
    const page = await api(base, link);
    assert.match(page.data, /Pay \$276\.50 with PayPal/);
    const go = await api(base, link, { method: "POST", body: "" });
    assert.equal(go.status, 303);
    assert.match(go.location!, /\/sandbox-sim\/checkout\?token=/);
    const order = new URL(go.location!).searchParams.get("token")!;
    const sim = await api(base, `/sandbox-sim/checkout?token=${order}`);
    assert.match(sim.data, /Offline checkout simulator/);
    const approve = await fetch(`${base}/sandbox-sim/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${order}&action=approve`,
      redirect: "manual",
    });
    assert.equal(approve.status, 303);
    const back = await api(base, new URL(approve.headers.get("location")!).pathname + new URL(approve.headers.get("location")!).search);
    assert.equal(back.status, 303);
    assert.match(back.location!, /done=1/);
    await sleep(30);
    v = (await api(base, `/api/events/${id}`)).data;
    const o = v.event.orders.find((x: any) => x.id === order);
    assert.equal(o.status, "COMPLETED");
    assert.equal(o.capturedCents, 27650);
    assert.equal(v.event.orders.filter((x: any) => x.capturedCents > 0).length, 1, "captured exactly once despite return URL + webhook");
    assert.ok(v.event.audit.some((a: any) => a.actor === "webhook" && /PAYMENT\.CAPTURE\.COMPLETED/.test(a.action)));

    // 3. Now the pot covers Jonah's $80.50 (under the limit): the treasurer pays it without asking.
    const second = await api(base, `/api/events/${id}/agent`, { method: "POST", json: { instruction: "Settle up" } });
    assert.ok(second.data.trace.some((s: any) => s.outcome?.tool === "create_payout" && s.outcome.verdict === "allow"));
    await sleep(60);
    v = (await api(base, `/api/events/${id}`)).data;
    const payout = v.event.payouts[0];
    assert.equal(payout.status, "SUCCESS", "payout settled by the PAYMENT.PAYOUTS-ITEM.SUCCEEDED webhook");
    assert.equal(v.ledger.rows.find((r: any) => r.name === "Jonah").positionCents, 0);

    // 4. Priya drops out: her refundable share comes back as a refund on her capture.
    await api(base, `/api/events/${id}/participants/${priya.id}/drop`, { method: "POST" });
    const rerun = await api(base, `/api/events/${id}/agent`, { method: "POST", json: { instruction: "Priya dropped out, settle her" } });
    v = rerun.data.view;
    const refund = v.event.refunds.find((r: any) => r.participantId === priya.id);
    assert.ok(refund, "refund issued");
    assert.equal(refund.amountCents, 27650 - 18500);
    assert.equal(v.ledger.rows.find((r: any) => r.name === "Priya").positionCents, 0);
    // Everyone else was asked again for their slightly larger share; old orders superseded.
    assert.ok(v.event.orders.some((x: any) => x.status === "SUPERSEDED"));

    // 5. The sponsor pays the invoice in the simulator; the webhook marks it paid.
    const inv = v.event.invoices[0];
    await fetch(`${base}/sandbox-sim/invoice/${inv.id}`, { method: "POST" });
    await sleep(20);
    v = (await api(base, `/api/events/${id}`)).data;
    assert.equal(v.event.invoices[0].status, "PAID");
    assert.equal(v.ledger.totals.sponsorPaidCents, 20000);

    // 6. Reconcile is idempotent once everything is in sync.
    const rec = await api(base, `/api/events/${id}/reconcile`, { method: "POST" });
    assert.equal(rec.status, 200);

    // 7. Unsigned webhooks over HTTP are refused.
    const wh = await api(base, "/api/webhooks/paypal", { method: "POST", json: { id: "WH-X", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} } });
    assert.equal(wh.status, 401);
  } finally {
    await app.close();
  }
});

test("ask the ledger works without a model", async () => {
  const { app, base } = await start();
  try {
    const id = (await api(base, "/api/demo", { method: "POST" })).data.event.id;
    const r = await api(base, `/api/events/${id}/ask`, { method: "POST", json: { question: "who still owes more than $250?" } });
    assert.deepEqual(r.data.filterModel.position, { filterType: "number", type: "greaterThan", filter: 250 });
    const n = await api(base, `/api/events/${id}/nudges`);
    assert.equal(n.data.length, 6);
    assert.match(n.data[0].message, /\/pay\//);
  } finally {
    await app.close();
  }
});

test("agent tools: toolkit schemas convert cleanly for Gemini", () => {
  const tools = agentTools();
  const names = tools.map((t) => t.name);
  for (const n of ["create_order", "create_refund", "create_invoice", "send_invoice", "send_invoice_reminder", "create_payout", "get_ledger"]) assert.ok(names.includes(n), n);
  const order = tools.find((t) => t.name === "create_order")!;
  assert.ok((order.parameters as any).required.includes("participant_id"));
  const flat = JSON.stringify(tools);
  assert.doesNotMatch(flat, /additionalProperties|\$schema|"anyOf"|"not"/);
});
