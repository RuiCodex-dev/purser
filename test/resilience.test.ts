import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type App } from "../server/app.ts";
import { loadConfig } from "../server/config.ts";
import { FixturePayPal } from "../server/paypal/fixtures.ts";
import { LivePayPal } from "../server/paypal/live.ts";
import { Bus, Store } from "../server/store.ts";
import { Treasury } from "../server/treasury.ts";
import { byName, fakeCapture, sampleEvent } from "./helpers.ts";

// Failure paths: double submits, declined payments, replaced requests, network
// errors and expired access tokens. All offline.

async function start(): Promise<{ app: App; base: string }> {
  const cfg = loadConfig(process.cwd(), {
    PURSER_DATA_DIR: "memory",
    PURSER_PAYPAL_MODE: "fixtures",
    PURSER_FIXTURE_SETTLE_MS: "10",
    PORT: "0",
  } as NodeJS.ProcessEnv);
  const app = createApp(cfg, { webRoot: "does-not-exist" });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  (app.treasury as any).publicBase = base;
  (app.pp as any).opts.publicBase = base;
  return { app, base };
}

const get = (base: string, path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });
const form = (base: string, path: string, body: string) =>
  get(base, path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pathOf = (u: string) => {
  const x = new URL(u);
  return x.pathname + x.search;
};

function treasuryWith(pp: FixturePayPal | any) {
  const store = new Store();
  const bus = new Bus();
  const ev = sampleEvent();
  store.data.events.push(ev);
  return { store, ev, treasury: new Treasury(store, pp, bus, "http://x") };
}

test("double submit: two identical payouts at once move money once", async () => {
  let treasury!: Treasury;
  const pp = new FixturePayPal({ publicBase: "http://x", onWebhook: (e) => treasury.handleWebhook(e, "fixture").then(() => undefined), settleMs: 5 });
  // Slow PayPal down so both calls are in flight together.
  const real = pp.createPayout.bind(pp);
  let calls = 0;
  (pp as any).createPayout = async (...a: Parameters<typeof real>) => {
    calls++;
    await sleep(40);
    return real(...a);
  };
  const t = treasuryWith(pp);
  treasury = t.treasury;
  const ev = t.ev;
  for (const n of ["Priya", "Sam", "Theo", "Kofi"]) fakeCapture(ev, n, 27650);
  const jonah = byName(ev, "Jonah");
  const args = { email: jonah.email, amount: "80.50", currency: "USD", note: "Groceries" };
  const [a, b] = await Promise.all([treasury.run(ev, "create_payout", args, "agent"), treasury.run(ev, "create_payout", args, "organizer")]);
  assert.equal(calls, 1, "PayPal was asked once");
  assert.equal(ev.payouts.length, 1);
  assert.deepEqual([a.verdict, b.verdict].sort(), ["allow", "deny"]);
  assert.match((a.verdict === "deny" ? a : b).reasons.join(" "), /not a participant|owes|owed/i);
});

test("network error: nothing is recorded, the failure is audited, a retry succeeds", async () => {
  let treasury!: Treasury;
  const pp = new FixturePayPal({ publicBase: "http://x", onWebhook: (e) => treasury.handleWebhook(e, "fixture").then(() => undefined), settleMs: 5 });
  const real = pp.createPayout.bind(pp);
  let fail = true;
  (pp as any).createPayout = async (...a: Parameters<typeof real>) => {
    if (fail) throw new TypeError("fetch failed");
    return real(...a);
  };
  const t = treasuryWith(pp);
  treasury = t.treasury;
  const ev = t.ev;
  for (const n of ["Priya", "Sam", "Theo", "Kofi"]) fakeCapture(ev, n, 27650);
  const args = { email: byName(ev, "Jonah").email, amount: "80.50", currency: "USD", note: "Groceries" };
  const out = await treasury.run(ev, "create_payout", args, "agent");
  assert.equal(out.executed, true);
  assert.equal(out.ok, false);
  assert.match(out.error!, /Could not reach PayPal/);
  assert.equal(ev.payouts.length, 0, "a failed call never touches the ledger");
  assert.ok(ev.audit.some((x) => /create_payout failed: Could not reach PayPal/.test(x.detail)));
  fail = false;
  const again = await treasury.run(ev, "create_payout", args, "agent");
  assert.equal(again.ok, true);
  assert.equal(ev.payouts.length, 1);
});

test("double submit on a pay link: one order, both clicks go to the same PayPal page", async () => {
  const { app, base } = await start();
  try {
    const v = await (await get(base, "/api/demo", { method: "POST" })).json();
    const priya = v.event.participants.find((p: any) => p.name === "Priya");
    const link = new URL(v.payLinks[priya.id]).pathname;
    const [a, b] = await Promise.all([form(base, link, ""), form(base, link, "")]);
    assert.equal(a.status, 303);
    assert.equal(b.status, 303);
    assert.equal(a.headers.get("location"), b.headers.get("location"));
    assert.match(a.headers.get("location")!, /sandbox-sim\/checkout\?token=/);
    const ev = app.store.event(v.event.id)!;
    assert.equal(ev.orders.filter((o) => o.participantId === priya.id).length, 1);
  } finally {
    await app.close();
  }
});

test("declined payment: nothing captured, the payer is sent back to PayPal and can pay with another method", async () => {
  const { app, base } = await start();
  try {
    const v = await (await get(base, "/api/demo", { method: "POST" })).json();
    const sam = v.event.participants.find((p: any) => p.name === "Sam");
    const link = new URL(v.payLinks[sam.id]).pathname;
    const go = await form(base, link, "");
    const checkout = go.headers.get("location")!;
    const order = new URL(checkout).searchParams.get("token")!;
    // Approve with an instrument the processor declines at capture.
    const declined = await form(base, "/sandbox-sim/checkout", `token=${order}&action=decline`);
    const back = await get(base, pathOf(declined.headers.get("location")!));
    assert.equal(back.status, 303);
    assert.match(decodeURIComponent(back.headers.get("location")!), /declined that payment method and nothing was charged/);
    await sleep(30);
    const ev = app.store.event(v.event.id)!;
    let o = ev.orders.find((x) => x.id === order)!;
    assert.equal(o.capturedCents, 0);
    assert.ok(o.declinedAt);
    // Reconcile must not keep hammering a declined approval.
    await get(base, `/api/events/${ev.id}/reconcile`, { method: "POST" });
    assert.equal(ev.orders.find((x) => x.id === order)!.capturedCents, 0);
    // Pay again: same order, same approval page (no second order).
    const retry = await form(base, link, "");
    assert.equal(retry.headers.get("location"), checkout);
    const page = await (await get(base, pathOf(checkout))).text();
    assert.match(page, /Approve as sandbox buyer/);
    const ok = await form(base, "/sandbox-sim/checkout", `token=${order}&action=approve`);
    const done = await get(base, pathOf(ok.headers.get("location")!));
    assert.match(done.headers.get("location")!, /done=1/);
    await sleep(30);
    o = ev.orders.find((x) => x.id === order)!;
    assert.equal(o.status, "COMPLETED");
    assert.equal(o.capturedCents, 27650);
    assert.equal(ev.orders.filter((x) => x.participantId === sam.id).length, 1);
    assert.ok(ev.audit.some((x) => x.action === "Payment declined"));
  } finally {
    await app.close();
  }
});

test("a replaced request is never captured, even if the payer approves the old one", async () => {
  const { app, base } = await start();
  try {
    let v = await (await get(base, "/api/demo", { method: "POST" })).json();
    const id = v.event.id;
    const theo = v.event.participants.find((p: any) => p.name === "Theo");
    const kofi = v.event.participants.find((p: any) => p.name === "Kofi");
    const link = new URL(v.payLinks[theo.id]).pathname;
    const first = (await form(base, link, "")).headers.get("location")!;
    const oldOrder = new URL(first).searchParams.get("token")!;
    // Kofi drops out: Theo's share changes and the treasurer asks him again.
    await get(base, `/api/events/${id}/participants/${kofi.id}/drop`, { method: "POST" });
    await get(base, `/api/events/${id}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruction: "Settle up" }) });
    const ev = app.store.event(id)!;
    assert.equal(ev.orders.find((o) => o.id === oldOrder)!.status, "SUPERSEDED");
    // Theo still had the old PayPal page open and approves it.
    const ap = await form(base, "/sandbox-sim/checkout", `token=${oldOrder}&action=approve`);
    const back = await get(base, pathOf(ap.headers.get("location")!));
    assert.match(decodeURIComponent(back.headers.get("location")!), /replaced by one for the current amount/);
    await sleep(40);
    const old = ev.orders.find((o) => o.id === oldOrder)!;
    assert.equal(old.capturedCents, 0, "superseded order not captured");
    assert.equal(old.status, "SUPERSEDED");
    assert.ok(ev.audit.some((x) => x.action === "Ignored approval of a replaced request"));
    v = await (await get(base, `/api/events/${id}`)).json();
    assert.ok(v.ledger.rows.find((r: any) => r.name === "Theo").positionCents > 0, "Theo still owes the current amount");
  } finally {
    await app.close();
  }
});

test("live adapter: an expired access token is refreshed once; an unreachable PayPal is reported, not thrown", async () => {
  let tokens = 0;
  let calls = 0;
  const seen: (string | undefined)[] = [];
  const mock = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/v1/oauth2/token") {
        tokens++;
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ access_token: `T${tokens}`, expires_in: 32400 }));
      }
      calls++;
      seen.push(req.headers["paypal-request-id"] as string | undefined);
      if (req.headers.authorization === "Bearer T1") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_token", error_description: "Access Token not found in cache" }));
      }
      res.writeHead(200, { "Content-Type": "application/json", "paypal-debug-id": "dbg1" });
      res.end(JSON.stringify({ id: "ORDER1", status: "APPROVED" }));
    });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
  try {
    const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    const pp = new LivePayPal({ clientId: "id", clientSecret: "secret", base, timeoutMs: 2000 });
    const r = await pp.captureOrder("ORDER1", "capture-ORDER1");
    assert.equal(r.ok, true);
    assert.equal(r.debugId, "dbg1");
    assert.equal(tokens, 2, "token fetched again after the 401");
    assert.equal(calls, 2, "request retried exactly once");
    assert.deepEqual(seen, ["capture-ORDER1", "capture-ORDER1"], "the retry keeps the same PayPal-Request-Id");
  } finally {
    await new Promise<void>((r) => mock.close(() => r()));
  }

  // Unreachable PayPal: the treasury turns the thrown error into a recorded failure.
  const dead = new LivePayPal({ clientId: "id", clientSecret: "secret", base: "http://127.0.0.1:9", timeoutMs: 1500 });
  const t = treasuryWith(dead);
  for (const n of ["Priya", "Sam", "Theo", "Kofi"]) fakeCapture(t.ev, n, 27650);
  const out = await t.treasury.run(t.ev, "create_payout", { email: byName(t.ev, "Jonah").email, amount: "80.50", currency: "USD" }, "agent");
  assert.equal(out.ok, false);
  assert.match(out.error!, /Could not reach PayPal/);
  assert.equal(t.ev.payouts.length, 0);
});
