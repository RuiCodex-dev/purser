import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBriefOffline } from "../server/ai/brief.ts";
import { computeLedger } from "../server/domain/ledger.ts";
import { splitEvenly, sum, toCents, toDecimal } from "../server/domain/money.ts";
import { plan } from "../server/domain/planner.ts";
import { evaluate } from "../server/domain/policy.ts";
import { byName, fakeCapture, sampleEvent } from "./helpers.ts";

test("money: splits always add up and odd cents go to the first parts", () => {
  for (const [total, n] of [[100, 3], [1, 7], [148000, 8], [26000, 7], [-5, 2]] as const) {
    const parts = splitEvenly(total, Array.from({ length: n }, (_, i) => i));
    assert.equal(sum(parts.values()), total);
    const vals = [...parts.values()];
    assert.ok(Math.max(...vals) - Math.min(...vals) <= 1);
  }
  assert.deepEqual([...splitEvenly(100, ["a", "b", "c"]).values()], [34, 33, 33]);
  assert.equal(toCents("$1,480.50"), 148050);
  assert.equal(toDecimal(8050), "80.50");
  assert.equal(toDecimal(-5), "-0.05");
});

test("parser: reads the sample brief without guessing", () => {
  const { draft, issues } = parseBriefOffline(
    "Ski chalet, Feb 2-5. Group: Ana (organizer), Bram and Chloe.\nChalet €900, non-refundable. Ana already paid it.\nLift passes €60 each.\nSnow Co sponsors €90 (hi@snow.example).",
  );
  assert.deepEqual(issues, []);
  assert.equal(draft.currency, "EUR");
  assert.deepEqual(draft.participants.map((p) => p.name), ["Ana", "Bram", "Chloe"]);
  assert.equal(draft.items[0].paidBy, "Ana");
  assert.equal(draft.items[0].refundable, false);
  assert.equal(draft.items[1].kind, "per_head");
  assert.equal(draft.sponsors[0].email, "hi@snow.example");
});

test("ledger: sample event shares, credits and positions", () => {
  const ev = sampleEvent();
  const l = computeLedger(ev);
  const row = (n: string) => l.rows.find((r) => r.name === n)!;
  // cabin 185 + groceries 39 + kayak 45 + boat 32.50 - sponsor 25
  assert.equal(row("Priya").positionCents, 27650);
  assert.equal(row("Lena").positionCents, 23150); // no kayak
  assert.equal(row("Maya").positionCents, 25650 - 148000 - 2500);
  assert.equal(row("Jonah").state, "owed reimbursement");
  // Conservation: what participants net-owe plus the sponsor's money equals
  // every cost nobody has paid yet (the boat vendor and the kayak tour).
  const unpaidCosts = sum(ev.items.filter((i) => !i.paidById).map((i) => (i.kind === "per_head" ? i.amountCents * (i.optedIn?.length ?? 8) : i.amountCents)));
  assert.equal(sum(l.rows.map((r) => r.positionCents)) + l.totals.sponsorCents, unpaidCosts);
});

test("ledger: a drop-out keeps the non-refundable share and is refunded the rest", () => {
  const ev = sampleEvent();
  fakeCapture(ev, "Sam", 27650);
  byName(ev, "Sam").status = "dropped";
  const l = computeLedger(ev);
  const sam = l.rows.find((r) => r.name === "Sam")!;
  // Sam still carries 1/8 of the non-refundable cabin, and no sponsor credit.
  assert.equal(sam.shareCents, 18500);
  assert.equal(sam.positionCents, 18500 - 27650);
  assert.equal(sam.state, "owed refund");
  const intents = plan(ev);
  const refund = intents.find((i) => i.kind === "refund");
  assert.ok(refund && refund.kind === "refund");
  assert.equal(refund.amountCents, 27650 - 18500);
  // The others now carry Sam's part of the refundable costs.
  assert.ok(l.rows.find((r) => r.name === "Priya")!.positionCents > 27650);
});

test("planner: asks each payer once and nets out what people fronted", () => {
  const ev = sampleEvent();
  const intents = plan(ev);
  const collects = intents.filter((i) => i.kind === "collect");
  assert.equal(collects.length, 6); // Maya and Jonah fronted more than their share
  const priya = collects.find((i) => i.kind === "collect" && i.participantId === byName(ev, "Priya").id)!;
  assert.ok(priya.kind === "collect");
  assert.equal(sum(priya.lines.map((l) => l.amountCents)) - priya.discountCents, priya.amountCents);
  assert.ok(intents.some((i) => i.kind === "payout_participant" && i.amountCents === 124850));
  assert.ok(intents.some((i) => i.kind === "payout_vendor" && i.amountCents === 26000));
  assert.ok(intents.some((i) => i.kind === "invoice"));
});

test("mandate: an order must match the ledger to the cent", () => {
  const ev = sampleEvent();
  const pid = byName(ev, "Priya").id;
  const base = { tool: "create_order" as const, participantId: pid, currency: "USD", discountCents: 0 };
  assert.equal(evaluate(ev, { ...base, amountCents: 27650, itemsCents: 27650 }).verdict, "allow");
  const wrong = evaluate(ev, { ...base, amountCents: 30000, itemsCents: 30000 });
  assert.equal(wrong.verdict, "deny");
  assert.match(wrong.reasons[0], /owes \$276\.50/);
  assert.equal(evaluate(ev, { ...base, amountCents: 27650, itemsCents: 27650, currency: "EUR" }).verdict, "deny");
  assert.equal(evaluate(ev, { ...base, participantId: "p99", amountCents: 1, itemsCents: 1 }).verdict, "deny");
  assert.equal(evaluate(ev, { ...base, participantId: byName(ev, "Maya").id, amountCents: 100, itemsCents: 100 }).verdict, "deny");
});

test("mandate: payouts go only to people and vendors the ledger owes, inside the limits", () => {
  const ev = sampleEvent();
  const pay = (email: string, amountCents: number) => evaluate(ev, { tool: "create_payout", email, amountCents, currency: "USD" });
  assert.equal(pay("attacker@evil.example", 100).verdict, "deny");
  assert.equal(pay("jonah@example.com", 9000).verdict, "deny"); // ledger owes 80.50
  const jonah = pay("jonah@example.com", 8050);
  assert.equal(jonah.verdict, "approval"); // pot is empty
  assert.match(jonah.reasons.join(" "), /not yet collected/);
  fakeCapture(ev, "Priya", 27650);
  assert.equal(pay("jonah@example.com", 8050).verdict, "allow");
  const maya = pay("maya@example.com", 124850);
  assert.equal(maya.verdict, "approval");
  assert.match(maya.reasons.join(" "), /payout limit/);
  assert.equal(pay("rentals@lakeside.example", 26000).verdict, "approval"); // vendors need approval by default
  assert.equal(evaluate(ev, { tool: "create_payout", email: "maya@example.com", amountCents: 124850, currency: "USD" }, { approved: true }).verdict, "allow");
});

test("mandate: refunds are capped by the capture and by what the ledger owes", () => {
  const ev = sampleEvent();
  fakeCapture(ev, "Sam", 27650);
  byName(ev, "Sam").status = "dropped";
  const cap = ev.orders[0].captureId!;
  const refund = (cents: number) => evaluate(ev, { tool: "create_refund", captureId: cap, amountCents: cents, currency: "USD" });
  assert.equal(refund(27650).verdict, "deny"); // more than the ledger owes
  assert.equal(refund(9150).verdict, "allow");
  assert.equal(evaluate(ev, { tool: "create_refund", captureId: "NOPE1234567890123", amountCents: 1, currency: "USD" }).verdict, "deny");
});

test("mandate: invoices only to pledged sponsors for the pledged amount", () => {
  const ev = sampleEvent();
  const inv = (email: string, cents: number) => evaluate(ev, { tool: "create_invoice", email, amountCents: cents, currency: "USD" });
  assert.equal(inv("events@ridgeline.example", 20000).verdict, "allow");
  assert.equal(inv("events@ridgeline.example", 50000).verdict, "deny");
  assert.equal(inv("someone@else.example", 20000).verdict, "deny");
});
