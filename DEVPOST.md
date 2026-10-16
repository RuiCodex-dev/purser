# Devpost submission: Purser

Paste-ready text for https://paypalaihackathon.devpost.com/ ("Enter a submission").
All links are live.

- **Project name:** Purser
- **Tagline (max ~60 chars):** The AI treasurer for group trips, with a mandate it can't break
- **Built by:** Rui Codex (solo)
- **Repository:** https://github.com/RuiCodex-dev/purser (public, MIT)
- **Demo video:** https://youtu.be/3e2EhTpMcA0 (public, 2:23, English captions)
- **Hosted demo:** https://purser.ruicodex.com (no-keys mode: offline fixtures of the sandbox contracts, reset nightly)
- **Try it out links:** https://purser.ruicodex.com, https://github.com/RuiCodex-dev/purser
- **Built with (tags):** paypal, paypal-agent-toolkit, paypal-orders, paypal-payouts,
  paypal-invoicing, paypal-webhooks, gemini, ag-grid, react, typescript, node.js

---

## Inspiration

Every group trip has a treasurer, and it is always the same person. They put the cabin
deposit on their own card, then spend three weeks chasing eight friends for $276.50 each,
pay the boat rental, work out what the person who dropped out gets back, and keep a
spreadsheet nobody else trusts. Split-the-bill apps tell you who owes whom. Nothing actually
collects the money, pays it back out and handles the awkward cases.

That job is a perfect fit for an agent - except for one thing: nobody hands an AI the keys
to a pot of their friends' money. So we built the treasurer around that problem first.

## What it does

The organizer writes the trip the way they would in the group chat. Purser turns it into a
ledger (people, costs, who fronted what, vendors, sponsors, optional extras), then a
treasurer agent moves the money through PayPal:

- **Collects** each person's exact share with a PayPal order and a personal pay link,
  captured when they approve and confirmed by webhooks.
- **Invoices sponsors** (PayPal Invoicing) and reminds them.
- **Pays back** whoever fronted costs and **pays vendors** with PayPal Payouts.
- **Refunds drop-outs** on the capture they paid with - only the refundable part of their
  share; the non-refundable cabin stays theirs, and everyone else is re-asked for the
  difference.

What makes it trustworthy is **the mandate**. Every money-moving tool call the agent makes
is checked in plain code against the ledger before it reaches PayPal:

- an order must equal exactly what the ledger says that person owes, to the cent;
- money only goes to people and vendors the ledger owes, never more than they are owed;
- money never leaves the pot before it has arrived;
- payouts above a limit, large refunds and vendor payments wait in an approval inbox;
- the model cannot choose where payers are redirected.

When the model gets something wrong, the call is denied and the reason ("the ledger says
Priya owes $276.50, not $999") goes back to the model so it can correct itself. In our
tests a scripted rogue model tries to pay an attacker's email, overcharge a guest and pay
out money not yet collected: all three are stopped and nothing moves.

The organizer sees everything in an AG Grid ledger they can **question in plain English**
("who still owes more than $250, largest first" becomes a grid filter and sort), a grid of
every PayPal object (orders, captures, refunds, payouts, invoices with their real ids), and
a full audit log with the mandate's verdict and PayPal debug ids. Receipts can be added
from a photo, and Purser drafts friendly reminders that never lose the amount or the link.

## How we built it

- **PayPal:** the official **PayPal Agent Toolkit** (`@paypal/agent-toolkit` 1.11.0) supplies
  both the tool definitions the agent sees and the execution of `create_order`,
  `get_order`, `create_invoice`, `send_invoice`, `send_invoice_reminder`,
  `create_refund` and `list_transactions` in the sandbox. Purser adds what the toolkit does
  not cover: **Payouts v1**, idempotent **Orders v2 capture** (PayPal-Request-Id), and
  **webhook signature verification** (`verify-webhook-signature`), plus a pull-based
  reconcile.
- **AI:** Gemini (3.5 Flash, falling back to 3.1 Flash Lite) over the REST API with function
  calling. The toolkit's JSON Schemas are converted to Gemini function declarations at
  runtime. Gemini also reads briefs into a typed budget (JSON schema output, with a
  grounding check: every name must appear in the brief), reads receipt photos, turns
  questions into AG Grid filter models and drafts reminders.
- **Ledger engine:** integer cents, exact splits, a deterministic planner that knows what
  money still has to move. It is the ground truth the mandate checks against, and when no
  model key is configured it is also the treasurer, run through the same mandate.
- **App:** Node 22 (TypeScript run directly), React, **AG Grid Community** for the ledger,
  PayPal objects, costs and activity grids, Server-Sent Events for live updates.
- **Offline mode:** a fixture adapter replays the documented sandbox contracts (including
  the toolkit's USD-only order schema and webhook payloads), so the whole app runs and is
  tested with no credentials, and switches to the live sandbox when they are set.

## Challenges we ran into

- **Letting an agent near money.** Our first version let the organizer approve a payout
  larger than the pot held. We made "never spend money that has not arrived" a hard rule
  that approval cannot override, and let the planner hold such payouts as "waiting for
  money" instead.
- **Model hallucinations in structured output.** A model once returned a vendor name with
  stray characters glued to an email. Every name in a model-read brief must now appear in
  the brief itself, or the strict parser takes over.
- **Exactly-once capture.** The return URL, the webhook and the reconcile job can all try to
  capture the same order. A per-order lock plus PayPal-Request-Id makes it happen once.
- **The unhappy paths.** Deep testing against the live sandbox found real gaps, all fixed:
  a double click could pay the same reimbursement twice (money moves are now serialised per
  event and the mandate is re-evaluated under the lock); a card declined at capture
  (`INSTRUMENT_DECLINED`, whose code PayPal puts in `details[].issue`, not in the message)
  left the payer stuck (they now go back to PayPal's approval page for the same order); a
  payer approving an older, replaced request could have been charged the old amount (a
  superseded approval is now never captured); a network failure or an expired OAuth token
  surfaced as a server error (now an audited failure, and a single token refresh with the
  same PayPal-Request-Id).
- **Drop-out maths.** A person who leaves keeps their share of non-refundable costs, loses
  the sponsor credit, is refunded the rest on the original capture, and everybody else is
  re-asked for the difference - and it all has to add up to the cent.

## Accomplishments that we're proud of

- An agent that can actually move money, with a guarantee that fits in one sentence: it can
  only ever do what the ledger already says is owed.
- 25 offline tests (full flow over HTTP, the rogue model, double submits, a declined card,
  a replaced request, network failure, token expiry) plus a 28-check live end-to-end run
  against the PayPal sandbox and Gemini (`scripts/live-e2e.ts`, evidence in
  `docs/sandbox-evidence/`). The conservation invariant (what people owe plus sponsor money
  equals every unpaid cost) holds exactly.
- It runs end to end with zero keys, which makes it easy to judge and to try.

## What we learned

The interesting part of agentic commerce is not getting a model to call a payments API; it
is deciding what the model is *allowed* to do, and making that decision in code a human can
read. A ledger is the natural contract between the person and the agent.

## What's next for Purser

Recurring kitties (sports teams, shared flats) with PayPal Subscriptions, Venmo for US
groups, multi-currency trips, a group-chat bot front end, and per-participant consent for
payouts sent to them.

## AI tools used (required field)

- **PayPal Agent Toolkit** - tool definitions and sandbox execution for orders, invoices,
  refunds and transactions.
- **Google Gemini API** (gemini-3.5-flash / gemini-3.1-flash-lite) - the treasurer agent
  (function calling), brief reading (JSON schema), receipt reading (vision), natural-language
  grid filters, reminder drafting.
- **Google Flow (Nano Banana Pro)** - the risograph-style illustrations (no product UI is
  generated; all UI in screenshots and video is the running app).
- **Claude Code** - AI pair-programming assistant used while writing and testing the code.

## Testing instructions (for judges)

```sh
git clone https://github.com/RuiCodex-dev/purser && cd purser
npm ci && npm run build && npm start     # Node 22.18+
```

Open http://localhost:8790 > New event > Skip to the demo event > Run the treasurer. Open a
person's pay link from the ledger (link icon), pay, approve in the checkout simulator, and
watch the ledger update. With `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` (sandbox) and
`GEMINI_API_KEY` in `.env`, the same flow runs against the real PayPal sandbox and Gemini.
`npm test` runs the suite offline (25 tests). With sandbox credentials,
`node scripts/live-e2e.ts` runs 28 live checks against the PayPal sandbox and Gemini.

## Sponsor tools

- **AG Grid** (Community, MIT): the ledger grid with live cell-flash updates from PayPal
  webhooks, pinned totals, custom renderers, and a natural-language question bar that sets
  AG Grid filter and sort models; the PayPal objects grid; the costs and activity grids with
  quick filter.
