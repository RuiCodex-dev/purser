import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallResult, PayPalPort, PayoutItemInput } from "./port.ts";

const require = createRequire(import.meta.url);
const { PayPalAgentToolkit } = require("@paypal/agent-toolkit/openai");
// The package does not export its package.json, so read it next to the entry point.
export const TOOLKIT_VERSION: string = JSON.parse(
  readFileSync(join(dirname(require.resolve("@paypal/agent-toolkit/openai")), "..", "package.json"), "utf8"),
).version;

/** The only Agent Toolkit actions Purser enables. Everything else stays off. */
export const TOOLKIT_ACTIONS = {
  orders: { create: true, get: true, capture: true },
  invoices: { create: true, get: true, send: true, sendReminder: true, cancel: true },
  payments: { createRefund: true, getRefunds: true },
  transactions: { list: true },
};

export interface LiveConfig {
  clientId: string;
  clientSecret: string;
  webhookId?: string;
  base?: string;
}

export class LivePayPal implements PayPalPort {
  readonly mode = "sandbox" as const;
  private token?: { value: string; expires: number };
  private toolkit: any;
  private base: string;

  private cfg: LiveConfig;
  constructor(cfg: LiveConfig) {
    this.cfg = cfg;
    this.base = cfg.base ?? "https://api-m.sandbox.paypal.com";
    this.toolkit = new PayPalAgentToolkit({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      // The toolkit defaults to PRODUCTION unless sandbox is set explicitly.
      configuration: { actions: TOOLKIT_ACTIONS, context: { sandbox: true, source: "purser" } },
    });
  }

  describe() {
    return { mode: "PayPal sandbox", base: this.base, toolkitVersion: TOOLKIT_VERSION };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const auth = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal OAuth failed with HTTP ${res.status}`);
    const j: any = await res.json();
    this.token = { value: j.access_token, expires: Date.now() + Number(j.expires_in ?? 3000) * 1000 };
    return this.token.value;
  }

  private async rest(method: string, path: string, body?: unknown, requestId?: string): Promise<CallResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    return {
      ok: res.ok,
      status: res.status,
      data,
      debugId,
      error: res.ok ? undefined : (data?.message ?? data?.error_description ?? `HTTP ${res.status}`),
    };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    const msg = await this.toolkit.handleToolCall({
      id: `call_${randomUUID()}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const content: string | undefined = msg?.content;
    if (content === undefined || content === "") return { ok: true, status: 204, data: null };
    let data: any;
    try {
      data = JSON.parse(content);
    } catch {
      data = { raw: content };
    }
    // The toolkit reports failures as JSON rather than throwing.
    const err = data?.error ?? (data?.ok === false ? data : undefined);
    if (err) return { ok: false, status: Number(err.status ?? 400), data, error: String(err.message ?? JSON.stringify(err)).slice(0, 400) };
    if (data?.status === "error") return { ok: false, status: 400, data, error: "Capture failed" };
    return { ok: true, status: 200, data };
  }

  captureOrder(orderId: string, requestId: string) {
    return this.rest("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
  }

  getOrder(orderId: string) {
    return this.rest("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  createOrderRest(body: unknown, requestId: string) {
    return this.rest("POST", "/v2/checkout/orders", body, requestId);
  }

  createPayout(batchId: string, subject: string, items: PayoutItemInput[]) {
    return this.rest(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: batchId, email_subject: subject, email_message: subject },
        items: items.map((i) => ({
          recipient_type: "EMAIL",
          amount: { value: i.value, currency: i.currency },
          receiver: i.email,
          note: i.note,
          sender_item_id: i.senderItemId,
        })),
      },
      batchId,
    );
  }

  getPayoutBatch(batchId: string) {
    return this.rest("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  }

  async verifyWebhook(h: Record<string, string | undefined>, body: any) {
    if (!this.cfg.webhookId) return "NO_WEBHOOK_ID" as const;
    const r = await this.rest("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: h["paypal-auth-algo"],
      cert_url: h["paypal-cert-url"],
      transmission_id: h["paypal-transmission-id"],
      transmission_sig: h["paypal-transmission-sig"],
      transmission_time: h["paypal-transmission-time"],
      webhook_id: this.cfg.webhookId,
      webhook_event: body,
    });
    return r.ok && r.data?.verification_status === "SUCCESS" ? ("SUCCESS" as const) : ("FAILURE" as const);
  }
}
