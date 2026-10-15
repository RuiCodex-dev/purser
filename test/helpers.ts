import { SAMPLE_BRIEF, parseBriefOffline } from "../server/ai/brief.ts";
import { buildEvent } from "../server/domain/build.ts";
import type { PurserEvent } from "../server/domain/types.ts";

export function sampleEvent(): PurserEvent {
  const { draft, issues } = parseBriefOffline(SAMPLE_BRIEF);
  if (issues.length) throw new Error(issues.join("; "));
  return buildEvent(draft, SAMPLE_BRIEF);
}

export const byName = (ev: PurserEvent, name: string) => ev.participants.find((p) => p.name === name)!;

/** Pretends PayPal captured a payment for a participant. */
export function fakeCapture(ev: PurserEvent, name: string, cents: number) {
  const p = byName(ev, name);
  ev.orders.push({
    id: `ORDER${ev.orders.length}XXXXXXXXXXXX`,
    participantId: p.id,
    amountCents: cents,
    status: "COMPLETED",
    captureId: `CAP${ev.orders.length}XXXXXXXXXXXXXX`,
    capturedCents: cents,
    refundedCents: 0,
    createdAt: new Date().toISOString(),
    via: "agent-toolkit",
  });
}
