// Small moving parts for the Markets board: digits that roll to a new price, a sparkline that draws
// itself in, the change pill, the live dot, and a width hook so charts draw at their real size.

import { useEffect, useId, useLayoutEffect, useState, type RefObject } from "react";

import { fmtPct } from "../../lib/markets";
import { useReducedMotion } from "../../lib/motion";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * A number whose digits roll to their new value, like a departures board. Digits are keyed from the
 * right, so the units stay the units when the number grows a place. Screen readers get the text once.
 */
export function RollingNumber({ text, className = "" }: { text: string; className?: string }) {
  const reduced = useReducedMotion();
  // Roll up from zero the first time it's shown.
  const [ready, setReady] = useState(reduced);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const chars = [...text];
  return (
    <span className={`roll ${className}`.trim()}>
      <span className="sr">{text}</span>
      {chars.map((c, i) => {
        const k = chars.length - i;
        if (!/\d/.test(c)) return <span key={`c${k}${c}`} className="roll-char" aria-hidden="true">{c}</span>;
        const n = ready ? Number(c) : 0;
        return (
          <span key={`d${k}`} className="roll-digit" aria-hidden="true" style={{ ["--k" as string]: k }}>
            <span className="roll-strip" style={{ transform: `translateY(${-n * 10}%)` }}>{DIGITS.map((d) => <span key={d}>{d}</span>)}</span>
          </span>
        );
      })}
    </span>
  );
}

/** The width an element has right now, kept current as it resizes. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** An id that's safe inside url(#...). */
export function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** A small line of the day's prices, green or red by the day's direction, drawn in when it first shows. */
export function Sparkline({ values, up, width, height = 34 }: { values: number[]; up: boolean; width: number; height?: number }) {
  const gid = useSvgId("spark");
  if (values.length < 2 || width < 10) return <div className="spark" style={{ height }} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)]);
  const d = `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L")}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className={`spark ${up ? "up" : "down"}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.32" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="spark-area" d={`${d}L${width},${height}L0,${height}Z`} fill={`url(#${gid})`} />
      <path className="spark-line draw" d={d} pathLength={1} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle className="spark-end" cx={lx} cy={ly} r="2.4" fill="currentColor" />
    </svg>
  );
}

export function ChangePill({ pct, size = "sm" }: { pct: number | null | undefined; size?: "sm" | "lg" }) {
  const dir = typeof pct !== "number" || Math.abs(pct) < 0.005 ? "flat" : pct > 0 ? "up" : "down";
  return (
    <span className={`chg ${dir} ${size}`} aria-label={`${dir === "up" ? "up" : dir === "down" ? "down" : "unchanged"} ${fmtPct(pct).replace("−", "")}`}>
      <span className="chg-arrow" aria-hidden="true" />
      {fmtPct(pct)}
    </span>
  );
}

export function LiveDot({ label = "Live" }: { label?: string }) {
  return <span className="live-dot" role="img" aria-label={label} title={label} />;
}
