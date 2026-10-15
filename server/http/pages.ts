import { computeLedger } from "../domain/ledger.ts";
import { format } from "../domain/money.ts";
import type { PurserEvent } from "../domain/types.ts";

// Server-rendered pages for people who are not the organizer: the
// participant's pay page and, in fixture mode, the offline checkout simulator.
// They share the app's tokens and fonts (see design/STYLE_GUIDE.md).

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
@font-face{font-family:"Fraunces";src:url(/fonts/fraunces-var.woff2) format("woff2");font-weight:300 800;font-display:swap}
@font-face{font-family:"IBM Plex Sans";src:url(/fonts/plex-sans-var.woff2) format("woff2");font-weight:100 700;font-display:swap}
:root{--ink:#13212E;--deck:#F3EFE6;--sheet:#FFFDF8;--rule:#DCD5C7;--fog:#56616B;--brass:#A87A2C;--brass-d:#7E5B1E;--harbor:#1E5B55;--signal:#A3372A;--sea:#E3EEEA}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--deck);color:var(--ink);font:16px/1.5 "IBM Plex Sans",system-ui,sans-serif;font-variant-numeric:tabular-nums;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:40px 16px}
.mark{font:600 12px/1 "IBM Plex Sans";letter-spacing:.24em;text-transform:uppercase;color:var(--brass-d);margin-bottom:28px;display:flex;gap:10px;align-items:center}
.mark svg{width:18px;height:18px}
.card{background:var(--sheet);border:1px solid var(--rule);border-radius:14px;max-width:520px;width:100%;padding:32px;box-shadow:0 1px 0 rgba(19,33,46,.04),0 18px 40px -24px rgba(19,33,46,.25)}
h1{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:34px;line-height:1.1;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--fog);margin:0 0 24px}
table{width:100%;border-collapse:collapse;margin:8px 0 16px}
td{padding:8px 0;border-bottom:1px dashed var(--rule)}td.n{text-align:right;white-space:nowrap}
tr.credit td{color:var(--harbor)}tr.total td{border-bottom:0;padding-top:16px;font-weight:600}
.big{font-family:Fraunces,Georgia,serif;font-size:44px;font-weight:500;letter-spacing:-.02em}
.btn{display:block;width:100%;text-align:center;border:0;border-radius:10px;padding:15px 18px;font:600 16px "IBM Plex Sans";cursor:pointer;text-decoration:none;margin-top:8px}
.btn.primary{background:var(--ink);color:var(--sheet)}.btn.primary:hover{background:#0A141D}
.btn.quiet{background:transparent;color:var(--ink);border:1px solid var(--rule)}
.btn:focus-visible{outline:3px solid var(--brass);outline-offset:3px}
.note{font-size:13px;color:var(--fog);margin-top:18px}
.banner{border-radius:10px;padding:12px 14px;margin-bottom:18px;font-size:14px}
.banner.ok{background:var(--sea);color:var(--harbor)}.banner.warn{background:#F6E7E2;color:var(--signal)}
.sim{border:1px dashed var(--brass);background:#FBF5E9}
code{font-size:13px;background:var(--deck);padding:2px 6px;border-radius:6px}
@media (prefers-reduced-motion:no-preference){.card{animation:rise .4s cubic-bezier(.2,.7,.2,1)}@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
`;

const LOGO = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7.5h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-10Z" stroke="currentColor" stroke-width="1.6"/><path d="M8 7.5V6a4 4 0 0 1 8 0v1.5" stroke="currentColor" stroke-width="1.6"/><path d="M4 11.5h16" stroke="currentColor" stroke-width="1.6"/></svg>`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="robots" content="noindex"><style>${STYLE}</style></head><body><div class="mark">${LOGO}Purser</div>${body}</body></html>`;
}

export function payPage(ev: PurserEvent, pid: string, q: URLSearchParams, mode: string): string {
  const l = computeLedger(ev);
  const row = l.rows.find((r) => r.participantId === pid)!;
  const fmt = (c: number) => format(c, ev.currency);
  const lines = row.lines.map((x) => `<tr><td>${esc(x.label)}</td><td class="n">${fmt(x.amountCents)}</td></tr>`).join("");
  const credits = [
    row.frontedCents ? `<tr class="credit"><td>You already paid out of pocket</td><td class="n">&minus;${fmt(row.frontedCents)}</td></tr>` : "",
    row.sponsorCreditCents ? `<tr class="credit"><td>Sponsor contribution, your part</td><td class="n">&minus;${fmt(row.sponsorCreditCents)}</td></tr>` : "",
    row.capturedCents - row.refundedCents ? `<tr class="credit"><td>Paid through PayPal</td><td class="n">&minus;${fmt(row.capturedCents - row.refundedCents)}</td></tr>` : "",
    row.payoutCents ? `<tr><td>Sent to you by Purser</td><td class="n">+${fmt(row.payoutCents)}</td></tr>` : "",
  ].join("");
  let banner = "";
  if (q.get("done")) banner = `<div class="banner ok" role="status">Payment received. Thank you, ${esc(row.name)}. The organizer's ledger already shows it.</div>`;
  else if (q.get("cancelled")) banner = `<div class="banner warn" role="status">Payment cancelled. Nothing was charged; you can try again below.</div>`;
  else if (q.get("error")) banner = `<div class="banner warn" role="alert">${esc(q.get("error"))}</div>`;
  let action: string;
  if (row.status === "dropped" && row.positionCents <= 0)
    action = `<p class="sub">You have left this event.${row.positionCents < 0 ? ` Purser owes you ${fmt(-row.positionCents)}; the organizer's treasurer returns it to you through PayPal.` : ""}</p>`;
  else if (row.positionCents > 0)
    action = `<form method="post" action="/pay/${esc(ev.payTokens[pid])}"><button class="btn primary" type="submit">Pay ${fmt(row.positionCents)} with PayPal</button></form>`;
  else if (row.positionCents < 0)
    action = `<p class="sub">You are owed ${fmt(-row.positionCents)}. The treasurer returns it to you through PayPal, after the organizer approves.</p>`;
  else action = `<p class="sub">You are all square. Nothing to pay.</p>`;
  return page(
    `${ev.name}: your share`,
    `<main class="card"><h1>${esc(ev.name)}</h1><p class="sub">${esc([ev.dateLabel, ev.location].filter(Boolean).join(" · "))}${ev.collectBy ? ` · due ${esc(ev.collectBy)}` : ""}</p>
${banner}<p style="margin:0 0 4px;color:var(--fog)">Your share, ${esc(row.name)}</p>
<table aria-label="Your share">${lines}${credits}<tr class="total"><td>${row.positionCents >= 0 ? "To pay" : "Owed to you"}</td><td class="n big">${fmt(Math.abs(row.positionCents))}</td></tr></table>
${action}
<p class="note">${mode === "fixtures" ? "Demo mode: payments go through Purser's offline sandbox simulator. No real money moves." : "Payments run in the PayPal sandbox. No real money moves."}</p></main>`,
  );
}

export function simCheckoutPage(order: any, ev: PurserEvent | undefined, who: string | undefined): string {
  const pu = order.purchase_units?.[0] ?? {};
  const items = (pu.items ?? []).map((i: any) => `<tr><td>${esc(i.name)}</td><td class="n">${esc(i.unit_amount?.value)}</td></tr>`).join("");
  const disc = Number(pu.amount?.breakdown?.discount?.value ?? 0);
  return page(
    "Offline checkout simulator",
    `<main class="card sim"><p style="margin:0 0 6px;font:600 12px 'IBM Plex Sans';letter-spacing:.18em;text-transform:uppercase;color:var(--brass-d)">Offline checkout simulator</p>
<h1>Approve payment</h1><p class="sub">Purser is running without PayPal credentials, so this page stands in for the PayPal sandbox approval screen. Approving sends the same capture call and webhooks the sandbox would.</p>
<table><tr><td>Order</td><td class="n"><code>${esc(order.id)}</code></td></tr>${ev ? `<tr><td>Merchant</td><td class="n">${esc(ev.name)}</td></tr>` : ""}${who ? `<tr><td>Payer</td><td class="n">${esc(who)}</td></tr>` : ""}
${items}${disc ? `<tr class="credit"><td>Credits</td><td class="n">&minus;${disc.toFixed(2)}</td></tr>` : ""}<tr class="total"><td>Total</td><td class="n big">${esc(pu.amount?.value)} ${esc(pu.amount?.currency_code)}</td></tr></table>
<form method="post" action="/sandbox-sim/checkout"><input type="hidden" name="token" value="${esc(order.id)}"><button class="btn primary" name="action" value="approve" type="submit">Approve as sandbox buyer</button><button class="btn quiet" name="action" value="cancel" type="submit">Cancel and return</button></form></main>`,
  );
}

export function simInvoicePage(inv: any): string {
  const paid = inv.status === "PAID";
  return page(
    "Invoice (offline simulator)",
    `<main class="card sim"><p style="margin:0 0 6px;font:600 12px 'IBM Plex Sans';letter-spacing:.18em;text-transform:uppercase;color:var(--brass-d)">Offline invoice simulator</p>
<h1>${esc(inv.invoicer?.business_name ?? "Invoice")}</h1><p class="sub">Invoice <code>${esc(inv.id)}</code> · ${esc(inv.status)}</p>
<table>${(inv.items ?? []).map((i: any) => `<tr><td>${esc(i.name)}</td><td class="n">${esc(i.unit_amount?.value)}</td></tr>`).join("")}<tr class="total"><td>Total</td><td class="n big">${esc(inv.amount?.value)} ${esc(inv.amount?.currency_code)}</td></tr></table>
${paid ? `<div class="banner ok">Paid. Thank you.</div>` : `<form method="post" action="/sandbox-sim/invoice/${esc(inv.id)}"><button class="btn primary" type="submit">Pay invoice as sandbox sponsor</button></form>`}</main>`,
  );
}

export function messagePage(title: string, text: string): string {
  return page(title, `<main class="card"><h1>${esc(title)}</h1><p class="sub">${esc(text)}</p></main>`);
}
