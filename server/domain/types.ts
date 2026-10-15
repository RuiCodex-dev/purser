import type { Cents } from "./money.ts";

export type Role = "organizer" | "cohost" | "guest";

export interface Participant {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "dropped";
  droppedAt?: string;
}

/**
 * shared   - one total, split across the people who carry it
 * per_head - a price per person who carries it
 * Who carries it is everyone, or only `optedIn` when that list is present.
 */
export type ItemKind = "shared" | "per_head";

export interface CostItem {
  id: string;
  label: string;
  kind: ItemKind;
  amountCents: Cents;
  /** Participant who already paid this out of pocket (gets reimbursed). */
  paidById?: string;
  /** Vendor the pot still has to pay (via PayPal Payouts). */
  vendor?: { name: string; email: string };
  /** If false, a person who drops out still carries their share of this item. */
  refundable: boolean;
  /** Present when only some participants take part (an optional extra). */
  optedIn?: string[];
  source: "brief" | "receipt" | "manual";
  note?: string;
}

export interface Sponsor {
  id: string;
  name: string;
  email: string;
  amountCents: Cents;
  note?: string;
}

export interface Mandate {
  /** Any single payout above this goes to the approval inbox. */
  maxPayoutCents: Cents;
  /** Any single refund above this goes to the approval inbox. */
  maxRefundCents: Cents;
  /** Money may only leave the pot up to what came in, plus this float. */
  floatCents: Cents;
  /** Vendors listed on cost items may be paid without approval. */
  autoPayVendors: boolean;
  /** Extra payee emails the organizer trusts. */
  extraPayees: string[];
}

export interface OrderRec {
  id: string;
  participantId: string;
  amountCents: Cents;
  status: "CREATED" | "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED" | "SUPERSEDED";
  approveUrl?: string;
  captureId?: string;
  capturedCents: Cents;
  refundedCents: Cents;
  createdAt: string;
  via: "agent-toolkit" | "rest";
}

export interface RefundRec {
  id: string;
  orderId: string;
  captureId: string;
  participantId: string;
  amountCents: Cents;
  status: string;
  createdAt: string;
}

export interface PayoutRec {
  batchId: string;
  itemId?: string;
  senderItemId: string;
  payee: { type: "participant"; participantId: string } | { type: "vendor"; itemId: string };
  email: string;
  amountCents: Cents;
  status: string;
  createdAt: string;
}

export interface InvoiceRec {
  id: string;
  sponsorId: string;
  amountCents: Cents;
  status: "DRAFT" | "SENT" | "PAID" | "CANCELLED" | string;
  reminders: number;
  lastReminderAt?: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  createdAt: string;
  tool: string;
  args: Record<string, unknown>;
  subject: string;
  amountCents: Cents;
  reasons: string[];
  status: "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";
  resolvedAt?: string;
  result?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: "agent" | "organizer" | "payer" | "webhook" | "system";
  action: string;
  detail: string;
  amountCents?: Cents;
  verdict?: "allow" | "approval" | "deny";
  paypalId?: string;
  debugId?: string;
}

export interface PurserEvent {
  id: string;
  name: string;
  dateLabel: string;
  location: string;
  currency: string;
  collectBy?: string;
  brief: string;
  createdAt: string;
  participants: Participant[];
  items: CostItem[];
  sponsors: Sponsor[];
  mandate: Mandate;
  payTokens: Record<string, string>;
  orders: OrderRec[];
  refunds: RefundRec[];
  payouts: PayoutRec[];
  invoices: InvoiceRec[];
  approvals: Approval[];
  audit: AuditEntry[];
  note?: string;
}
