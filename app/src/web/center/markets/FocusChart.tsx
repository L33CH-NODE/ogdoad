// The Markets board's big chart: one symbol over a day, a week, a month or a year. The line draws itself
// in, the area under it fades up, and a crosshair follows the pointer with the price at that moment.
// On the day view, yesterday's close is the dashed line the day is measured against.

import { useMemo, useRef, useState, type PointerEvent } from "react";

import { fmtPrice, KIND_LABEL, RANGES, useHistory, type Quote, type Range } from "../../lib/markets";
import { ChangePill, LiveDot, RollingNumber, useSvgId, useWidth } from "./parts";

const H = 220;
const PAD = { top: 18, bottom: 22 };
const RANGE_WORDS: Record<Range, string> = { "1D": "today", "1W": "this week", "1M": "this month", "1Y": "this year" };

function when(t: number, range: Range): string {
  const d = new Date(t);
  if (range === "1D") return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  if (range === "1W") return d.toLocaleDateString("en-AU", { weekday: "short", hour: "numeric" });
  if (range === "1M") return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  return d.toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}

export function FocusChart({ q }: { q: Quote }) {
  const [range, setRange] = useState<Range>("1D");
  const { history, loading, error } = useHistory(q.id, range);
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box);
  const [hover, setHover] = useState<number | null>(null);
  const gid = useSvgId("focus");

  // The day's path, ending on the live price when it's newer than the last point.
  const points = useMemo(() => {
    const p = history?.points ?? [];
    if (range === "1D" && p.length && q.at > p[p.length - 1][0]) return [...p, [q.at, q.price] as [number, number]];
    return p;
  }, [history, range, q.at, q.price]);

  const first = points[0]?.[1];
  const last = points[points.length - 1]?.[1];
  // A share's day is measured from yesterday's close, drawn as the dashed line. Crypto never closes and its
  // path comes from another source than its price, so it gets no line; its day's change is the same one
  // its tile shows. Longer ranges are measured from where the chart starts.
  const base = range === "1D" && q.kind !== "crypto" && q.prevClose ? q.prevClose : first;
  const change = range === "1D" ? q.changePct : base && last !== undefined ? ((last - base) / base) * 100 : null;
  const up = (change ?? 0) >= 0;

  const geo = useMemo(() => {
    if (points.length < 2 || W < 40) return null;
    const values = points.map((p) => p[1]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (range === "1D" && base && q.kind !== "crypto") (lo = Math.min(lo, base)), (hi = Math.max(hi, base));
    const pad = (hi - lo) * 0.08 || hi * 0.01 || 1;
    const min = lo - pad;
    const max = hi + pad;
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W;
    const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
    const xy = points.map(([t, v]) => [x(t), y(v)] as const);
    const line = `M${xy.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join("L")}`;
    const hiAt = values.indexOf(Math.max(...values));
    const loAt = values.indexOf(Math.min(...values));
    return { xy, line, area: `${line}L${W},${H - PAD.bottom}L0,${H - PAD.bottom}Z`, y, hiAt, loAt };
  }, [points, W, range, base, q.kind]);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0;
    for (let i = 1; i < geo.xy.length; i++) if (Math.abs(geo.xy[i][0] - px) < Math.abs(geo.xy[best][0] - px)) best = i;
    setHover(best);
  };

  const shownPrice = hover !== null && points[hover] ? points[hover][1] : q.price;
  const flip = (x: number) => (x > W - 120 ? "end" : x < 120 ? "start" : "middle");

  return (
    <div className={`focus ${up ? "up" : "down"}`}>
      <div className="focus-head">
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <span className="focus-name">{q.name}</span>
          <span className="muted focus-meta">
            {q.id} · {KIND_LABEL[q.kind]}{q.market !== KIND_LABEL[q.kind] ? ` · ${q.market}` : ""}
            {q.live ? <> · <LiveDot /> live</> : q.kind !== "crypto" ? <> · {q.open ? "market open" : "market closed"}</> : null}
          </span>
        </div>
        <div className="focus-price">
          <RollingNumber className="focus-num" text={fmtPrice(shownPrice, history?.currency ?? q.currency, q.kind)} />
          <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            {hover !== null && points[hover] ? <span className="muted">{when(points[hover][0], range)}</span> : <><ChangePill pct={change} /><span className="muted">{RANGE_WORDS[range]}</span></>}
          </span>
        </div>
      </div>

      <div className="focus-plot" ref={box}>
        {geo ? (
          <svg key={`${q.id}:${range}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${q.name}, ${RANGE_WORDS[range]}`}
            onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="currentColor" stopOpacity="0.34" />
                <stop offset="0.7" stopColor="currentColor" stopOpacity="0.06" />
                <stop offset="1" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {range === "1D" && base && q.kind !== "crypto" ? <line className="focus-base" x1="0" x2={W} y1={geo.y(base)} y2={geo.y(base)} /> : null}
            <path className="focus-area" d={geo.area} fill={`url(#${gid})`} />
            <path className="focus-line draw" d={geo.line} pathLength={1} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            <g className="focus-marks">
              <text x={geo.xy[geo.hiAt][0]} y={geo.xy[geo.hiAt][1] - 7} textAnchor={flip(geo.xy[geo.hiAt][0])}>{fmtPrice(points[geo.hiAt][1], q.currency, q.kind)}</text>
              <text x={geo.xy[geo.loAt][0]} y={geo.xy[geo.loAt][1] + 14} textAnchor={flip(geo.xy[geo.loAt][0])}>{fmtPrice(points[geo.loAt][1], q.currency, q.kind)}</text>
            </g>
            <g className="focus-axis">
              <text x="0" y={H - 5} textAnchor="start">{when(points[0][0], range)}</text>
              <text x={W} y={H - 5} textAnchor="end">{q.live && range === "1D" ? "now" : when(points[points.length - 1][0], range)}</text>
            </g>
            {hover !== null ? (
              <g className="focus-cross">
                <line x1={geo.xy[hover][0]} x2={geo.xy[hover][0]} y1={PAD.top - 6} y2={H - PAD.bottom} />
                <circle cx={geo.xy[hover][0]} cy={geo.xy[hover][1]} r="4.5" />
              </g>
            ) : (
              <circle className="focus-end" cx={geo.xy[geo.xy.length - 1][0]} cy={geo.xy[geo.xy.length - 1][1]} r="3.5" />
            )}
          </svg>
        ) : (
          <div className="focus-wait" style={{ height: H }}>{error ? <span className="error-text">{error}</span> : loading ? <span className="shimmer" /> : <span className="muted">No prices for this range yet.</span>}</div>
        )}
      </div>

      <div className="seg" role="tablist" aria-label="Range" style={{ ["--n" as string]: RANGES.length, ["--at" as string]: RANGES.indexOf(range) }}>
        <span className="seg-glide" aria-hidden="true" />
        {RANGES.map((r) => <button key={r} role="tab" aria-selected={r === range} className={r === range ? "on" : ""} onClick={() => (setRange(r), setHover(null))}>{r}</button>)}
      </div>
    </div>
  );
}
