import { test } from "node:test";
import assert from "node:assert/strict";
import { groundingIssues, parseBriefOffline } from "../server/ai/brief.ts";
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

test("grounding: a model draft naming anyone not in the brief is rejected", () => {
  const text = "Trip. Group: Ana and Bo. Boat $100 from Sea Co (sea@co.example).";
  const ok = { name: "Trip", dateLabel: "", location: "", currency: "USD", participants: [{ name: "Ana" }, { name: "Bo" }], items: [{ label: "Boat", kind: "shared" as const, amount: 100, vendorName: "Sea Co", vendorEmail: "sea@co.example" }], sponsors: [] };
  assert.deepEqual(groundingIssues(ok, text), []);
  const bad = { ...ok, items: [{ ...ok.items[0], vendorName: "Sea Co假Email: sea@co.example" }], participants: [...ok.participants, { name: "Zed" }] };
  assert.equal(groundingIssues(bad, text).length, 2);
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

test("planner: payouts wait for money to arrive, people who fronted costs first", () => {
  const ev = sampleEvent();
  assert.equal(plan(ev).filter((i) => i.kind.startsWith("payout")).length, 0);
  fakeCapture(ev, "Priya", 27650);
  const p = plan(ev).filter((i) => i.kind.startsWith("payout"));
  assert.deepEqual(p.map((i) => ("amountCents" in i ? i.amountCents : 0)), [8050]); // Jonah fits; the vendor ($260) no longer does
});

test("planner: asks each payer once and nets out what people fronted", () => {
  const ev = sampleEvent();
  const intents = plan(ev);
  const collects = intents.filter((i) => i.kind === "collect");
  assert.equal(collects.length, 6); // Maya and Jonah fronted more than their share
  const priya = collects.find((i) => i.kind === "collect" && i.participantId === byName(ev, "Priya").id)!;
  assert.ok(priya.kind === "collect");
  assert.equal(sum(priya.lines.map((l) => l.amountCents)) - priya.discountCents, priya.amountCents);
  const all = plan(ev, { ignorePot: true });
  assert.ok(all.some((i) => i.kind === "payout_participant" && i.amountCents === 124850));
  assert.ok(all.some((i) => i.kind === "payout_vendor" && i.amountCents === 26000));
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
  // The pot is empty: no payout, and an approval cannot override that.
  const jonah = pay("jonah@example.com", 8050);
  assert.equal(jonah.verdict, "deny");
  assert.match(jonah.reasons.join(" "), /waits until the money is collected/);
  assert.equal(evaluate(ev, { tool: "create_payout", email: "jonah@example.com", amountCents: 8050, currency: "USD" }, { approved: true }).verdict, "deny");
  fakeCapture(ev, "Priya", 27650);
  assert.equal(pay("jonah@example.com", 8050).verdict, "allow");
  assert.equal(pay("rentals@lakeside.example", 26000).verdict, "approval"); // vendors need approval by default
  assert.equal(pay("maya@example.com", 124850).verdict, "deny"); // pot holds only $276.50
  for (const n of ["Sam", "Theo", "Kofi", "Lena", "Ines"]) fakeCapture(ev, n, 27650);
  const maya = pay("maya@example.com", 124850);
  assert.equal(maya.verdict, "approval");
  assert.match(maya.reasons.join(" "), /payout limit/);
  assert.equal(evaluate(ev, { tool: "create_payout", email: "maya@example.com", amountCents: 124850, currency: "USD" }, { approved: true }).verdict, "allow");
  // A float lets the organizer front money from the business balance on purpose.
  const ev2 = sampleEvent();
  ev2.mandate.floatCents = 10000;
  assert.equal(evaluate(ev2, { tool: "create_payout", email: "jonah@example.com", amountCents: 8050, currency: "USD" }).verdict, "allow");
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

test("grounding repair: a glued-on token is cut back to the name in the brief, inventions still fail", async () => {
  const { repairNames, groundingIssues, SAMPLE_BRIEF: brief } = await import("../server/ai/brief.ts");
  const d: any = {
    participants: [],
    items: [{ label: "Boat", kind: "shared", amount: 260, refundable: true, vendorName: "Lakeside Rentals shelterEmail rentals@lakeside.example" }],
    sponsors: [{ name: "Ridgeline Outfitters", amount: 200, email: "events@ridgeline.example" }, { name: "Theo Partners", amount: 50 }],
  };
  repairNames(d, brief);
  assert.equal(d.items[0].vendorName, "Lakeside Rentals");
  assert.equal(d.items[0].vendorEmail, "rentals@lakeside.example");
  const issues = groundingIssues(d, brief);
  assert.deepEqual(issues, ['Sponsor "Theo Partners" is not in the brief'], "an invented sponsor is never repaired into existence");
});

test("grounding repair: stray non-brief characters are cut, and the strict parser restores a dropped email", async () => {
  const { repairNames, crossFill, groundingIssues, SAMPLE_BRIEF: brief } = await import("../server/ai/brief.ts");
  const offline = parseBriefOffline(brief).draft;
  const d: any = {
    participants: [],
    items: [
      { label: "Boat", kind: "shared", amount: 260, refundable: true, vendorName: "Lakeside Rentals假装," },
      { label: "Boat 2", kind: "shared", amount: 1, refundable: true, vendorName: "Lakeside" },
    ],
    sponsors: [{ name: "Ridgeline", amount: 200 }],
  };
  repairNames(d, brief);
  crossFill(d, offline);
  assert.equal(d.items[0].vendorName, "Lakeside Rentals");
  assert.equal(d.items[1].vendorName, "Lakeside Rentals");
  assert.equal(d.items[1].vendorEmail, "rentals@lakeside.example");
  assert.equal(d.sponsors[0].name, "Ridgeline Outfitters");
  assert.equal(d.sponsors[0].email, "events@ridgeline.example");
  assert.deepEqual(groundingIssues(d, brief), []);
});

test("grounding repair: an email the model dropped is restored from the vendor's own sentence", async () => {
  const { restoreEmails } = await import("../server/ai/brief.ts");
  const text = "We owe Alpine Vans (bookings@alpinevans.example) $540 for the shuttle. Our employer Northwind chips in $300 (hr@northwind.example). Theo Cafe gets $20.";
  const d: any = {
    participants: [],
    items: [
      { label: "Shuttle", kind: "shared", amount: 540, refundable: true, vendorName: "Alpine Vans" },
      { label: "Coffee", kind: "shared", amount: 20, refundable: true, vendorName: "Theo Cafe" },
    ],
    sponsors: [{ name: "Northwind", amount: 300 }],
  };
  restoreEmails(d, text);
  assert.equal(d.items[0].vendorEmail, "bookings@alpinevans.example");
  assert.equal(d.items[1].vendorEmail, undefined, "no email in its sentence: none is borrowed from another one");
  assert.equal(d.sponsors[0].email, "hr@northwind.example");
});

test("grounding repair: refundability comes from the brief, not from the model", async () => {
  const { groundRefundability, SAMPLE_BRIEF, parseBriefOffline } = await import("../server/ai/brief.ts");
  // A live model run marked every cost non-refundable; a drop-out would then get nothing back.
  const d: any = parseBriefOffline(SAMPLE_BRIEF).draft;
  for (const i of d.items) i.refundable = false;
  assert.equal(groundRefundability(d, SAMPLE_BRIEF), 3);
  assert.deepEqual(d.items.map((i: any) => [i.label, i.refundable]), [
    ["Cabin rental", false],
    ["Groceries and firewood", true],
    ["Guided kayak tour", true],
    ["Pontoon boat", true],
  ]);
  // The reverse: a model that calls the cabin refundable is corrected too.
  for (const i of d.items) i.refundable = true;
  assert.equal(groundRefundability(d, SAMPLE_BRIEF), 1);
  assert.equal(d.items[0].refundable, false);
  // A label written differently is matched by its words; an unmentioned cost keeps its flag.
  const e: any = { items: [{ label: "boat", refundable: true }, { label: "Snacks", refundable: false }] };
  groundRefundability(e, "We rent a boat for $90, deposit is lost if we cancel.");
  assert.deepEqual(e.items.map((i: any) => i.refundable), [false, false]);
});
