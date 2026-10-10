// Draws a panel's result from its chart spec: bars, lines, one big number, or a table. The spec is data
// (type, x, y, format), never code, so a panel written by a hire can only ever be drawn, not run.

import { useState } from "react";

import type { ChartSpec, PanelResult } from "../lib/api";
import { aud } from "../lib/format";

const COLORS = ["var(--c1)", "var(--good)", "var(--primary)", "var(--warn)", "var(--age2)", "var(--muted)"];

export function formatValue(v: unknown, format: ChartSpec["format"]): string {
  if (typeof v !== "number") return v === null || v === undefined ? "" : String(v);
  if (format === "aud") return aud(Math.round(v * 100), { cents: Math.abs(v) < 100 && !Number.isInteger(v) });
  if (format === "hours") return `${Math.round(v * 10) / 10} h`;
  if (format === "percent") return `${Math.round(v * 10) / 10}%`;
  return v.toLocaleString("en-AU", { maximumFractionDigits: 2 });
}

/** Short labels along the bottom: months and days read the Australian way. */
function tick(v: unknown): string {
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}$/.test(s)) return new Date(`${s}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" });
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
  return s.length > 8 ? `${s.slice(0, 7)}…` : s;
}

function longLabel(v: unknown): string {
  const s = String(v ?? "");
  if (/^\d{4}-\d{2}$/.test(s)) return new Date(`${s}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });
  return s;
}

export function Chart({ spec, result, tall = false, label }: { spec: ChartSpec; result: PanelResult; tall?: boolean; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!result.ok) return <p className="error-text" style={{ margin: 0, fontSize: 12.5 }}>{result.error}</p>;
  const { columns, rows } = result;
  if (!rows.length) return <span className="muted" style={{ fontSize: 13 }}>Nothing to show yet.</span>;
  const col = (name?: string) => (name ? columns.indexOf(name) : -1);
  const ys = (spec.y?.length ? spec.y : columns.filter((c, i) => c !== spec.x && typeof rows[0][i] === "number")).slice(0, 6);
  const yi = ys.map(col);
  const xi = col(spec.x);

  if (spec.type === "stat") {
    const v = rows[0][yi[0] ?? 0];
    return (
      <div className="stat-panel">
        <span className="stat-value">{formatValue(v, spec.format)}</span>
        <span className="muted">{xi >= 0 ? String(rows[0][xi]) : ys[0] ?? columns[0]}</span>
      </div>
    );
  }

  if (spec.type === "table") {
    const shown = rows.slice(0, tall ? 50 : 6);
    return (
      <div className="panel-table">
        <table>
          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{shown.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "num" : ""}>{typeof v === "number" ? formatValue(v, spec.format) : String(v ?? "")}</td>)}</tr>)}</tbody>
        </table>
        {rows.length > shown.length ? <span className="muted" style={{ fontSize: 11.5 }}>and {rows.length - shown.length} more</span> : null}
      </div>
    );
  }

  const W = 240;
  const H = tall ? 120 : 80;
  const values = rows.map((r) => yi.map((i) => (typeof r[i] === "number" ? (r[i] as number) : 0)));
  const max = Math.max(1e-9, ...values.flat());
  const min = Math.min(0, ...values.flat());
  const y = (v: number) => H - ((v - min) / (max - min)) * (H - 6);
  const step = W / rows.length;
  const every = Math.max(1, Math.ceil(rows.length / (tall ? 12 : 5)));
  const shown = hover ?? rows.length - 1;

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="panel-key">
        <span className="muted">{xi >= 0 ? longLabel(rows[shown][xi]) : `row ${shown + 1}`}</span>
        {ys.map((name, k) => <span key={name}><span className="key-dot" style={{ background: COLORS[k] }} />{name} {formatValue(values[shown][k], spec.format)}</span>)}
      </div>
      <svg className="bars" viewBox={`0 0 ${W} ${H + 12}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="axis" />
        {spec.type === "line" ? ys.map((name, k) => (
          <g key={name}>
            <polyline fill="none" stroke={COLORS[k]} strokeWidth="1.6" strokeLinejoin="round" points={values.map((v, i) => `${i * step + step / 2},${y(v[k])}`).join(" ")} />
            {values.map((v, i) => <circle key={i} cx={i * step + step / 2} cy={y(v[k])} r={hover === i ? 2.6 : 1.4} fill={COLORS[k]} />)}
          </g>
        )) : null}
        {rows.map((r, i) => (
          <g key={i} onMouseEnter={() => setHover(i)} className={hover === i ? "hot" : ""}>
            <rect x={i * step} y="0" width={step} height={H + 12} fill="transparent" />
            {spec.type === "bar" ? values[i].map((v, k) => {
              const bw = (step * 0.7) / ys.length;
              const top = Math.min(y(v), y(0));
              return <rect key={k} x={i * step + step * 0.15 + k * bw} y={top} width={Math.max(0.5, bw - 0.6)} height={Math.abs(y(v) - y(0))} rx="1.2" fill={COLORS[k]} opacity={hover === null || hover === i ? 1 : 0.55} />;
            }) : null}
            {xi >= 0 && (i % every === 0 || i === rows.length - 1) ? <text x={i * step + step / 2} y={H + 10} className="bar-label">{tick(r[xi])}</text> : null}
          </g>
        ))}
      </svg>
    </div>
  );
}
