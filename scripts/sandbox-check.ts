// Live PayPal sandbox check. Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET
// (sandbox app). Exercises every PayPal surface Purser uses, through the same
// adapter the app uses, and writes the ids, statuses and debug ids it saw to
// docs/sandbox-evidence/<timestamp>.json. No secret or token is written.
//
//   node scripts/sandbox-check.ts                  create objects, print the approval link
//   node scripts/sandbox-check.ts --capture <id>   capture an order a sandbox buyer approved
//   node scripts/sandbox-check.ts --refund <id>    refund $0.50 of that capture
//
// Optional: SANDBOX_PAYOUT_EMAIL (a sandbox personal account email) to receive
// the test payout; otherwise a placeholder address is used (payout UNCLAIMED).
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../server/config.ts";
import { LivePayPal } from "../server/paypal/live.ts";

const cfg = loadConfig();
if (!cfg.paypal) {
  console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) first, or PURSER_SECRETS_FILE.");
  process.exit(2);
}
const pp = new LivePayPal(cfg.paypal);
const evidence: Record<string, unknown>[] = [];
const note = (step: string, r: { ok: boolean; status: number; debugId?: string; error?: string }, extra: Record<string, unknown> = {}) => {
  const row = { step, ok: r.ok, http: r.status, debugId: r.debugId ?? null, error: r.error ?? null, ...extra };
  evidence.push(row);
  console.log(`${r.ok ? "OK  " : "FAIL"} ${step.padEnd(34)} ${JSON.stringify(extra)}${r.error ? ` ${r.error}` : ""}`);
};

const arg = (f: string) => {
  const i = process.argv.indexOf(f);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (arg("--capture")) {
  const id = arg("--capture")!;
  const r = await pp.captureOrder(id, `sandbox-check-capture-${id}`);
  const cap = r.data?.purchase_units?.[0]?.payments?.captures?.[0];
  note("Orders v2 capture", r, { order: id, status: r.data?.status, capture: cap?.id, amount: cap?.amount });
  const again = await pp.captureOrder(id, `sandbox-check-capture-${id}`);
  note("Orders v2 capture (idempotent replay)", again, { status: again.data?.status, sameCapture: again.data?.purchase_units?.[0]?.payments?.captures?.[0]?.id === cap?.id });
} else if (arg("--refund")) {
  const cap = arg("--refund")!;
  const r = await pp.callTool("create_refund", { capture_id: cap, amount: { currency_code: "USD", value: "0.50" }, note_to_payer: "Purser sandbox check" });
  note("Toolkit create_refund", r, { capture: cap, refund: r.data?.id, status: r.data?.status });
} else {
  const t0 = Date.now();
  const order = await pp.callTool("create_order", {
    currencyCode: "USD",
    items: [{ name: "Purser sandbox check: cabin share", quantity: 1, itemCost: 2.5, itemTotal: 2.5 }],
    discount: 0.5,
    returnUrl: `${cfg.publicBase}/pay/return?check=1`,
    cancelUrl: `${cfg.publicBase}/?cancelled=1`,
  });
  const approve = (order.data?.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href;
  note("Toolkit create_order", order, { order: order.data?.id, status: order.data?.status, approveLink: Boolean(approve) });
  if (order.ok) {
    const got = await pp.callTool("get_order", { id: order.data.id });
    note("Toolkit get_order", got, { status: got.data?.status, amount: got.data?.purchase_units?.[0]?.amount });
  }
  const inv = await pp.callTool("create_invoice", {
    currency_code: "USD",
    invoicer_business_name: "Purser sandbox check",
    note: "Sponsor contribution (sandbox test)",
    primary_recipients: [{ billing_info: { business_name: "Sandbox Sponsor", email_address: process.env.SANDBOX_PAYOUT_EMAIL ?? "sponsor@example.com" } }],
    items: [{ name: "Contribution", quantity: "1", unit_amount: { currency_code: "USD", value: "3.00" } }],
  });
  const invId = String(inv.data?.href ?? inv.data?.id ?? "").split("/").pop();
  note("Toolkit create_invoice", inv, { invoice: invId });
  if (inv.ok) {
    const sent = await pp.callTool("send_invoice", { invoice_id: invId, send_to_recipient: true });
    note("Toolkit send_invoice", sent, { payerView: Boolean(sent.data?.href) });
    const remind = await pp.callTool("send_invoice_reminder", { invoice_id: invId, subject: "Reminder", note: "Sandbox reminder" });
    note("Toolkit send_invoice_reminder", remind, {});
    const got = await pp.callTool("get_invoice", { invoice_id: invId });
    note("Toolkit get_invoice", got, { status: got.data?.status });
  }
  const batch = `purser-check-${Date.now().toString(36)}`;
  const payout = await pp.createPayout(batch, "Purser sandbox check", [
    { email: process.env.SANDBOX_PAYOUT_EMAIL ?? "purser-check@example.com", value: "1.00", currency: "USD", note: "Reimbursement test", senderItemId: `${batch}-1` },
  ]);
  note("Payouts v1 create", payout, { batch: payout.data?.batch_header?.payout_batch_id, status: payout.data?.batch_header?.batch_status });
  if (payout.ok) {
    await new Promise((r) => setTimeout(r, 4000));
    const b = await pp.getPayoutBatch(payout.data.batch_header.payout_batch_id);
    note("Payouts v1 get", b, { status: b.data?.batch_header?.batch_status, item: b.data?.items?.[0]?.transaction_status });
  }
  const tx = await pp.callTool("list_transactions", {});
  note("Toolkit list_transactions", tx, { count: tx.data?.transaction_details?.length ?? null });
  const wh = await pp.verifyWebhook({}, {});
  evidence.push({ step: "Webhook verification configured", value: wh === "NO_WEBHOOK_ID" ? "no PAYPAL_WEBHOOK_ID set" : "PAYPAL_WEBHOOK_ID set (empty event correctly fails)", result: wh });
  if (approve) console.log(`\nApprove the order as a sandbox buyer:\n  ${approve}\nthen run: node scripts/sandbox-check.ts --capture ${order.data.id}\n`);
  evidence.push({ step: "elapsed", ms: Date.now() - t0 });
}

mkdirSync("docs/sandbox-evidence", { recursive: true });
const file = `docs/sandbox-evidence/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ environment: "PayPal sandbox", base: pp.describe().base, toolkit: pp.describe().toolkitVersion, evidence }, null, 2));
console.log(`evidence written to ${file}`);
