// Money: what's owed, what's late, the GST meter, problems worth a look, and every invoice.

import { useMemo, useState } from "react";

import { ErrorNote, GstMeterCard, Loading, StatusChip, useLoad } from "../components/bits";
import { Icon } from "../components/icons";
import type { InvoiceSummary, Overview } from "../lib/api";
import { aud, shortDate } from "../lib/format";
import { linkProps, navigate } from "../lib/router";

const FILTERS = [
  { id: "owed", label: "Owed" },
  { id: "drafts", label: "Drafts" },
  { id: "paid", label: "Paid" },
  { id: "all", label: "All" },
] as const;

export function MoneyPage() {
  const overview = useLoad<Overview>("/ogdoad/money/overview");
  const invoices = useLoad<InvoiceSummary[]>("/ogdoad/money/invoices");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("owed");

  const shown = useMemo(() => {
    const all = invoices.data ?? [];
    if (filter === "owed") return all.filter((i) => i.balanceCents > 0);
    if (filter === "drafts") return all.filter((i) => i.status === "draft");
    if (filter === "paid") return all.filter((i) => i.bucket === "paid");
    return all;
  }, [invoices.data, filter]);

  if (overview.error) return <ErrorNote error={overview.error} retry={overview.reload} />;
  if (!overview.data) return <Loading what="Loading Money" />;
  const o = overview.data;
  const owed = Object.values(o.ageing).reduce((a, b) => a + b.cents, 0);
  const late = o.ageing["1-30"].cents + o.ageing["31-60"].cents + o.ageing["61-90"].cents + o.ageing["90+"].cents;
  const lateCount = o.ageing["1-30"].count + o.ageing["31-60"].count + o.ageing["61-90"].count + o.ageing["90+"].count;
  const setupMissing = !o.settings.abn || !o.settings.businessName || !o.accounts.length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Money</h1>
          <p>Invoices, payments and the GST threshold. Everything here stays on this machine.</p>
        </div>
        <button className="btn primary" onClick={() => navigate("/money/invoices/new")}><Icon name="plus" /> New invoice</button>
      </header>

      {setupMissing ? (
        <div className="notice warn enter">
          <span style={{ flex: 1 }}>Before your first invoice: add the business name, ABN and the account you're paid into.</span>
          <a className="btn small" {...linkProps("/settings")}>Open settings</a>
        </div>
      ) : null}

      {o.findings.map((f, i) => (
        <div key={i} className="notice bad enter">
          <span style={{ flex: 1 }}>{f.message}</span>
          {f.invoiceIds.map((id) => <a key={id} className="btn small" {...linkProps(`/money/invoices/${id}`)}>Open</a>)}
        </div>
      ))}

      <div className="grid fit">
        <section className="card stack" aria-label="Owed to you">
          <div className="row"><h2>Owed to you</h2><span className="spacer" /><span className="live" style={{ color: "var(--good)" }} /></div>
          <div className="stat"><span className="big">{aud(owed)}</span><span className="muted">{o.counts.owed} invoice{o.counts.owed === 1 ? "" : "s"} unpaid</span></div>
          <AgeingBars ageing={o.ageing} />
        </section>
        <section className="card stack" aria-label="Late">
          <h2>Late</h2>
          <div className="stat"><span className="big" style={{ color: late ? "var(--bad)" : undefined }}>{aud(late)}</span><span className="muted">{lateCount} past their due date</span></div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Before chasing anything, check the bank: paid status here comes from money actually received.</p>
        </section>
        <GstMeterCard gst={o.gst} />
      </div>

      <section className="card stack" aria-label="Invoices">
        <div className="row">
          <h3>Invoices</h3>
          <span className="spacer" />
          <div className="tabs" role="group" aria-label="Show">
            {FILTERS.map((f) => <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
          </div>
        </div>
        {invoices.error ? <ErrorNote error={invoices.error} retry={invoices.reload} /> : null}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Number</th><th>Client</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">Owing</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => navigate(`/money/invoices/${i.id}`)}>
                  <td className="mono"><a {...linkProps(`/money/invoices/${i.id}`)} onClick={(e) => e.stopPropagation()}>{i.number ?? "Draft"}</a></td>
                  <td>{i.clientName}</td>
                  <td>{shortDate(i.issueDate)}</td>
                  <td>{shortDate(i.dueDate)}</td>
                  <td className="num">{aud(i.totalCents)}</td>
                  <td className="num">{i.balanceCents ? aud(i.balanceCents) : ""}</td>
                  <td><StatusChip bucket={i.bucket} /></td>
                </tr>
              ))}
              {!shown.length ? <tr><td colSpan={7} className="muted">{invoices.data ? "Nothing here." : "Loading…"}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function AgeingBars({ ageing }: { ageing: Overview["ageing"] }) {
  const order = [["current", "Not due", "var(--age0)"], ["1-30", "1–30", "var(--age1)"], ["31-60", "31–60", "var(--age2)"], ["61-90", "61–90", "var(--age3)"], ["90+", "90+", "var(--age4)"]] as const;
  const max = Math.max(1, ...order.map(([k]) => ageing[k].cents));
  return (
    <div className="sheen" style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 96, ["--d" as string]: "4s" }} aria-label="Owed by how late">
      {order.map(([k, label, color]) => (
        <div key={k} style={{ flex: 1, height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 4 }} title={`${label}: ${aud(ageing[k].cents)}`}>
          <div style={{ height: `${Math.round((ageing[k].cents / max) * 70)}%`, minHeight: 4, borderRadius: "7px 7px 3px 3px", background: color, transition: "height 1s cubic-bezier(.2,.7,.2,1)" }} />
          <span className="muted" style={{ fontSize: 11, textAlign: "center" }}>{label}</span>
        </div>
      ))}
    </div>
  );
}
