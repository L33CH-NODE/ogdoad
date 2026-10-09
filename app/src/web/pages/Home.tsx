// Home. Phase 1 keeps it simple: what needs you now, at the top, and the money squares below. The
// full version (SOPHIA's ranked banner, agent-made dashboard squares) comes in phase 3.

import { ErrorNote, GstMeterCard, Loading, useLoad } from "../components/bits";
import type { Overview } from "../lib/api";
import { aud } from "../lib/format";
import { useTeam } from "../lib/horos";
import { linkProps } from "../lib/router";

export function HomePage() {
  const overview = useLoad<Overview>("/ogdoad/money/overview");
  const team = useTeam();
  if (overview.error) return <ErrorNote error={overview.error} retry={overview.reload} />;
  if (!overview.data) return <Loading />;
  const o = overview.data;
  const lateCount = o.ageing["1-30"].count + o.ageing["31-60"].count + o.ageing["61-90"].count + o.ageing["90+"].count;
  const owed = Object.values(o.ageing).reduce((a, b) => a + b.cents, 0);

  // What's waiting on the operator, most unblocking first.
  const needs: Array<{ text: string; to?: string; tone: "bad" | "warn" | "" }> = [];
  for (const h of team.filter((t) => t.state === "blocked")) needs.push({ text: `${h.label.replace(/ - .*$/, "")} is waiting on a decision.`, tone: "warn" });
  for (const f of o.findings) needs.push({ text: f.message, to: `/money/invoices/${f.invoiceIds[0]}`, tone: "bad" });
  if (!o.settings.abn || !o.accounts.length) needs.push({ text: "Money isn't set up yet: add your ABN and the account you're paid into.", to: "/settings", tone: "warn" });
  if (o.gst.level === "near" || o.gst.level === "over") needs.push({ text: `GST turnover is at ${o.gst.percent}% of the threshold.`, to: "/money", tone: "bad" });
  if (lateCount) needs.push({ text: `${lateCount} invoice${lateCount === 1 ? " is" : "s are"} late. Check the bank before chasing.`, to: "/money", tone: "" });

  return (
    <>
      <header className="page-head"><div><h1>Home</h1><p>What needs you, then how things stand.</p></div></header>
      <section className="card stack enter" aria-label="Needs you">
        <h2>Needs you</h2>
        {needs.length ? needs.map((n, i) => (
          <div key={i} className={`notice ${n.tone}`}>
            <span style={{ flex: 1 }}>{n.text}</span>
            {n.to ? <a className="btn small" {...linkProps(n.to)}>Open</a> : null}
          </div>
        )) : <span className="muted">Nothing. Everything's moving.</span>}
      </section>
      <div className="grid fit">
        <a className="card stack" {...linkProps("/money")} aria-label="Owed to you">
          <div className="row"><h2>Owed to you</h2><span className="spacer" /><span className="live" style={{ color: "var(--good)" }} /></div>
          <div className="stat"><span className="big">{aud(owed)}</span><span className="muted">{o.counts.owed} unpaid · {lateCount} late</span></div>
        </a>
        <GstMeterCard gst={o.gst} />
      </div>
    </>
  );
}
