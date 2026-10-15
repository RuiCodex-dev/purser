import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz, type ColDef, type GridApi, type ICellRendererParams } from "ag-grid-community";
import { money, type EventView } from "../api";
import { Icon } from "../icons";

export const gridTheme = themeQuartz.withParams({
  fontFamily: "IBM Plex Sans, system-ui, sans-serif",
  fontSize: 13,
  foregroundColor: "#13212E",
  backgroundColor: "#FFFDF8",
  headerBackgroundColor: "#F6F2EA",
  headerTextColor: "#56616B",
  headerFontWeight: 600,
  headerFontSize: 12,
  borderColor: "#E9E3D7",
  rowBorder: { style: "dashed", width: 1, color: "#E2DBCC" },
  accentColor: "#A87A2C",
  rowHoverColor: "#F7F2E8",
  selectedRowBackgroundColor: "#F3E9D3",
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  spacing: 7,
  cellHorizontalPadding: 14,
});

const usd = (cur: string) => (p: { value: number | null | undefined }) => (p.value === null || p.value === undefined ? "" : money(Math.round(p.value * 100), cur));

const STATE_CLASS: Record<string, string> = {
  settled: "settled",
  owes: "owes",
  "awaiting payer": "waiting",
  "owed refund": "waiting",
  "owed reimbursement": "waiting",
  "nothing due": "neutral",
};

function Person(p: ICellRendererParams) {
  if (p.node.rowPinned) return <b>{p.value}</b>;
  const d = p.data;
  return (
    <span className="cell-person">
      <span className={d.status === "dropped" ? "dropped" : ""}>{p.value}</span>
      {d.role !== "guest" && <span className="role">{d.role === "cohost" ? "co-host" : "organizer"}</span>}
      {d.status === "dropped" && <span className="role" style={{ color: "var(--signal)" }}>dropped out</span>}
    </span>
  );
}

function Position(p: ICellRendererParams) {
  const v = Number(p.value ?? 0);
  const cur = p.context.currency;
  if (p.node.rowPinned) return <b>{money(Math.round(v * 100), cur)}</b>;
  if (v > 0) return <span className="pos-owes">owes {money(Math.round(v * 100), cur)}</span>;
  if (v < 0) return <span className="pos-owed">owed {money(Math.round(-v * 100), cur)}</span>;
  return <span className="pos-square">square</span>;
}

function StateChip(p: ICellRendererParams) {
  if (p.node.rowPinned || !p.value) return null;
  return <span className={`chip ${STATE_CLASS[p.value] ?? "neutral"}`}>{p.value}</span>;
}

function Actions(p: ICellRendererParams) {
  if (p.node.rowPinned) return null;
  const d = p.data;
  return (
    <div className="row-actions">
      <button className="icon-btn" title={`Copy ${d.name}'s pay link`} aria-label={`Copy ${d.name}'s pay link`} onClick={() => p.context.copyLink(d.id)}>
        <Icon name="link" />
      </button>
      <a className="icon-btn" title={`Open ${d.name}'s pay page`} aria-label={`Open ${d.name}'s pay page`} href={p.context.links[d.id]} target="_blank" rel="noreferrer">
        <Icon name="external" />
      </a>
      <button
        className="icon-btn"
        title={d.status === "dropped" ? `${d.name} rejoins` : `${d.name} drops out`}
        aria-label={d.status === "dropped" ? `${d.name} rejoins` : `${d.name} drops out`}
        onClick={() => p.context.toggleDrop(d.id, d.status === "dropped")}
      >
        <Icon name={d.status === "dropped" ? "userPlus" : "userMinus"} />
      </button>
    </div>
  );
}

export interface LedgerGridHandle {
  /** Applies a filter and sort, resolves with how many people match. */
  apply(filterModel: Record<string, unknown>, sortModel: { colId: string; sort: "asc" | "desc" }[]): Promise<number>;
  clear(): void;
}

export const LedgerGrid = forwardRef<LedgerGridHandle, { view: EventView; copyLink: (pid: string) => void; toggleDrop: (pid: string, rejoin: boolean) => void }>(function LedgerGrid({ view, copyLink, toggleDrop }, ref) {
  const apiRef = useRef<GridApi | null>(null);
  const [filtered, setFiltered] = useState(false);
  const cur = view.event.currency;
  const rows = useMemo(
    () =>
      view.ledger.rows.map((r) => ({
        id: r.participantId,
        name: r.name,
        role: r.role,
        status: r.status,
        share: r.shareCents / 100,
        fronted: r.frontedCents / 100,
        credit: r.sponsorCreditCents / 100,
        paid: (r.capturedCents - r.refundedCents) / 100,
        received: r.payoutCents / 100,
        position: r.positionCents / 100,
        credits: (r.frontedCents + r.sponsorCreditCents) / 100,
        state: r.state,
        order: r.openOrder ?? view.event.orders.filter((o) => o.participantId === r.participantId && o.status === "COMPLETED").at(-1),
      })),
    [view],
  );
  const total = useMemo(() => {
    const s = (k: keyof (typeof rows)[number]) => rows.reduce((a, r) => a + Number(r[k]), 0);
    return [{ id: "total", name: "Total", share: s("share"), credits: s("credits"), fronted: s("fronted"), credit: s("credit"), paid: s("paid"), received: s("received"), position: s("position") }];
  }, [rows]);
  const cols = useMemo<ColDef[]>(
    () => [
      { field: "name", headerName: "Person", cellRenderer: Person, filter: "agTextColumnFilter", minWidth: 136, flex: 1.4 },
      { field: "role", hide: true, filter: "agTextColumnFilter" },
      { field: "status", hide: true, filter: "agTextColumnFilter" },
      { field: "share", headerName: "Share", valueFormatter: usd(cur), type: "numericColumn", filter: "agNumberColumnFilter", enableCellChangeFlash: true, minWidth: 90, flex: 1 },
      {
        field: "credits",
        headerName: "Credits",
        valueFormatter: usd(cur),
        type: "numericColumn",
        minWidth: 90,
        flex: 1,
        tooltipValueGetter: (p) => (p.data?.id === "total" ? "" : `Fronted ${money(Math.round(p.data.fronted * 100), cur)} + sponsor ${money(Math.round(p.data.credit * 100), cur)}`),
      },
      { field: "fronted", hide: true, filter: "agNumberColumnFilter" },
      { field: "paid", headerName: "Paid in", valueFormatter: usd(cur), type: "numericColumn", filter: "agNumberColumnFilter", enableCellChangeFlash: true, minWidth: 88, flex: 1 },
      { field: "received", headerName: "Paid out", valueFormatter: usd(cur), type: "numericColumn", enableCellChangeFlash: true, minWidth: 88, flex: 1 },
      { field: "position", headerName: "Position", cellRenderer: Position, type: "numericColumn", filter: "agNumberColumnFilter", enableCellChangeFlash: true, minWidth: 122, flex: 1.2 },
      { field: "state", headerName: "State", cellRenderer: StateChip, filter: "agTextColumnFilter", minWidth: 138, flex: 1.3, enableCellChangeFlash: true, tooltipValueGetter: (p) => (p.data?.order ? `PayPal order ${p.data.order.id}: ${p.data.order.status}` : "") },
      { colId: "actions", headerName: "", cellRenderer: Actions, width: 100, sortable: false, resizable: false },
    ],
    [cur],
  );
  useImperativeHandle(ref, () => ({
    apply(filterModel, sortModel) {
      const api = apiRef.current;
      if (!api) return Promise.resolve(0);
      api.setFilterModel(filterModel);
      api.applyColumnState({ state: sortModel.map((s) => ({ colId: s.colId, sort: s.sort })), defaultState: { sort: null } });
      setFiltered(Object.keys(filterModel).length > 0);
      return new Promise((r) => setTimeout(() => r(api.getDisplayedRowCount()), 50));
    },
    clear() {
      apiRef.current?.setFilterModel(null);
      apiRef.current?.applyColumnState({ defaultState: { sort: null } });
      setFiltered(false);
    },
  }));
  return (
    <div className="grid">
      <AgGridReact
        theme={gridTheme}
        rowData={rows}
        columnDefs={cols}
        pinnedBottomRowData={filtered ? [] : total}
        getRowId={(p) => p.data.id}
        defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }}
        context={{ currency: cur, copyLink, toggleDrop, links: view.payLinks }}
        onGridReady={(e) => (apiRef.current = e.api)}
        animateRows
        rowHeight={44}
        headerHeight={38}
        getRowStyle={(p) => (p.data?.status === "dropped" ? { background: "#FAF6EE" } : undefined)}
        overlayNoRowsTemplate="<span class='muted'>Nobody matches that question.</span>"
      />
    </div>
  );
});

export function CostsGrid({ view, remove }: { view: EventView; remove: (itemId: string) => void }) {
  const ev = view.event;
  const cur = ev.currency;
  const name = (id?: string) => ev.participants.find((p) => p.id === id)?.name;
  const rows = useMemo(
    () =>
      ev.items.map((i) => {
        const carriers = (i.optedIn ? ev.participants.filter((p) => i.optedIn!.includes(p.id)) : ev.participants).filter((p) => p.status === "active" || !i.refundable);
        return {
          id: i.id,
          label: i.label,
          kind: i.kind === "per_head" ? "each" : "split",
          amount: i.amountCents / 100,
          total: (i.kind === "per_head" ? i.amountCents * carriers.length : i.amountCents) / 100,
          who: i.optedIn ? carriers.map((p) => p.name).join(", ") : `Everyone (${carriers.length})`,
          paid: i.paidById ? `${name(i.paidById)} fronted it` : i.vendor ? `Owed to ${i.vendor.name}` : "Kept in the pot",
          refundable: i.refundable ? "refundable" : "non-refundable",
          source: i.source,
        };
      }),
    [view],
  );
  const cols = useMemo<ColDef[]>(
    () => [
      { field: "label", headerName: "Cost", flex: 1.4, minWidth: 170 },
      { field: "kind", headerName: "Priced", width: 90 },
      { field: "amount", headerName: "Amount", valueFormatter: usd(cur), type: "numericColumn", width: 110 },
      { field: "total", headerName: "Total", valueFormatter: usd(cur), type: "numericColumn", width: 110 },
      { field: "who", headerName: "Carried by", flex: 1.2, minWidth: 150, tooltipField: "who" },
      { field: "paid", headerName: "Paid how", flex: 1, minWidth: 160 },
      { field: "refundable", headerName: "On drop-out", width: 130, cellRenderer: (p: ICellRendererParams) => <span className={`chip ${p.value === "refundable" ? "neutral" : "waiting"}`}>{p.value}</span> },
      { field: "source", headerName: "From", width: 100, cellRenderer: (p: ICellRendererParams) => <span className="chip neutral">{p.value}</span> },
      {
        colId: "x",
        headerName: "",
        width: 56,
        sortable: false,
        cellRenderer: (p: ICellRendererParams) => (
          <button className="icon-btn" aria-label={`Remove ${p.data.label}`} title="Remove this cost" onClick={() => remove(p.data.id)}>
            <Icon name="trash" />
          </button>
        ),
      },
    ],
    [cur, remove],
  );
  return (
    <div className="grid short">
      <AgGridReact theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.id} defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }} rowHeight={42} headerHeight={38} />
    </div>
  );
}

export function PayPalGrid({ view }: { view: EventView }) {
  const ev = view.event;
  const cur = ev.currency;
  const who = (pid?: string) => ev.participants.find((p) => p.id === pid)?.name ?? "";
  const rows = useMemo(() => {
    const out: any[] = [];
    for (const o of ev.orders) {
      out.push({ id: `o-${o.id}`, type: "Order", api: o.via === "agent-toolkit" ? "Agent Toolkit create_order" : "Orders v2", ref: o.id, party: who(o.participantId), amount: o.amountCents / 100, status: o.status });
      if (o.captureId) out.push({ id: `c-${o.captureId}`, type: "Capture", api: "Orders v2 capture", ref: o.captureId, party: who(o.participantId), amount: o.capturedCents / 100, status: "COMPLETED" });
    }
    for (const r of ev.refunds) out.push({ id: `r-${r.id}`, type: "Refund", api: "Agent Toolkit create_refund", ref: r.id, party: who(r.participantId), amount: -r.amountCents / 100, status: r.status });
    for (const p of ev.payouts) out.push({ id: `p-${p.batchId}`, type: "Payout", api: "Payouts v1", ref: p.itemId ? `${p.batchId} / ${p.itemId}` : p.batchId, party: p.email, amount: -p.amountCents / 100, status: p.status });
    for (const i of ev.invoices) out.push({ id: `i-${i.id}`, type: "Invoice", api: "Agent Toolkit create_invoice", ref: i.id, party: ev.sponsors.find((s) => s.id === i.sponsorId)?.name, amount: i.amountCents / 100, status: i.status + (i.reminders ? ` · ${i.reminders} reminder${i.reminders > 1 ? "s" : ""}` : "") });
    return out;
  }, [view]);
  const cols = useMemo<ColDef[]>(
    () => [
      { field: "type", headerName: "Object", width: 100 },
      { field: "ref", headerName: "PayPal id", flex: 1.2, minWidth: 200, cellClass: "cell-id" },
      { field: "party", headerName: "Party", flex: 1, minWidth: 130 },
      { field: "amount", headerName: "Amount", valueFormatter: usd(cur), type: "numericColumn", width: 120, enableCellChangeFlash: true },
      { field: "status", headerName: "Status", flex: 1, minWidth: 150, enableCellChangeFlash: true },
      { field: "api", headerName: "Through", flex: 1.1, minWidth: 190, cellClass: "muted" },
    ],
    [cur],
  );
  return (
    <div className="grid short">
      <AgGridReact theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.id} defaultColDef={{ sortable: true, resizable: true, filter: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }} rowHeight={40} headerHeight={38} overlayNoRowsTemplate="<span class='muted'>Nothing has moved yet. Ask the treasurer to settle up.</span>" />
    </div>
  );
}

export function ActivityGrid({ view, quick }: { view: EventView; quick: string }) {
  const cur = view.event.currency;
  const rows = useMemo(() => view.event.audit.slice().reverse(), [view]);
  const cols = useMemo<ColDef[]>(
    () => [
      { field: "at", headerName: "When", width: 110, valueFormatter: (p) => new Date(p.value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) },
      { field: "actor", headerName: "Who", width: 110, cellRenderer: (p: ICellRendererParams) => <span className="chip neutral">{p.value}</span> },
      { field: "action", headerName: "What", flex: 1, minWidth: 180 },
      { field: "verdict", headerName: "Mandate", width: 130, cellRenderer: (p: ICellRendererParams) => (p.value ? <span className={`chip ${p.value}`}>{p.value === "allow" ? "allowed" : p.value === "approval" ? "needs approval" : "denied"}</span> : null) },
      { field: "amountCents", headerName: "Amount", width: 110, type: "numericColumn", valueFormatter: (p) => (p.value ? money(p.value, cur) : "") },
      { field: "detail", headerName: "Detail", flex: 2, minWidth: 260, tooltipField: "detail" },
      { field: "paypalId", headerName: "PayPal id", width: 200, cellClass: "cell-id" },
      { field: "debugId", headerName: "Debug id", width: 150, cellClass: "cell-id", hide: false },
    ],
    [cur],
  );
  return (
    <div className="grid">
      <AgGridReact theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.id} quickFilterText={quick} defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true }} rowHeight={40} headerHeight={38} />
    </div>
  );
}
