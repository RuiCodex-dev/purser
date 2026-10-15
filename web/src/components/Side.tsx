import { useEffect, useRef, useState } from "react";
import { api, money, type EventView, type TraceStep } from "../api";
import { Icon, type IconName } from "../icons";

type Common = { view: EventView; setView: (v: EventView) => void; notify: (t: string, err?: boolean) => void };

const PRESETS = [
  "Settle up: request what people owe, invoice the sponsor, and return money owed.",
  "Remind the sponsor about the invoice.",
  "Someone dropped out. Refund what the ledger says and re-request the others.",
];

const VERDICT_LABEL = { allow: "allowed", approval: "needs approval", deny: "denied" } as const;

function stepIcon(s: TraceStep): IconName {
  if (s.kind === "start") return "play";
  if (s.kind === "note") return "message";
  if (s.kind === "done") return "check";
  if (s.kind === "fallback") return "book";
  if (s.kind === "result") return s.outcome?.verdict === "deny" ? "ban" : s.outcome?.verdict === "approval" ? "clock" : "shield";
  if (s.kind === "call") return "send";
  return "pulse";
}

export function Treasurer({ view, trace, startTrace, setView, notify }: Common & { trace: TraceStep[]; startTrace: () => void }) {
  const [instruction, setInstruction] = useState(PRESETS[0]);
  const [running, setRunning] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [trace.length]);

  const run = async () => {
    setRunning(true);
    startTrace();
    try {
      const r = await api.agent(view.event.id, instruction);
      setView(r.view);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setRunning(false);
    }
  };

  const shown = trace.filter((s) => s.kind !== "call");
  const note = [...trace].reverse().find((s) => s.kind === "note")?.text;
  return (
    <section className="card treasurer" aria-labelledby="tr-h">
      <div className="card-h">
        <div>
          <p className="eyebrow">Treasurer agent</p>
          <h2 id="tr-h">Ask Purser to move money</h2>
        </div>
      </div>
      <div className="card-b">
        <label className="sr" htmlFor="instr">
          Instruction
        </label>
        <textarea id="instr" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p} className="preset" onClick={() => setInstruction(p)}>
              {p.split(":")[0].split(".")[0]}
            </button>
          ))}
        </div>
        <button className="btn brass" style={{ width: "100%" }} disabled={running || !instruction.trim()} onClick={run}>
          <Icon name="play" /> {running ? "Working through PayPal..." : "Run the treasurer"}
        </button>
        <ol className="trace" ref={list} aria-live="polite" aria-label="What the treasurer did">
          {shown.length === 0 && <li className="empty-trace" style={{ background: "none", display: "block" }}>Each PayPal call the agent makes shows up here with the mandate's verdict.</li>}
          {shown.map((s, i) => (
            <li key={i} className={s.kind === "note" ? "note" : ""}>
              <span className="ic">
                <Icon name={stepIcon(s)} />
              </span>
              <div>
                {s.kind === "result" && s.outcome ? (
                  <>
                    <div className="what">
                      <span className={`chip ${s.outcome.verdict}`}>{VERDICT_LABEL[s.outcome.verdict]}</span>
                      {s.outcome.subject}
                      {s.outcome.amountCents ? ` · ${money(s.outcome.amountCents, view.event.currency)}` : ""}
                    </div>
                    <div className="why">
                      <code style={{ background: "none", padding: 0, color: "#C9A35A" }}>{s.tool}</code> · {s.outcome.reasons.join("; ")}
                      {s.outcome.executed && s.outcome.ok === false ? ` · PayPal error: ${s.outcome.summary.replace(/^PayPal error on \w+: /, "")}` : ""}
                    </div>
                    {s.outcome.paypalId && <div className="pid">{s.outcome.paypalId}</div>}
                  </>
                ) : (
                  <div className={s.kind === "note" ? "what" : "why"} style={s.kind === "start" ? { color: "#F3EFE6" } : undefined}>
                    {s.kind === "start" ? `"${s.text}"` : s.text}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        {note && !running && (
          <button className="btn dark-ghost small" style={{ marginTop: 10 }} onClick={() => navigator.clipboard?.writeText(note).then(() => notify("Note copied for the group chat"))}>
            <Icon name="copy" /> Copy the note for the group chat
          </button>
        )}
      </div>
    </section>
  );
}

export function Approvals({ view, setView, notify }: Common) {
  const ev = view.event;
  const pending = ev.approvals.filter((a) => a.status === "pending");
  const recent = ev.approvals.filter((a) => a.status !== "pending").slice(-3).reverse();
  const [busy, setBusy] = useState("");
  const decide = async (id: string, decision: "approve" | "reject") => {
    setBusy(id);
    try {
      const r = await api.decide(ev.id, id, decision);
      setView(r.view);
      if (r.outcome) notify(r.outcome.executed && r.outcome.ok ? `${r.outcome.subject}: sent to PayPal` : r.outcome.summary, !(r.outcome.executed && r.outcome.ok));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="card" aria-labelledby="ap-h">
      <div className="card-h">
        <div>
          <p className="eyebrow">Approval inbox</p>
          <h2 id="ap-h">{pending.length ? `${pending.length} waiting for you` : "Nothing to approve"}</h2>
        </div>
        <Icon name="inbox" size={20} />
      </div>
      <div className="card-b">
        {pending.length === 0 && <p className="muted" style={{ margin: 0 }}>Anything outside the mandate lands here instead of going to PayPal.</p>}
        {pending.map((a) => (
          <div className="approval-card" key={a.id}>
            <div className="top">
              <b>{a.subject}</b>
              <span className="amt">{money(a.amountCents, ev.currency)}</span>
            </div>
            <ul>
              {a.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="act">
              <button className="btn harbor small" disabled={busy === a.id} onClick={() => decide(a.id, "approve")}>
                <Icon name="check" /> Approve and pay
              </button>
              <button className="btn danger small" disabled={busy === a.id} onClick={() => decide(a.id, "reject")}>
                <Icon name="x" /> Reject
              </button>
            </div>
          </div>
        ))}
        {view.waiting.length > 0 && (
          <div className="waiting-list">
            <p className="eyebrow" style={{ marginBottom: 4 }}>Waiting for money to arrive</p>
            {view.waiting.map((w) => (
              <div key={w.who}>
                <span>
                  {w.kind === "payout_vendor" ? "Pay" : "Reimburse"} {w.who}
                </span>
                <b>{money(w.amountCents, ev.currency)}</b>
              </div>
            ))}
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
              The pot holds {money(view.ledger.totals.potCents, ev.currency)}. Payouts never spend money that has not been collected.
            </p>
          </div>
        )}
        {recent.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12 }} className="muted">
            {recent.map((a) => (
              <div key={a.id}>
                {a.subject} · {money(a.amountCents, ev.currency)} · <b>{a.status}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function Mandate({ view, setView, notify }: Common) {
  const m = view.event.mandate;
  const [maxPayout, setMaxPayout] = useState(String(m.maxPayoutCents / 100));
  const [maxRefund, setMaxRefund] = useState(String(m.maxRefundCents / 100));
  const [auto, setAuto] = useState(m.autoPayVendors);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setMaxPayout(String(m.maxPayoutCents / 100));
    setMaxRefund(String(m.maxRefundCents / 100));
    setAuto(m.autoPayVendors);
  }, [m.maxPayoutCents, m.maxRefundCents, m.autoPayVendors]);
  return (
    <section className="card" aria-labelledby="md-h">
      <div className="card-h">
        <div>
          <p className="eyebrow">Mandate</p>
          <h2 id="md-h">What the agent may do alone</h2>
        </div>
        <Icon name="shield" size={20} />
      </div>
      <div className="card-b">
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
          Always enforced: amounts must match the ledger to the cent, money only goes to people and vendors the ledger owes, and payouts never exceed what was collected.
        </p>
        <form
          className="mandate"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            try {
              setView(await api.mandate(view.event.id, { maxPayout: Number(maxPayout), maxRefund: Number(maxRefund), autoPayVendors: auto }));
              notify("Mandate saved");
            } catch (err) {
              notify((err as Error).message, true);
            } finally {
              setSaving(false);
            }
          }}
        >
          <label className="f">
            Payouts above ({view.event.currency}) need approval
            <input className="input" inputMode="decimal" value={maxPayout} onChange={(e) => setMaxPayout(e.target.value)} />
          </label>
          <label className="f">
            Refunds above ({view.event.currency}) need approval
            <input className="input" inputMode="decimal" value={maxRefund} onChange={(e) => setMaxRefund(e.target.value)} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Pay listed vendors without asking me
          </label>
          <button className="btn ghost small" disabled={saving} style={{ gridColumn: "1 / -1", justifySelf: "start" }}>
            {saving ? "Saving..." : "Save mandate"}
          </button>
        </form>
      </div>
    </section>
  );
}

export function Nudges({ view, notify }: { view: EventView; notify: (t: string, err?: boolean) => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.nudges>> | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="card" aria-labelledby="ng-h">
      <div className="card-h">
        <div>
          <p className="eyebrow">Reminders</p>
          <h2 id="ng-h">Nudge whoever has not paid</h2>
        </div>
        <Icon name="message" size={20} />
      </div>
      <div className="card-b">
        <button
          className="btn ghost small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setItems(await api.nudges(view.event.id));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Drafting..." : "Draft reminders"}
        </button>
        {items && items.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>Nobody owes anything right now.</p>}
        {items?.map((n) => (
          <div className="nudge" key={n.participantId}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <b>
                {n.name} · {n.amount}
              </b>
              <button className="icon-btn" aria-label={`Copy the reminder for ${n.name}`} onClick={() => navigator.clipboard?.writeText(n.message).then(() => notify(`Reminder for ${n.name} copied`))}>
                <Icon name="copy" />
              </button>
            </div>
            <p>{n.message}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function AddCost({ view, setView, notify, aiOn }: Common & { aiOn: boolean }) {
  const ev = view.event;
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("shared");
  const [paidBy, setPaidBy] = useState("");
  const [source, setSource] = useState<"manual" | "receipt">("manual");
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const read = async (f: File) => {
    if (!aiOn) return notify("Reading receipts needs a Gemini key. Enter the cost by hand.", true);
    setReading(true);
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(f);
      });
      const r = await api.receipt(ev.id, f.type, data);
      if (!r.ok || !r.receipt) throw new Error(r.error ?? "Could not read the receipt");
      setLabel(`${r.receipt.merchant}${r.receipt.lines.length ? ` (${r.receipt.lines.slice(0, 3).map((l) => l.label.toLowerCase()).join(", ")}${r.receipt.lines.length > 3 ? "..." : ""})` : ""}`.slice(0, 120));
      setAmount(String(r.receipt.total));
      setSource("receipt");
      notify(`Read ${r.receipt.merchant}: ${money(Math.round(r.receipt.total * 100), r.receipt.currency)}. Check it, choose who paid, then add.`);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setReading(false);
    }
  };

  return (
    <div style={{ padding: 18, borderTop: "1px solid var(--rule)", display: "grid", gap: 12 }}>
      <div
        className={`drop${over ? " over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => file.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && file.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) read(f);
        }}
      >
        <Icon name="receipt" size={22} />
        <div>
          <b style={{ color: "var(--ink)" }}>{reading ? "Reading the receipt..." : "Drop a receipt photo"}</b>
          <div style={{ fontSize: 12 }}>{aiOn ? "Gemini reads the merchant and total; you confirm who paid." : "Needs a Gemini key; you can still add costs by hand below."}</div>
        </div>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
      </div>
      <form
        className="add-cost"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setView(await api.addItem(ev.id, { label, amount: Number(amount), kind, paidById: paidBy || undefined, source }));
            notify(`Added ${label}. The ledger was recomputed; ask the treasurer to settle the difference.`);
            setLabel("");
            setAmount("");
            setPaidBy("");
            setSource("manual");
          } catch (err) {
            notify((err as Error).message, true);
          }
        }}
      >
        <label className="f">
          Cost
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Firewood and ice" required />
        </label>
        <label className="f">
          Amount ({ev.currency})
          <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="48.20" required />
        </label>
        <label className="f">
          Priced
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="shared">Split</option>
            <option value="per_head">Each</option>
          </select>
        </label>
        <label className="f">
          Paid by
          <select className="input" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            <option value="">Nobody yet (pot pays)</option>
            {ev.participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary">
          <Icon name="plus" /> Add
        </button>
      </form>
    </div>
  );
}
