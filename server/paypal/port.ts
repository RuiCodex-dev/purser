// One interface, two adapters:
//   LivePayPal    - the real PayPal sandbox (REST + the official Agent Toolkit)
//   FixturePayPal - an offline replay of the same documented contracts, so the
//                   app runs end to end before any credentials exist.

export interface CallResult {
  ok: boolean;
  status: number;
  data: any;
  error?: string;
  debugId?: string;
}

export interface PayoutItemInput {
  email: string;
  value: string;
  currency: string;
  note: string;
  senderItemId: string;
}

export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource_type?: string;
  resource: any;
  summary?: string;
}

export interface PayPalPort {
  readonly mode: "sandbox" | "fixtures";
  /** Executes a tool from the PayPal Agent Toolkit (by its toolkit name). */
  callTool(name: string, args: Record<string, unknown>, requestId?: string): Promise<CallResult>;
  /** Orders v2 capture, with an idempotency key (live: PayPal Server SDK). */
  captureOrder(orderId: string, requestId: string): Promise<CallResult>;
  getOrder(orderId: string): Promise<CallResult>;
  /** Orders v2 create, for currencies the toolkit's create_order does not accept. */
  createOrderRest(body: unknown, requestId: string): Promise<CallResult>;
  /** Payouts v1 (not covered by the Agent Toolkit). */
  createPayout(batchId: string, subject: string, items: PayoutItemInput[]): Promise<CallResult>;
  getPayoutBatch(batchId: string): Promise<CallResult>;
  /** Webhooks v1 signature check. Returns "fixture" for simulated events. */
  verifyWebhook(headers: Record<string, string | undefined>, body: any): Promise<"SUCCESS" | "FAILURE" | "NO_WEBHOOK_ID">;
  /** Where buyers are sent to approve. In fixtures this is the local simulator. */
  /** serverSdkVersion is set when Orders v2 calls go through the PayPal Server SDK (live mode). */
  describe(): { mode: string; base: string; toolkitVersion: string; serverSdkVersion?: string };
}
