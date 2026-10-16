import { checkDraft, type DraftItem, type DraftParticipant, type DraftSponsor, type EventDraft } from "../domain/build.ts";
import type { Gemini } from "./gemini.ts";

export const SAMPLE_BRIEF = `Cedar Hollow cabin weekend, Nov 21-23. Eight of us: Maya (organizer), Jonah, Priya, Sam, Lena (co-host), Theo, Ines and Kofi.
Cabin rental $1,480, non-refundable. Maya already paid it.
Groceries and firewood $312, Jonah is buying them.
Guided kayak tour $45 per person, optional: Priya, Sam, Theo, Kofi.
Pontoon boat $260 from Lakeside Rentals (rentals@lakeside.example), we pay them after the trip.
Ridgeline Outfitters sponsors $200 (events@ridgeline.example).
Collect by Nov 10.`;

const CURRENCY: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP" };
const AMOUNT = /([$€£])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(USD|EUR|GBP|dollars|euros)/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

function money(s: string): { amount: number; currency?: string } | undefined {
  const m = s.match(AMOUNT);
  if (!m) return undefined;
  if (m[1]) return { amount: Number(m[2].replace(/,/g, "")), currency: CURRENCY[m[1]] };
  const unit = m[4].toLowerCase();
  return { amount: Number(m[3]), currency: unit.startsWith("eur") ? "EUR" : unit.startsWith("dollar") ? "USD" : m[4].toUpperCase() };
}

function names(list: string): string[] {
  return list
    .split(/,|\band\b|&/i)
    .map((x) => x.replace(/\(.*?\)/g, "").replace(/[.;]$/, "").trim())
    .filter((x) => /^[A-Z][\p{L}'-]*(?:\s[A-Z][\p{L}'-]*)?$/u.test(x));
}

/**
 * A deterministic reader for briefs written like the sample: one cost per
 * sentence or line. It is the fallback when no model is configured, and it is
 * deliberately conservative: anything it cannot place is reported, not guessed.
 */
export function parseBriefOffline(text: string): { draft: EventDraft; issues: string[] } {
  const sentences = text
    .replace(/\r/g, "")
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = sentences[0] ?? "";
  const head = first.split(/:|\.(?=\s|$)/)[0];
  const [namePart, ...rest] = head.split(",");
  const draft: EventDraft = {
    name: (namePart ?? "Untitled event").trim(),
    dateLabel: rest.join(",").replace(/\b(eight|seven|six|five|four|ten|nine|\d+)\s+of us\b.*$/i, "").trim(),
    location: "",
    currency: "USD",
    participants: [],
    items: [],
    sponsors: [],
  };
  const issues: string[] = [];
  let currencySet = false;

  // Participants: the first sentence with a colon-introduced list of names.
  for (const s of sentences) {
    const m = s.match(/(?:of us|people|guests|attendees|group|crew|participants)\s*:\s*(.+)$/i);
    if (!m) continue;
    for (const raw of m[1].split(/,|\band\b/i)) {
      const nm = raw.replace(/\(.*?\)/g, "").replace(/[.;]$/, "").trim();
      if (!nm) continue;
      const tag = raw.match(/\((.*?)\)/)?.[1]?.toLowerCase() ?? "";
      const email = raw.match(EMAIL)?.[0];
      const role: DraftParticipant["role"] = /organi[sz]er|treasurer|me\b/.test(tag) ? "organizer" : /co-?host|host/.test(tag) ? "cohost" : "guest";
      draft.participants.push({ name: nm, email, role });
    }
    break;
  }
  const known = new Map(draft.participants.map((p) => [p.name.toLowerCase(), p.name]));
  const isPerson = (n?: string) => (n ? known.get(n.toLowerCase()) : undefined);

  let last: DraftItem | undefined;
  for (const s of sentences) {
    if (s === first && draft.participants.length) continue;
    const collect = s.match(/collect(?:ed)? (?:by|before)\s+([^.]+)/i);
    if (collect) {
      draft.collectBy = collect[1].trim();
      continue;
    }
    const m = money(s);
    const payer = s.match(/\b([A-Z][\p{L}'-]+)\s+(?:already paid|has paid|paid for|is buying|bought|fronted|covered|is covering|put down)/u)?.[1];
    if (!m) {
      // "Maya already paid it." attaches to the cost before it.
      if (payer && last && isPerson(payer)) last.paidBy = isPerson(payer);
      continue;
    }
    if (!currencySet && m.currency) {
      draft.currency = m.currency;
      currencySet = true;
    }
    const email = s.match(EMAIL)?.[0];
    if (/\b(sponsor|sponsors|chips? in|contribut|donat|pledg)/i.test(s)) {
      const who = s.split(/\b(?:sponsors?|chips? in|contribut\w*|donat\w*|pledg\w*)\b/i)[0].replace(/^(and|also)\s+/i, "").trim();
      const sp: DraftSponsor = { name: who || "Sponsor", email, amount: m.amount };
      draft.sponsors.push(sp);
      last = undefined;
      continue;
    }
    const label = s
      .split(AMOUNT)[0]
      .replace(/\b(costs?|is|are|about|around|roughly|approx\.?|total|for|at|of)\s*$/i, "")
      .replace(/[,:\s-]+$/, "")
      .trim();
    const perHead = /\b(per person|per head|each|pp|a head|per guest)\b/i.test(s);
    const optional = s.match(/optional\s*[:(-]\s*([^.)]+)/i) ?? s.match(/only\s+([A-Z][^.]+?)\s+(?:want|are|join)/);
    const vendor = s.match(/\bfrom\s+([A-Z][\w&'. -]+?)\s*(?:\(|,|$|\.)/);
    const item: DraftItem = {
      label: label || "Cost",
      kind: perHead ? "per_head" : "shared",
      amount: m.amount,
      refundable: !/non-?refundable|no refunds?|deposit is lost/i.test(s),
    };
    if (optional) {
      item.optedIn = names(optional[1]).map(isPerson).filter((x): x is string => Boolean(x));
      if (!item.optedIn.length) issues.push(`Could not read who opted into "${item.label}"`);
    }
    if (payer && isPerson(payer)) item.paidBy = isPerson(payer);
    else if (vendor) {
      item.vendorName = vendor[1].trim();
      item.vendorEmail = email;
    }
    draft.items.push(item);
    last = item;
  }
  issues.push(...checkDraft(draft));
  return { draft, issues };
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short event name" },
    dateLabel: { type: "string", description: "Dates as written, e.g. 'Nov 21-23'" },
    location: { type: "string" },
    currency: { type: "string", description: "ISO 4217 code, e.g. USD" },
    collectBy: { type: "string", description: "Deadline for collecting money, as written" },
    participants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string", description: "Only if written in the brief" },
          role: { type: "string", enum: ["organizer", "cohost", "guest"] },
        },
        required: ["name", "role"],
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          kind: { type: "string", enum: ["shared", "per_head"], description: "per_head = the amount is a price per person; shared = the amount is a total to split" },
          amount: { type: "number", description: "For per_head: the price per person. Otherwise the total." },
          paidBy: { type: "string", description: "Participant name who already paid this out of pocket" },
          vendorName: { type: "string", description: "Business still to be paid by the group" },
          vendorEmail: { type: "string" },
          refundable: { type: "boolean", description: "false if a person who drops out still owes their share" },
          optedIn: { type: "array", items: { type: "string" }, description: "Only for optional extras: the participant names who opted in. Omit when everyone takes part." },
        },
        required: ["label", "kind", "amount", "refundable"],
      },
    },
    sponsors: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" }, amount: { type: "number" }, note: { type: "string" } },
        required: ["name", "amount"],
      },
    },
  },
  required: ["name", "currency", "participants", "items", "sponsors"],
};

/**
 * Every name a model returns must be present in the brief itself. A model that
 * adds a person, a vendor or a sponsor (or garbles one) fails this check, and
 * the brief goes to the strict parser instead.
 */
export function groundingIssues(d: EventDraft, text: string): string[] {
  const hay = text.toLowerCase();
  const out: string[] = [];
  const check = (what: string, v?: string) => {
    if (v && !hay.includes(v.trim().toLowerCase())) out.push(`${what} "${v}" is not in the brief`);
  };
  for (const p of d.participants ?? []) check("Participant", p.name);
  for (const i of d.items ?? []) {
    check("Vendor", i.vendorName);
    check("Vendor email", i.vendorEmail);
    check("Payer", i.paidBy);
  }
  for (const s of d.sponsors ?? []) {
    check("Sponsor", s.name);
    check("Sponsor email", s.email);
  }
  for (const p of d.participants ?? []) check("Email", p.email);
  return out;
}

const EMAIL_G = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Repairs one known model glitch before grounding: a name with junk or an email
 * glued on ("Lakeside Rentals shelterEmail rentals@lakeside.example"). The name is
 * cut back to its longest leading run of words that appears in the brief, and a
 * glued email is kept only if the brief contains it. Anything repaired is grounded
 * by construction; anything else still has to pass groundingIssues.
 */
export function repairNames(d: EventDraft, text: string): number {
  const hay = text.toLowerCase();
  let fixed = 0;
  const cut = (v?: string): { name?: string; email?: string } => {
    if (!v || hay.includes(v.trim().toLowerCase())) return { name: v };
    const email = (v.match(EMAIL_G) ?? []).find((e) => hay.includes(e.toLowerCase()));
    // Only a value that shows leaked structure (an email, or a camelCase field name
    // glued to a word) is repaired; otherwise "Theo Partners" could become "Theo".
    const alien = (ch: string) => !hay.includes(ch.toLowerCase());
    if (!/@|[a-z][A-Z]/.test(v) && ![...v].some(alien)) return { name: v };
    const words = [...v.replace(EMAIL_G, " ").replace(/([a-z])([A-Z])/g, "$1 $2")]
      .map((ch) => (alien(ch) ? " " : ch))
      .join("")
      .trim()
      .split(/\s+/);
    for (let n = words.length; n > 0; n--) {
      const cand = words.slice(0, n).join(" ").replace(/[\s,;:(]+$/, "");
      if (cand.length >= 2 && hay.includes(cand.toLowerCase())) {
        fixed++;
        return { name: cand, email };
      }
    }
    return { name: v };
  };
  for (const i of d.items ?? []) {
    const r = cut(i.vendorName);
    i.vendorName = r.name;
    if (r.email && !i.vendorEmail) i.vendorEmail = r.email;
    i.paidBy = cut(i.paidBy).name;
  }
  for (const sp of d.sponsors ?? []) {
    const r = cut(sp.name);
    sp.name = r.name!;
    if (r.email && !sp.email) sp.email = r.email;
  }
  return fixed;
}

/**
 * A vendor or sponsor the brief gives an email for must keep it: if the model
 * dropped it, take the first email written right after the name, within the same
 * sentence. Without this, a payout would go to a generated placeholder address.
 */
export function restoreEmails(d: EventDraft, text: string): void {
  const near = (name?: string): string | undefined => {
    if (!name) return undefined;
    const at = text.toLowerCase().indexOf(name.trim().toLowerCase());
    if (at < 0) return undefined;
    const window = text.slice(at, at + name.length + 80).split(/\n|[.!?](?=\s|$)/)[0];
    return window.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  };
  for (const i of d.items ?? []) if (i.vendorName && !i.vendorEmail) i.vendorEmail = near(i.vendorName);
  for (const sp of d.sponsors ?? []) if (!sp.email) sp.email = near(sp.name);
}

/**
 * Cross-checks a model draft against the strict parser: when both found the same
 * vendor or sponsor, a name the model shortened is completed and an email the
 * model dropped is restored, so a payout never goes to a placeholder address
 * while the brief states the real one.
 */
export function crossFill(d: EventDraft, offline: EventDraft): void {
  const vendors = (offline.items ?? []).filter((i) => i.vendorName);
  const same = (a: string, b: string) => {
    const x = a.trim().toLowerCase();
    const y = b.trim().toLowerCase();
    return x === y || y.startsWith(x + " ") || x.startsWith(y + " ");
  };
  for (const i of d.items ?? []) {
    if (!i.vendorName) continue;
    const o = vendors.find((x) => same(x.vendorName!, i.vendorName!));
    if (!o) continue;
    if (o.vendorName!.length > i.vendorName.length) i.vendorName = o.vendorName;
    if (!i.vendorEmail && o.vendorEmail) i.vendorEmail = o.vendorEmail;
  }
  for (const sp of d.sponsors ?? []) {
    const o = (offline.sponsors ?? []).find((x) => same(x.name, sp.name));
    if (!o) continue;
    if (o.name.length > sp.name.length) sp.name = o.name;
    if (!sp.email && o.email) sp.email = o.email;
  }
}

export async function parseBrief(
  text: string,
  llm: Gemini,
): Promise<{ draft: EventDraft; issues: string[]; by: "model" | "parser"; model?: string; note?: string }> {
  if (llm.available) {
    const r = await llm.json<EventDraft>({
      system:
        "You turn a group-event organizer's brief into a structured budget. Never invent people, amounts or emails that are not in the text. " +
        "A cost someone already paid out of pocket gets paidBy. A business the group still has to pay gets vendorName. " +
        "Sponsors are outside organisations or people contributing a fixed amount; they are not participants.",
      contents: [{ role: "user", parts: [{ text }] }],
      schema: DRAFT_SCHEMA,
      temperature: 0,
    });
    if (r.ok) {
      const d = r.value;
      d.items ??= [];
      d.sponsors ??= [];
      d.participants ??= [];
      d.dateLabel ??= "";
      d.location ??= "";
      repairNames(d, text);
      const offline = parseBriefOffline(text);
      if (!offline.issues.length) crossFill(d, offline.draft);
      restoreEmails(d, text);
      const issues = [...checkDraft(d), ...groundingIssues(d, text)];
      if (!issues.length) return { draft: d, issues, by: "model", model: r.model };
      if (!offline.issues.length) return { ...offline, by: "parser", note: `Model draft failed checks (${issues[0]}); used the offline parser` };
      return { draft: d, issues, by: "model", model: r.model };
    }
    const offline = parseBriefOffline(text);
    return { ...offline, by: "parser", note: `Model unavailable (${r.error}); used the offline parser` };
  }
  return { ...parseBriefOffline(text), by: "parser" };
}
