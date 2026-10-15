import { useCallback, useEffect, useRef, useState } from "react";
import { api, money, type EventView, type Health, type TraceStep } from "./api";
import { Icon, PurserMark } from "./icons";
import { NewEvent } from "./components/NewEvent";
import { EventScreen } from "./components/EventScreen";

type Route = { name: "new" } | { name: "event"; id: string } | { name: "home" };

function readRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  if (h === "new") return { name: "new" };
  const m = h.match(/^e\/([a-f0-9]+)/);
  return m ? { name: "event", id: m[1] } : { name: "home" };
}

export type Toast = { text: string; err?: boolean } | null;

export function App() {
  const [route, setRoute] = useState<Route>(readRoute());
  const [health, setHealth] = useState<Health | null>(null);
  const [events, setEvents] = useState<Awaited<ReturnType<typeof api.events>>>([]);
  const [view, setView] = useState<EventView | null>(null);
  const [traces, setTraces] = useState<Record<string, TraceStep[]>>({});
  const [toast, setToast] = useState<Toast>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  const notify = useCallback((text: string, err = false) => {
    setToast({ text, err });
    window.clearTimeout((notify as any).t);
    (notify as any).t = window.setTimeout(() => setToast(null), err ? 6000 : 3200);
  }, []);

  const refreshList = useCallback(() => api.events().then(setEvents).catch(() => undefined), []);
  const refreshView = useCallback((id: string) => api.event(id).then(setView).catch(() => setView(null)), []);

  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener("hashchange", on);
    api.health().then(setHealth).catch(() => undefined);
    refreshList();
    return () => window.removeEventListener("hashchange", on);
  }, [refreshList]);

  useEffect(() => {
    if (route.name === "event") refreshView(route.id);
    else setView(null);
  }, [route, refreshView]);

  // Live updates: PayPal webhooks, approvals and agent steps arrive over SSE.
  useEffect(() => {
    let timer: number | undefined;
    const es = new EventSource("/api/stream");
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const r = routeRef.current;
      if (msg.type === "trace") {
        // A new run starts a fresh trace; later steps append.
        setTraces((t) => ({ ...t, [msg.eventId]: msg.step.kind === "start" ? [msg.step] : [...(t[msg.eventId] ?? []), msg.step] }));
      }
      if (msg.type === "event" || msg.type === "audit") {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          refreshList();
          if (r.name === "event" && r.id === msg.eventId) refreshView(r.id);
        }, 120);
      }
    };
    return () => es.close();
  }, [refreshList, refreshView]);

  const go = (hash: string) => {
    location.hash = hash;
  };

  const startTrace = (id: string) => setTraces((t) => ({ ...t, [id]: [] }));

  return (
    <div className="app">
      <aside className="rail" aria-label="Events">
        <div className="brand">
          <PurserMark />
          <div>
            <b>Purser</b>
            <small>The AI treasurer for group events</small>
          </div>
        </div>
        <button className="btn brass new" onClick={() => go("#/new")}>
          <Icon name="plus" /> New event
        </button>
        <p className="eyebrow">Events</p>
        <nav>
          {events.length === 0 && <p className="muted" style={{ padding: "0 8px", color: "var(--mist)", fontSize: 13 }}>No events yet.</p>}
          {events.map((e) => (
            <button key={e.id} className="rail-item" aria-current={route.name === "event" && route.id === e.id ? "page" : undefined} onClick={() => go(`#/e/${e.id}`)}>
              <span className="t">{e.name}</span>
              <span className="s">
                {e.dateLabel ? `${e.dateLabel} · ` : ""}
                {e.people} people · {money(e.totals.collectedCents - e.totals.refundedCents, e.currency)} in
              </span>
            </button>
          ))}
        </nav>
        <div className="status" aria-label="Connections">
          <span title={health?.paypal.toolkit}>
            <i className={`dot ${health?.paypal.mode === "sandbox" ? "on" : "sim"}`} />
            {health ? (health.paypal.mode === "sandbox" ? "PayPal sandbox, live" : "PayPal contracts, offline fixtures") : "Connecting..."}
          </span>
          <span>
            <i className={`dot ${health?.ai.configured ? "on" : "off"}`} />
            {health?.ai.configured ? `Gemini ${String(health.ai.model).replace("gemini-", "")}` : "No model key: rules engine"}
          </span>
          <span style={{ fontSize: 11 }}>{health?.paypal.toolkit}</span>
        </div>
      </aside>
      <main className="main">
        {route.name === "new" && (
          <NewEvent
            health={health}
            notify={notify}
            onCreated={(v) => {
              refreshList();
              setView(v);
              go(`#/e/${v.event.id}`);
            }}
          />
        )}
        {route.name === "event" && view && view.event.id === route.id && (
          <EventScreen
            view={view}
            health={health}
            trace={traces[route.id] ?? []}
            startTrace={() => startTrace(route.id)}
            setView={setView}
            notify={notify}
            onDeleted={() => {
              refreshList();
              go("#/");
            }}
          />
        )}
        {route.name === "home" && <Home onNew={() => go("#/new")} events={events} open={(id) => go(`#/e/${id}`)} />}
      </main>
      {toast && (
        <div className={`toast${toast.err ? " err" : ""}`} role={toast.err ? "alert" : "status"}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

function Home({ onNew, events, open }: { onNew: () => void; events: { id: string; name: string }[]; open: (id: string) => void }) {
  return (
    <div style={{ maxWidth: 980 }}>
      <p className="eyebrow">Purser</p>
      <h1 style={{ fontSize: 48, maxWidth: 760 }}>Someone always ends up being the treasurer. Let it be an agent you can audit.</h1>
      <p className="muted" style={{ fontSize: 17, maxWidth: 680, marginTop: 14 }}>
        Describe the trip in plain words. Purser turns it into a ledger, asks each person for their exact share through PayPal, pays back whoever fronted
        costs, invoices sponsors and refunds drop-outs. Every money move is checked against the ledger and your mandate before it reaches PayPal.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
        <button className="btn primary" onClick={onNew}>
          <Icon name="plus" /> Start with a brief
        </button>
        {events[0] && (
          <button className="btn ghost" onClick={() => open(events[0].id)}>
            Open {events[0].name} <Icon name="arrowRight" />
          </button>
        )}
      </div>
      <div className="hero-art" style={{ marginTop: 32, aspectRatio: "21 / 9" }}>
        <img src="/art/hero-wide.webp" alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      </div>
    </div>
  );
}
