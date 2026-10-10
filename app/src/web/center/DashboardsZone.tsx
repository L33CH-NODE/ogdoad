// VIII. Dashboards: panels made for the operator, each a square of the grid. Ogdoad ships one (money in
// and out by month, from the encrypted books); the rest are made by hires on request, and land here.

import { useState } from "react";

import { Icon } from "../components/icons";
import type { Month } from "../lib/api";
import { aud } from "../lib/format";
import { useZoom, Zone } from "./ControlCenter";
import { useCenter } from "./data";

function MonthBars({ months, tall = false }: { months: Month[]; tall?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...months.flatMap((m) => [m.invoicedCents, m.receivedCents]));
  const W = 240;
  const H = tall ? 120 : 80;
  const bw = W / months.length;
  const h = (c: number) => (c / max) * (H - 6);
  const label = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  const shown = months[hover ?? months.length - 1];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="panel-key">
        <span className="muted">{shown ? new Date(`${shown.month}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" }) : ""}</span>
        <span><span className="key-dot" style={{ background: "var(--c1)" }} />invoiced {aud(shown?.invoicedCents ?? 0, { cents: false })}</span>
        <span><span className="key-dot" style={{ background: "var(--good)" }} />received {aud(shown?.receivedCents ?? 0, { cents: false })}</span>
      </div>
      <svg className="bars" viewBox={`0 0 ${W} ${H + 12}`} role="img" aria-label="Invoiced and received, by month, for the last 12 months" onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={H} y2={H} className="axis" />
        {months.map((m, i) => (
          <g key={m.month} onMouseEnter={() => setHover(i)} className={hover === i ? "hot" : ""}>
            <rect x={i * bw} y="0" width={bw} height={H + 12} fill="transparent" />
            <rect x={i * bw + bw * 0.16} y={H - h(m.invoicedCents)} width={bw * 0.32} height={h(m.invoicedCents)} rx="1.5" className="bar-inv" />
            <rect x={i * bw + bw * 0.52} y={H - h(m.receivedCents)} width={bw * 0.32} height={h(m.receivedCents)} rx="1.5" className="bar-rec" />
            {i % (tall ? 1 : 3) === 0 || i === months.length - 1 ? <text x={i * bw + bw / 2} y={H + 10} className="bar-label">{label(m.month)}</text> : null}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function DashboardsZone() {
  const { monthly } = useCenter();
  const open = useZoom() === "dashboards";
  const ask = () => window.dispatchEvent(new CustomEvent("ogdoad:command", { detail: "Make me a dashboard of " }));
  return (
    <Zone id="dashboards" chip={<span className="chip quiet">1 panel</span>}>
      <div className={open ? "dash-grid open" : "dash-grid"}>
        <figure className="panel">
          <figcaption><strong>Money in and out</strong><span className="muted"> · built in</span></figcaption>
          {monthly ? <MonthBars months={monthly} tall={open} /> : <span className="muted">Reading the books…</span>}
        </figure>
        <button className="panel ask" onClick={ask}>
          <Icon name="chart" size={18} />
          <span>Ask SOPHIA for a dashboard</span>
          <span className="muted">Say what you want to see. A hire builds it, and it lands here.</span>
        </button>
      </div>
    </Zone>
  );
}
