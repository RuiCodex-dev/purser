import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { Agent } from "./ai/agent.ts";
import { askLedger, draftNudges, readReceipt } from "./ai/assist.ts";
import { parseBrief, parseBriefOffline, SAMPLE_BRIEF } from "./ai/brief.ts";
import { Gemini } from "./ai/gemini.ts";
import type { Config } from "./config.ts";
import { buildEvent, checkDraft, placeholderEmail, type EventDraft } from "./domain/build.ts";
import { computeLedger } from "./domain/ledger.ts";
import { toCents } from "./domain/money.ts";
import { describeIntent, plan, waitingPayouts } from "./domain/planner.ts";
import type { CostItem, Mandate, PurserEvent } from "./domain/types.ts";
import { messagePage, payPage, simCheckoutPage, simInvoicePage } from "./http/pages.ts";
import { FixturePayPal } from "./paypal/fixtures.ts";
import { LivePayPal } from "./paypal/live.ts";
import type { PayPalPort, WebhookEvent } from "./paypal/port.ts";
import { Bus, Store } from "./store.ts";
import { Treasury } from "./treasury.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface App {
  server: Server;
  store: Store;
  bus: Bus;
  pp: PayPalPort;
  treasury: Treasury;
  agent: Agent;
  llm: Gemini;
  close(): Promise<void>;
}

export function createApp(cfg: Config, opts: { webRoot?: string } = {}): App {
  const store = new Store(cfg.dataDir);
  const bus = new Bus();
  const llm = new Gemini(cfg.gemini);
  let treasury!: Treasury;
  const onWebhook = async (e: WebhookEvent) => {
    await treasury.handleWebhook(e, "fixture");
  };
  const fixtures = cfg.paypal && !cfg.forceFixtures ? undefined : new FixturePayPal({ publicBase: cfg.publicBase, onWebhook, settleMs: cfg.fixtureSettleMs });
  if (fixtures) fixtures.restore(store.data.fixtures);
  const pp: PayPalPort = fixtures ?? new LivePayPal(cfg.paypal!);
  treasury = new Treasury(store, pp, bus, cfg.publicBase);
  const agent = new Agent(llm, treasury, bus);
  const webRoot = opts.webRoot ?? resolve(process.cwd(), "web", "dist");

  const persist = () => {
    if (fixtures) store.data.fixtures = fixtures.snapshot();
    store.save();
  };
  bus.on((m) => {
    if (m.type === "event") persist();
  });

  const mustEvent = (id: string): PurserEvent => {
    const ev = store.event(id);
    if (!ev) throw new HttpError(404, "No such event");
    return ev;
  };

  const view = (ev: PurserEvent) => ({
    event: ev,
    ledger: computeLedger(ev),
    plan: plan(ev, { includeReminders: false }).map((i) => ({ ...i, what: describeIntent(ev, i) })),
    waiting: waitingPayouts(ev),
    payLinks: Object.fromEntries(ev.participants.map((p) => [p.id, treasury.payUrl(ev, p.id)])),
  });

  async function body(req: IncomingMessage, limit = 9 * 1024 * 1024): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) throw new HttpError(413, "Request too large");
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, "Body is not valid JSON");
    }
  }

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const html = (res: ServerResponse, status: number, page: string) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" });
    res.end(page);
  };
  const redirect = (res: ServerResponse, to: string) => {
    res.writeHead(303, { Location: to });
    res.end();
  };

  function serveStatic(res: ServerResponse, pathname: string): boolean {
    if (!existsSync(webRoot)) return false;
    const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    let file = join(webRoot, rel);
    if (!file.startsWith(webRoot)) return false;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(rel)) return false;
      file = join(webRoot, "index.html"); // SPA fallback
      if (!existsSync(file)) return false;
    }
    const immutable = /[\\/]assets[\\/]|[\\/]fonts[\\/]/.test(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(readFileSync(file));
    return true;
  }

  function addItem(ev: PurserEvent, b: any): CostItem {
    const label = String(b.label ?? "").trim();
    const amount = Number(b.amount);
    if (!label || !(amount > 0)) throw new HttpError(400, "A cost needs a label and a positive amount");
    const kind = b.kind === "per_head" ? "per_head" : "shared";
    const paidBy = b.paidById ? ev.participants.find((p) => p.id === b.paidById) : undefined;
    if (b.paidById && !paidBy) throw new HttpError(400, "Unknown participant for paidById");
    const item: CostItem = {
      id: `i${Date.now().toString(36)}`,
      label: label.slice(0, 120),
      kind,
      amountCents: toCents(amount),
      paidById: paidBy?.id,
      vendor: !paidBy && b.vendorName ? { name: String(b.vendorName), email: String(b.vendorEmail || placeholderEmail(String(b.vendorName))).toLowerCase() } : undefined,
      refundable: b.refundable !== false,
      optedIn: Array.isArray(b.optedIn) && b.optedIn.length ? b.optedIn.filter((x: string) => ev.participants.some((p) => p.id === x)) : undefined,
      source: b.source === "receipt" ? "receipt" : "manual",
      note: b.note ? String(b.note).slice(0, 300) : undefined,
    };
    ev.items.push(item);
    return item;
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    const m = (re: RegExp) => p.match(re);
    const method = req.method ?? "GET";

    // ---- SSE
    if (p === "/api/stream" && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": hello\n\n");
      const off = bus.on((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        off();
        clearInterval(ping);
      });
      return;
    }

    if (p === "/api/health" && method === "GET") {
      const d = pp.describe();
      return json(res, 200, { ok: true, paypal: { mode: pp.mode, label: d.mode, toolkit: `@paypal/agent-toolkit ${d.toolkitVersion}`, webhookVerification: cfg.paypal?.webhookId ? "on" : "off" }, ai: { configured: llm.available, model: llm.available ? llm.model : null }, publicBase: cfg.publicBase });
    }

    if (p === "/api/events" && method === "GET")
      return json(res, 200, store.data.events.map((e) => ({ id: e.id, name: e.name, dateLabel: e.dateLabel, currency: e.currency, people: e.participants.length, createdAt: e.createdAt, totals: computeLedger(e).totals })));

    if (p === "/api/sample-brief" && method === "GET") return json(res, 200, { text: SAMPLE_BRIEF });

    if (p === "/api/briefs/parse" && method === "POST") {
      const b = await body(req);
      const text = String(b.text ?? "").slice(0, 6000);
      if (text.trim().length < 20) throw new HttpError(400, "Describe the event in a few sentences first");
      return json(res, 200, await parseBrief(text, llm));
    }

    if (p === "/api/events" && method === "POST") {
      const b = await body(req);
      const draft = b.draft as EventDraft;
      const issues = draft ? checkDraft(draft) : ["Missing draft"];
      if (issues.length) throw new HttpError(422, issues.join("; "));
      const ev = buildEvent(draft, String(b.brief ?? ""));
      store.data.events.unshift(ev);
      treasury.audit(ev, { actor: "organizer", action: "Created the event", detail: `${ev.participants.length} people, ${ev.items.length} costs, ${ev.sponsors.length} sponsor(s)` });
      treasury.touch(ev);
      return json(res, 201, view(ev));
    }

    if (p === "/api/demo" && method === "POST") {
      const { draft } = parseBriefOffline(SAMPLE_BRIEF);
      const ev = buildEvent(draft, SAMPLE_BRIEF);
      store.data.events.unshift(ev);
      treasury.audit(ev, { actor: "organizer", action: "Created the event", detail: "From the sample brief" });
      treasury.touch(ev);
      return json(res, 201, view(ev));
    }

    let mm: RegExpMatchArray | null;
    if ((mm = m(/^\/api\/events\/([a-f0-9]+)$/))) {
      const ev = mustEvent(mm[1]);
      if (method === "GET") return json(res, 200, view(ev));
      if (method === "DELETE") {
        store.data.events = store.data.events.filter((e) => e.id !== ev.id);
        persist();
        bus.emit({ type: "deleted", eventId: ev.id });
        return json(res, 200, { ok: true });
      }
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/mandate$/)) && method === "PUT") {
      const ev = mustEvent(mm[1]);
      const b = await body(req);
      const cents = (v: unknown, d: number) => (v === undefined ? d : Math.max(0, toCents(Number(v))));
      const next: Mandate = {
        maxPayoutCents: cents(b.maxPayout, ev.mandate.maxPayoutCents),
        maxRefundCents: cents(b.maxRefund, ev.mandate.maxRefundCents),
        floatCents: cents(b.float, ev.mandate.floatCents),
        autoPayVendors: b.autoPayVendors === undefined ? ev.mandate.autoPayVendors : Boolean(b.autoPayVendors),
        extraPayees: Array.isArray(b.extraPayees) ? b.extraPayees.map((x: unknown) => String(x).trim().toLowerCase()).filter((x: string) => x.includes("@")).slice(0, 20) : ev.mandate.extraPayees,
      };
      ev.mandate = next;
      treasury.audit(ev, { actor: "organizer", action: "Changed the mandate", detail: JSON.stringify({ maxPayout: b.maxPayout, maxRefund: b.maxRefund, autoPayVendors: next.autoPayVendors }) });
      treasury.touch(ev);
      return json(res, 200, view(ev));
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/items$/)) && method === "POST") {
      const ev = mustEvent(mm[1]);
      const item = addItem(ev, await body(req));
      treasury.audit(ev, { actor: "organizer", action: `Added a cost: ${item.label}`, detail: item.source === "receipt" ? "From a receipt photo" : "Entered by hand", amountCents: item.amountCents });
      treasury.touch(ev);
      return json(res, 201, view(ev));
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/items\/([\w-]+)$/)) && method === "DELETE") {
      const ev = mustEvent(mm[1]);
      const item = ev.items.find((i) => i.id === mm![2]);
      if (!item) throw new HttpError(404, "No such cost");
      if (ev.payouts.some((x) => x.payee.type === "vendor" && x.payee.itemId === item.id)) throw new HttpError(409, "This vendor has already been paid");
      ev.items = ev.items.filter((i) => i !== item);
      treasury.audit(ev, { actor: "organizer", action: `Removed a cost: ${item.label}`, detail: "The ledger was recomputed", amountCents: item.amountCents });
      treasury.touch(ev);
      return json(res, 200, view(ev));
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/participants\/(p\d+)$/)) && method === "PATCH") {
      const ev = mustEvent(mm[1]);
      const person = ev.participants.find((x) => x.id === mm![2]);
      if (!person) throw new HttpError(404, "No such participant");
      const b = await body(req);
      if (b.email !== undefined) {
        const e = String(b.email).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, "That email does not look right");
        person.email = e;
      }
      if (b.name !== undefined && String(b.name).trim()) person.name = String(b.name).trim().slice(0, 60);
      treasury.touch(ev);
      return json(res, 200, view(ev));
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/participants\/(p\d+)\/(drop|rejoin)$/)) && method === "POST") {
      const ev = mustEvent(mm[1]);
      const person = ev.participants.find((x) => x.id === mm![2]);
      if (!person) throw new HttpError(404, "No such participant");
      person.status = mm[3] === "drop" ? "dropped" : "active";
      person.droppedAt = mm[3] === "drop" ? new Date().toISOString() : undefined;
      treasury.audit(ev, { actor: "organizer", action: `${person.name} ${mm[3] === "drop" ? "dropped out" : "rejoined"}`, detail: "Shares of refundable costs were redistributed" });
      treasury.touch(ev);
      return json(res, 200, view(ev));
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/agent$/)) && method === "POST") {
      const ev = mustEvent(mm[1]);
      const b = await body(req);
      const instruction = String(b.instruction ?? "").trim().slice(0, 600) || "Settle up: request what people owe, invoice sponsors, and return money owed.";
      treasury.audit(ev, { actor: "organizer", action: "Asked the treasurer", detail: instruction });
      const r = await agent.run(ev, instruction);
      return json(res, 200, { ...r, view: view(ev) });
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/reconcile$/)) && method === "POST") {
      const ev = mustEvent(mm[1]);
      const changes = await treasury.reconcile(ev);
      return json(res, 200, { changes, view: view(ev) });
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/approvals\/(\w+)$/)) && method === "POST") {
      const ev = mustEvent(mm[1]);
      const b = await body(req);
      const r = await treasury.decideApproval(ev, mm[2], b.decision === "approve");
      return json(res, 200, { outcome: r ?? null, view: view(ev) });
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/ask$/)) && method === "POST") {
      const ev = mustEvent(mm[1]);
      const b = await body(req);
      const q = String(b.question ?? "").trim().slice(0, 300);
      if (!q) throw new HttpError(400, "Ask a question");
      return json(res, 200, await askLedger(llm, ev, q));
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/nudges$/)) && method === "GET") {
      const ev = mustEvent(mm[1]);
      return json(res, 200, await draftNudges(llm, ev, (pid) => treasury.payUrl(ev, pid)));
    }

    if ((mm = m(/^\/api\/events\/([a-f0-9]+)\/receipt$/)) && method === "POST") {
      mustEvent(mm[1]);
      const b = await body(req);
      const r = await readReceipt(llm, String(b.mimeType ?? ""), String(b.data ?? ""));
      return json(res, r.ok ? 200 : 422, r);
    }

    if (p === "/api/webhooks/paypal" && method === "POST") {
      const raw = await body(req, 512 * 1024);
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      const verdict = await pp.verifyWebhook(headers, raw);
      if (verdict !== "SUCCESS") return json(res, verdict === "NO_WEBHOOK_ID" ? 503 : 401, { ok: false, verification: verdict });
      const r = await treasury.handleWebhook(raw as WebhookEvent, "paypal");
      return json(res, 200, { ok: true, ...r });
    }

    // ---- participant pages
    if (p === "/pay/return" && method === "GET") {
      const ev = store.event(url.searchParams.get("e") ?? "");
      const pid = url.searchParams.get("p") ?? "";
      const orderId = url.searchParams.get("token") ?? "";
      if (!ev || !ev.payTokens[pid]) return html(res, 404, messagePage("Link not found", "This payment link is not valid."));
      const token = ev.payTokens[pid];
      const o = ev.orders.find((x) => x.id === orderId && x.participantId === pid);
      if (!o) return redirect(res, `/pay/${token}?error=${encodeURIComponent("That order is not yours.")}`);
      if (o.status === "SUPERSEDED")
        return redirect(res, `/pay/${token}?error=${encodeURIComponent("That payment request was replaced by one for the current amount. Nothing was charged; press Pay to continue.")}`);
      if (o.status !== "COMPLETED") {
        const fresh = await pp.getOrder(orderId);
        if (fresh.ok) treasury.applyOrder(ev, fresh.data);
        const r = await treasury.capture(ev, orderId, "payer");
        if (r && !(r.executed && r.ok) && ev.orders.find((x) => x.id === orderId)?.status !== "COMPLETED") {
          if (/INSTRUMENT_DECLINED/.test(r.error ?? "")) {
            // PayPal's guidance: send the buyer back to the same approval page to pick
            // another funding source. Nothing was charged.
            o.declinedAt = new Date().toISOString();
            treasury.audit(ev, { actor: "payer", action: "Payment declined", detail: "INSTRUMENT_DECLINED at capture; the payer can choose another funding source", paypalId: o.id, amountCents: o.amountCents });
            treasury.touch(ev);
            return redirect(res, `/pay/${token}?error=${encodeURIComponent("PayPal declined that payment method and nothing was charged. Press Pay to choose another way to pay.")}`);
          }
          return redirect(res, `/pay/${token}?error=${encodeURIComponent(r.error ?? r.reasons.join("; "))}`);
        }
      }
      return redirect(res, `/pay/${token}?done=1`);
    }

    if ((mm = m(/^\/pay\/([\w-]{8,})$/))) {
      const token = mm[1];
      const ev = store.data.events.find((e) => Object.values(e.payTokens).includes(token));
      const pid = ev && Object.entries(ev.payTokens).find(([, t]) => t === token)?.[0];
      if (!ev || !pid) return html(res, 404, messagePage("Link not found", "This payment link is not valid."));
      if (method === "GET") return html(res, 200, payPage(ev, pid, url.searchParams, pp.mode));
      if (method === "POST") {
        const row = computeLedger(ev).rows.find((r) => r.participantId === pid)!;
        if (row.positionCents <= 0) return redirect(res, `/pay/${token}`);
        const openFor = (r: typeof row) =>
          r.openOrder &&
          r.openOrder.amountCents === r.positionCents &&
          (r.openOrder.status === "PAYER_ACTION_REQUIRED" || (r.openOrder.status === "APPROVED" && r.openOrder.declinedAt)) &&
          r.openOrder.approveUrl
            ? r.openOrder
            : undefined;
        let open = openFor(row);
        if (!open) {
          const intent = plan(ev).find((i) => i.kind === "collect" && i.participantId === pid);
          if (!intent) return redirect(res, `/pay/${token}`);
          const call = treasury.toolCallFor(ev, intent);
          const out = await treasury.run(ev, call.name, call.args, "payer");
          // A double click (or a second tab) races the first request: once the first
          // order exists the mandate refuses a second one, so use the order it made.
          open = out.executed && out.ok ? ev.orders.find((o) => o.id === out.paypalId) : openFor(computeLedger(ev).rows.find((r) => r.participantId === pid)!);
          if (!open) return redirect(res, `/pay/${token}?error=${encodeURIComponent(out.error ?? out.reasons.join("; "))}`);
        }
        if (!open?.approveUrl) return redirect(res, `/pay/${token}?error=${encodeURIComponent("PayPal did not return an approval link.")}`);
        return redirect(res, open.approveUrl);
      }
    }

    // ---- offline simulator (fixtures only)
    if (fixtures && p === "/sandbox-sim/checkout") {
      if (method === "GET") {
        const id = url.searchParams.get("token") ?? "";
        const r = await fixtures.getOrder(id);
        if (!r.ok) return html(res, 404, messagePage("Unknown order", "The simulator has no such order."));
        const ev = store.data.events.find((e) => e.orders.some((o) => o.id === id));
        const who = ev?.participants.find((x) => x.id === ev.orders.find((o) => o.id === id)?.participantId)?.name;
        const reapprove = r.data.status === "APPROVED" && ev?.orders.find((o) => o.id === id)?.declinedAt;
        if (r.data.status !== "PAYER_ACTION_REQUIRED" && !reapprove) return html(res, 200, messagePage("Already handled", `This order is ${r.data.status}.`));
        return html(res, 200, simCheckoutPage(r.data, ev, who));
      }
      if (method === "POST") {
        const b = await body(req);
        const id = String(b.token ?? "");
        if (b.action === "approve" || b.action === "decline") {
          const back = fixtures.approveOrder(id, { decline: b.action === "decline" });
          return back ? redirect(res, back) : html(res, 409, messagePage("Cannot approve", "This order is not waiting for approval."));
        }
        const cancel = fixtures.cancelUrlFor(id);
        return cancel ? redirect(res, cancel) : html(res, 404, messagePage("Unknown order", "The simulator has no such order."));
      }
    }
    if (fixtures && (mm = m(/^\/sandbox-sim\/invoice\/(INV2-[\w-]+)$/))) {
      if (method === "POST") fixtures.payInvoice(mm[1]);
      const inv = fixtures.invoiceView(mm[1]);
      if (!inv) return html(res, 404, messagePage("Unknown invoice", "The simulator has no such invoice."));
      return html(res, 200, simInvoicePage(inv));
    }

    if (p.startsWith("/api/")) throw new HttpError(404, "Not found");
    if (method === "GET" && serveStatic(res, p)) return;
    if (method === "GET" && p === "/") return html(res, 200, messagePage("Purser", "The web app is not built yet. Run npm run build, then reload."));
    throw new HttpError(404, "Not found");
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      if ((req.url ?? "").startsWith("/api/")) json(res, status, { error: status === 500 ? "Something went wrong on the server" : e.message });
      else html(res, status, messagePage(status === 404 ? "Not found" : "Something went wrong", status === 500 ? "Please try again." : e.message));
    });
  });

  return {
    server,
    store,
    bus,
    pp,
    treasury,
    agent,
    llm,
    async close() {
      persist();
      store.flush();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
