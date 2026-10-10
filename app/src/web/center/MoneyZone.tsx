// IV. Money: the river. Every invoice is a point of light flowing left to right: drafts at the source,
// owed ones drifting toward their due line and past it (reddening as they go late), paid ones resting
// in the pool. Size is the amount. A payment landing slides its invoice into the pool. Opened, the
// river sits above Money's own rooms: invoices, clients and the bank.

import { AccountantPage } from "../pages/Accountant";
import { BankPage } from "../pages/Bank";
import { ClientPage, ClientsPage } from "../pages/Clients";
import { InvoicePage } from "../pages/Invoice";
import { MoneyPage } from "../pages/Money";
import type { InvoiceSummary } from "../lib/api";
import { aud, BUCKET_LABEL } from "../lib/format";
import { match, navigate, usePath } from "../lib/router";
import { useZoom, Zone } from "./ControlCenter";
import { useCenter } from "./data";

const BUCKET_COLOR: Record<string, string> = { draft: "var(--idle)", current: "var(--c1)", "1-30": "var(--age1)", "31-60": "var(--age2)", "61-90": "var(--age3)", "90+": "var(--age4)", paid: "var(--good)" };
const DUE_X = 56;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function daysSince(iso: string, today: string): number {
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(iso)) / 86_400_000));
}

/** Where an invoice sits on the river, as % across and down. */
function place(inv: InvoiceSummary, today: string, i: number, n: number): { x: number; y: number } {
  const y = 18 + hash(inv.id) * 64;
  if (inv.status === "draft") return { x: 3 + (n > 1 ? (i / (n - 1)) * 9 : 4.5), y };
  if (inv.bucket === "paid") return { x: 82 + hash(`${inv.id}x`) * 15, y };
  if (inv.daysOverdue && inv.daysOverdue > 0) return { x: DUE_X + 1.5 + Math.min(1, inv.daysOverdue / 120) * 19, y };
  const age = inv.issueDate ? daysSince(inv.issueDate, today) : 0;
  const terms = inv.issueDate && inv.dueDate ? Math.max(1, daysSince(inv.issueDate, inv.dueDate)) : 14;
  return { x: 17 + Math.min(1, age / terms) * (DUE_X - 19), y };
}

function River({ tall = false }: { tall?: boolean }) {
  const { invoices, overview } = useCenter();
  const today = overview?.today ?? new Date().toISOString().slice(0, 10);
  const list = invoices ?? [];
  const drafts = list.filter((i) => i.status === "draft");
  const owed = list.filter((i) => i.status === "issued" && i.balanceCents > 0);
  const paid = list.filter((i) => i.bucket === "paid").sort((a, b) => (b.issueDate ?? "").localeCompare(a.issueDate ?? "")).slice(0, 24);
  const shown = [...drafts, ...owed, ...paid];
  const size = (c: number) => Math.max(7, Math.min(16, 4 + Math.sqrt(c / 100) * 0.55));
  const sum = (xs: InvoiceSummary[], f: (i: InvoiceSummary) => number) => xs.reduce((a, i) => a + f(i), 0);
  return (
    <div className="river-wrap">
      <div className={`river${tall ? " tall" : ""}`} role="img" aria-label={`${drafts.length} drafts, ${owed.length} owed, ${paid.length} recently paid`}>
        <span className="river-due" style={{ left: `${DUE_X}%` }}><span>due</span></span>
        {shown.map((inv) => {
          const p = place(inv, today, drafts.indexOf(inv), drafts.length);
          const s = size(inv.status === "draft" ? inv.totalCents : inv.bucket === "paid" ? inv.totalCents : inv.balanceCents);
          return (
            <button key={inv.id} className={`drop${inv.bucket === "paid" ? " paid" : ""}`} onClick={() => navigate(`/money/invoices/${inv.id}`)}
              style={{ left: `${p.x}%`, top: `${p.y}%`, width: s, height: s, background: BUCKET_COLOR[inv.bucket] ?? "var(--c1)" }}
              title={`${inv.number ?? "Draft"} · ${inv.clientName} · ${aud(inv.status === "issued" ? inv.balanceCents : inv.totalCents)} · ${BUCKET_LABEL[inv.bucket]}`}
              aria-label={`${inv.number ?? "Draft"} for ${inv.clientName}, ${BUCKET_LABEL[inv.bucket]}`} />
          );
        })}
      </div>
      <div className="river-legend">
        <span style={{ width: "14%" }}>Draft <b>{drafts.length}</b></span>
        <span style={{ width: "64%" }}>Owed <b>{owed.length}</b> · {aud(sum(owed, (i) => i.balanceCents), { cents: false })}</span>
        <span>Paid <b>{list.filter((i) => i.bucket === "paid").length}</b></span>
      </div>
    </div>
  );
}

function Stats() {
  const { overview } = useCenter();
  if (!overview) return <div className="muted">Reading the books…</div>;
  const owed = Object.values(overview.ageing).reduce((a, b) => a + b.cents, 0);
  const late = overview.ageing["1-30"].cents + overview.ageing["31-60"].cents + overview.ageing["61-90"].cents + overview.ageing["90+"].cents;
  const g = overview.gst;
  const gColor = g.level === "over" || g.level === "near" ? "var(--bad)" : g.level === "watch" ? "var(--warn)" : "var(--c3)";
  return (
    <div className="money-stats">
      <div className="stat"><span className="muted">Owed to you</span><span className="big">{aud(owed, { cents: false })}</span></div>
      <div className="stat"><span className="muted">Late</span><span className="big" style={{ color: late ? "var(--bad)" : undefined }}>{aud(late, { cents: false })}</span></div>
      <div className="stat gst" title="GST turnover over the last 12 months, against the $75,000 threshold">
        <span className="muted">GST threshold · {g.percent}%</span>
        <div className="meter" style={{ height: 8 }}><div style={{ width: `${Math.min(100, g.percent)}%`, background: gColor }} /></div>
      </div>
    </div>
  );
}

const ROOMS = [
  { to: "/money", label: "Invoices" },
  { to: "/money/clients", label: "Clients" },
  { to: "/money/bank", label: "Bank" },
  { to: "/money/accountant", label: "For your accountant" },
];

function MoneyRoom() {
  const path = usePath();
  let params: Record<string, string> | null;
  let page;
  if ((params = match("/money/invoices/:id/chase", path))) page = <InvoicePage key={params.id} id={params.id} chase />;
  else if ((params = match("/money/invoices/:id", path))) page = <InvoicePage key={params.id} id={params.id} />;
  else if ((params = match("/money/clients/:id", path))) page = <ClientPage key={params.id} id={params.id} />;
  else if (path === "/money/clients") page = <ClientsPage />;
  else if (path === "/money/bank") page = <BankPage />;
  else if (path === "/money/accountant") page = <AccountantPage />;
  else page = <MoneyPage />;
  const here = (to: string) => (to === "/money" ? path === "/money" || path.startsWith("/money/invoices") : path.startsWith(to));
  return (
    <>
      <nav className="tabs" aria-label="Money">
        {ROOMS.map((r) => <button key={r.to} aria-pressed={here(r.to)} onClick={() => navigate(r.to)}>{r.label}</button>)}
      </nav>
      <div className="room-page">{page}</div>
    </>
  );
}

export function MoneyZone() {
  const open = useZoom() === "money";
  const { overview } = useCenter();
  const chip = overview?.bankToReview ? <button className="chip warn-chip" onClick={() => navigate("/money/bank")}>{overview.bankToReview} to confirm</button> : <span className="live" style={{ color: "var(--good)" }} aria-label="live" />;
  return (
    <Zone id="money" chip={chip}>
      {open ? null : <Stats />}
      <River tall={open} />
      {open ? <MoneyRoom /> : null}
    </Zone>
  );
}
