import { useState } from "react";
import { api, money, type Draft, type EventView, type Health } from "../api";
import { Icon } from "../icons";

export function NewEvent({ health, notify, onCreated }: { health: Health | null; notify: (t: string, err?: boolean) => void; onCreated: (v: EventView) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"" | "read" | "create" | "demo">("");
  const [parsed, setParsed] = useState<{ draft: Draft; issues: string[]; by: string; model?: string; note?: string } | null>(null);

  const read = async () => {
    setBusy("read");
    try {
      setParsed(await api.parse(text));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const create = async () => {
    if (!parsed) return;
    setBusy("create");
    try {
      onCreated(await api.create(parsed.draft, text));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };

  const setEmail = (i: number, email: string) => {
    if (!parsed) return;
    const participants = parsed.draft.participants.map((p, n) => (n === i ? { ...p, email } : p));
    setParsed({ ...parsed, draft: { ...parsed.draft, participants } });
  };

  const d = parsed?.draft;
  const cur = d?.currency ?? "USD";
  return (
    <div>
      <p className="eyebrow">New event</p>
      <h1>Tell Purser about the trip</h1>
      <p className="muted" style={{ maxWidth: 700, marginTop: 8 }}>
        Write it the way you would in the group chat: who is coming, what costs what, who already paid for something, which business still has to be
        paid, and any sponsor. {health?.ai.configured ? "Gemini reads it into a budget you can check before anything moves." : "Without a model key, a strict offline reader handles briefs written one cost per line."}
      </p>
      <div className="compose" style={{ marginTop: 22 }}>
        <div className="card">
          <div className="card-b" style={{ paddingTop: 18 }}>
            <label className="f" htmlFor="brief">
              The brief
            </label>
            <textarea
              id="brief"
              className="input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"Cabin weekend, Nov 21-23. Eight of us: Maya (organizer), Jonah, ...\nCabin rental $1,480, non-refundable. Maya already paid it.\n..."}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button className="btn primary" disabled={busy !== "" || text.trim().length < 20} onClick={read}>
                <Icon name="book" /> {busy === "read" ? "Reading..." : "Read the brief"}
              </button>
              <button
                className="btn ghost"
                onClick={async () => {
                  setText((await api.sample()).text);
                  setParsed(null);
                }}
              >
                Use the sample brief
              </button>
              <button
                className="btn ghost"
                disabled={busy !== ""}
                onClick={async () => {
                  setBusy("demo");
                  try {
                    onCreated(await api.demo());
                  } finally {
                    setBusy("");
                  }
                }}
                title="Creates the Cedar Hollow sample event straight away"
              >
                Skip to the demo event <Icon name="arrowRight" />
              </button>
            </div>
          </div>
        </div>

        {!d ? (
          <div>
            <div className="hero-art">
              <img src="/art/cabin.webp" alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
            </div>
            <div className="steps">
              {[
                ["Read", "The brief becomes a ledger: people, costs, who fronted what, vendors and sponsors."],
                ["Ask", "The treasurer agent requests each person's exact share through PayPal, with a personal pay link."],
                ["Check", "Every money move is compared with the ledger and your mandate. Big or unusual ones wait for you."],
                ["Settle", "Payouts reimburse whoever fronted costs and pay vendors; drop-outs are refunded on the rail they paid with."],
              ].map(([t, s], i) => (
                <div className="step" key={t}>
                  <span className="n">{i + 1}</span>
                  <div>
                    <b>{t}.</b> <span className="muted">{s}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-h">
              <div>
                <p className="eyebrow">Draft budget</p>
                <h2>{d.name}</h2>
                <p className="muted" style={{ margin: "2px 0 0" }}>
                  {[d.dateLabel, d.collectBy ? `collect by ${d.collectBy}` : ""].filter(Boolean).join(" · ")} · read by {parsed!.by === "model" ? parsed!.model : "the offline parser"}
                </p>
              </div>
            </div>
            <div className="card-b" style={{ display: "grid", gap: 14 }}>
              {parsed!.note && <p className="muted" style={{ margin: 0, fontSize: 12 }}>{parsed!.note}</p>}
              {parsed!.issues.length > 0 && (
                <div className="issues" role="alert">
                  {parsed!.issues.map((i) => (
                    <div key={i}>{i}</div>
                  ))}
                </div>
              )}
              <div>
                <p className="eyebrow">{d.participants.length} people</p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 6, alignItems: "center" }}>
                  {d.participants.map((p, i) => (
                    <FragmentRow key={p.name} name={p.name} role={p.role} email={p.email ?? ""} onEmail={(e) => setEmail(i, e)} />
                  ))}
                </div>
                <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Emails left blank get a placeholder; payouts go to the email shown here.</p>
              </div>
              <div>
                <p className="eyebrow">Costs</p>
                <ul className="draft-list">
                  {d.items.map((i) => (
                    <li key={i.label}>
                      <span>
                        {i.label}
                        <span className="muted" style={{ fontSize: 12 }}>
                          {" "}
                          · {i.kind === "per_head" ? "each" : "split"}
                          {i.optedIn?.length ? ` · ${i.optedIn.length} opted in` : ""}
                          {i.paidBy ? ` · ${i.paidBy} paid` : i.vendorName ? ` · owed to ${i.vendorName}` : ""}
                          {i.refundable === false ? " · non-refundable" : ""}
                        </span>
                      </span>
                      <b>{money(Math.round(i.amount * 100), cur)}</b>
                    </li>
                  ))}
                  {d.sponsors.map((s) => (
                    <li key={s.name}>
                      <span>
                        {s.name} <span className="muted" style={{ fontSize: 12 }}>· sponsor, invoiced</span>
                      </span>
                      <b style={{ color: "var(--harbor)" }}>&minus;{money(Math.round(s.amount * 100), cur)}</b>
                    </li>
                  ))}
                </ul>
              </div>
              <button className="btn primary" disabled={busy !== "" || parsed!.issues.length > 0} onClick={create}>
                <Icon name="check" /> {busy === "create" ? "Creating..." : "Create the event"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FragmentRow({ name, role, email, onEmail }: { name: string; role?: string; email: string; onEmail: (e: string) => void }) {
  return (
    <>
      <span>
        {name}
        {role && role !== "guest" && <span className="role">{role === "cohost" ? "co-host" : role}</span>}
      </span>
      <input className="input" style={{ padding: "5px 9px", fontSize: 13 }} aria-label={`Email for ${name}`} placeholder="email (optional)" value={email} onChange={(e) => onEmail(e.target.value)} />
    </>
  );
}
