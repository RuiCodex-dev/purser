import { useCallback, useRef, useState } from "react";
import { api, money, type EventView, type Health, type TraceStep } from "../api";
import { Icon } from "../icons";
import { ActivityGrid, CostsGrid, LedgerGrid, PayPalGrid, type LedgerGridHandle } from "./Grids";
import { AddCost, Approvals, Mandate, Nudges, Treasurer } from "./Side";

type Tab = "costs" | "paypal" | "activity";

export function EventScreen(props: {
  view: EventView;
  health: Health | null;
  trace: TraceStep[];
  startTrace: () => void;
  setView: (v: EventView) => void;
  notify: (t: string, err?: boolean) => void;
  onDeleted: () => void;
}) {
  const { view, setView, notify } = props;
  const ev = view.event;
  const t = view.ledger.totals;
  const cur = ev.currency;
  const grid = useRef<LedgerGridHandle>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ text: string; by: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const [tab, setTab] = useState<Tab>("paypal");
  const [quick, setQuick] = useState("");
  const [reconciling, setReconciling] = useState(false);

  const ask = async (q: string) => {
    setQuestion(q);
    setAsking(true);
    try {
      const r = await api.ask(ev.id, q);
      const n = (await grid.current?.apply(r.filterModel, r.sortModel)) ?? 0;
      const count = Object.keys(r.filterModel).length ? ` ${n === 0 ? "Nobody matches right now." : `${n} ${n === 1 ? "person matches" : "people match"}.`}` : "";
      setAnswer({ text: r.explanation + count, by: r.by });
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setAsking(false);
    }
  };

  const copyLink = useCallback(
    (pid: string) => {
      navigator.clipboard?.writeText(view.payLinks[pid]).then(
        () => notify(`Pay link for ${ev.participants.find((p) => p.id === pid)?.name} copied`),
        () => notify(view.payLinks[pid]),
      );
    },
    [view, notify, ev.participants],
  );

  const toggleDrop = useCallback(
    async (pid: string, rejoin: boolean) => {
      const name = ev.participants.find((p) => p.id === pid)?.name;
      try {
        setView(await api.drop(ev.id, pid, rejoin));
        notify(rejoin ? `${name} is back in` : `${name} dropped out. Shares of refundable costs moved to the others; ask the treasurer to settle.`);
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [ev, setView, notify],
  );

  const removeItem = useCallback(
    async (itemId: string) => {
      try {
        setView(await api.removeItem(ev.id, itemId));
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [ev.id, setView, notify],
  );

  const collectedNet = t.collectedCents - t.refundedCents;
  const target = collectedNet + t.outstandingCents;
  const stillOwing = view.ledger.rows.filter((r) => r.positionCents > 0).length;
  const sponsor = ev.sponsors[0];
  const sponsorInv = sponsor && ev.invoices.filter((i) => i.sponsorId === sponsor.id).at(-1);
  const pending = ev.approvals.filter((a) => a.status === "pending");

  return (
    <div>
      <div className="head">
        <div>
          <p className="eyebrow">Group event</p>
          <h1>{ev.name}</h1>
          <div className="meta">
            {ev.dateLabel && <span>{ev.dateLabel}</span>}
            <span>
              <Icon name="users" /> {ev.participants.filter((p) => p.status === "active").length} people
            </span>
            {ev.collectBy && <span>Collect by {ev.collectBy}</span>}
            <span>{cur}</span>
          </div>
        </div>
        <div className="actions">
          <button
            className="btn ghost"
            disabled={reconciling}
            onClick={async () => {
              setReconciling(true);
              try {
                const r = await api.reconcile(ev.id);
                setView(r.view);
                notify(r.changes ? `Reconciled: ${r.changes} change(s) pulled from PayPal` : "Reconciled: the ledger matches PayPal");
              } catch (e) {
                notify((e as Error).message, true);
              } finally {
                setReconciling(false);
              }
            }}
          >
            <Icon name="refresh" /> {reconciling ? "Checking PayPal..." : "Reconcile with PayPal"}
          </button>
          <button
            className="btn ghost"
            title="Delete this event"
            aria-label="Delete this event"
            onClick={async () => {
              if (!confirm(`Delete ${ev.name}? This only removes it from Purser; nothing changes in PayPal.`)) return;
              await api.remove(ev.id);
              props.onDeleted();
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      <section className="kpis" aria-label="Totals">
        <div className="card kpi">
          <p className="eyebrow">Collected</p>
          <div className="v">{money(collectedNet, cur)}</div>
          <div className="s">of {money(target, cur)} to collect</div>
          <div className="bar" aria-hidden="true">
            <i style={{ width: `${target ? Math.min(100, (collectedNet / target) * 100) : 0}%` }} />
          </div>
        </div>
        <div className="card kpi">
          <p className="eyebrow">Still owed to the pot</p>
          <div className="v" style={{ color: t.outstandingCents ? "var(--signal)" : undefined }}>{money(t.outstandingCents, cur)}</div>
          <div className="s">{stillOwing ? `${stillOwing} ${stillOwing === 1 ? "person" : "people"} still to pay` : "Everyone has paid"}</div>
        </div>
        <div className="card kpi">
          <p className="eyebrow">Owed out</p>
          <div className="v">{money(t.owedOutCents, cur)}</div>
          <div className="s">
            reimbursements, refunds and vendors{pending.length ? ` · ${pending.length} waiting for you` : ""}
          </div>
        </div>
        <div className="card kpi">
          <p className="eyebrow">In the pot</p>
          <div className="v">{money(t.potCents, cur)}</div>
          <div className="s">
            {money(t.paidOutCents, cur)} paid out
            {sponsor ? ` · ${sponsor.name}: ${sponsorInv ? sponsorInv.status.toLowerCase() : "not invoiced"}` : ""}
          </div>
        </div>
      </section>

      <div className="layout">
        <div className="stack">
          <section className="card" aria-labelledby="ledger-h">
            <div className="card-h">
              <div>
                <p className="eyebrow">The ledger</p>
                <h2 id="ledger-h">Who owes what</h2>
              </div>
              <span className="muted" style={{ fontSize: 12 }}>Computed from the costs; PayPal updates it live</span>
            </div>
            <form
              className="ask"
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim()) ask(question.trim());
              }}
            >
              <label className="search">
                <span className="sr">Ask the ledger</span>
                <Icon name="search" />
                <input className="input" placeholder="Ask the ledger, e.g. who still owes more than $250?" value={question} onChange={(e) => setQuestion(e.target.value)} />
              </label>
              <button className="btn primary" disabled={asking || !question.trim()} type="submit">
                {asking ? "Asking..." : "Ask"}
              </button>
              <div className="examples">
                {["Who still owes money?", "Who is the pot paying back?", "Owes more than $250, largest first"].map((q) => (
                  <button type="button" key={q} className="example" onClick={() => ask(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </form>
            {answer && (
              <div className="answer" role="status">
                <span>
                  {answer.text} <span style={{ opacity: 0.75 }}>({answer.by === "model" ? "Gemini set the grid filter" : "keyword rules set the grid filter"})</span>
                </span>
                <button
                  className="btn small ghost"
                  onClick={() => {
                    grid.current?.clear();
                    setAnswer(null);
                    setQuestion("");
                  }}
                >
                  Clear
                </button>
              </div>
            )}
            <LedgerGrid ref={grid} view={view} copyLink={copyLink} toggleDrop={toggleDrop} />
          </section>

          <section className="card" aria-label="Details">
            <div className="tabs" role="tablist">
              {(
                [
                  ["paypal", "PayPal objects", ev.orders.length + ev.payouts.length + ev.refunds.length + ev.invoices.length],
                  ["costs", "Costs", ev.items.length],
                  ["activity", "Activity log", ev.audit.length],
                ] as const
              ).map(([k, label, n]) => (
                <button key={k} role="tab" aria-selected={tab === k} className="tab" onClick={() => setTab(k)}>
                  {label} <span className="count">{n}</span>
                </button>
              ))}
              {tab === "activity" && (
                <input className="input" style={{ marginLeft: "auto", width: 220, alignSelf: "center", padding: "5px 10px" }} placeholder="Filter the log" aria-label="Filter the activity log" value={quick} onChange={(e) => setQuick(e.target.value)} />
              )}
            </div>
            {tab === "paypal" && <PayPalGrid view={view} />}
            {tab === "costs" && (
              <>
                <CostsGrid view={view} remove={removeItem} />
                <AddCost view={view} setView={setView} notify={notify} aiOn={Boolean(props.health?.ai.configured)} />
              </>
            )}
            {tab === "activity" && <ActivityGrid view={view} quick={quick} />}
          </section>
        </div>

        <div className="stack">
          <Treasurer view={view} trace={props.trace} startTrace={props.startTrace} setView={setView} notify={notify} />
          <Approvals view={view} setView={setView} notify={notify} />
          <Mandate view={view} setView={setView} notify={notify} />
          <Nudges view={view} notify={notify} />
        </div>
      </div>
    </div>
  );
}
