// Small shared pieces: status chips, the GST meter, loading and error states.

import { useCallback, useEffect, useState } from "react";

import { api, type Bucket, type GstMeter } from "../lib/api";
import { aud, BUCKET_LABEL, shortDate } from "../lib/format";

export function StatusChip({ bucket }: { bucket: Bucket }) {
  const cls = { draft: "draft", void: "void", paid: "paid", current: "current", "1-30": "late1", "31-60": "late2", "61-90": "late3", "90+": "late4" }[bucket];
  return <span className={`chip ${cls}`}>{BUCKET_LABEL[bucket]}</span>;
}

export function GstMeterCard({ gst }: { gst: GstMeter }) {
  const pct = Math.min(100, gst.percent);
  const color = gst.level === "over" || gst.level === "near" ? "var(--bad)" : gst.level === "watch" ? "var(--warn)" : "var(--c3)";
  const note = {
    ok: "Well under the threshold.",
    watch: "Getting closer. Keep an eye on it.",
    near: "Close to the threshold. Talk to your accountant about registering.",
    over: "At or over the threshold: you must register for GST within 21 days.",
  }[gst.level];
  return (
    <section className="card stack" aria-label="GST threshold">
      <div className="row"><h2>GST threshold</h2><span className="spacer" /><span className="muted" style={{ fontSize: 12 }}>last 12 months</span></div>
      <div className="stat">
        <span className="big">{aud(gst.turnoverCents, { cents: false })}</span>
        <span className="muted">of $75,000 · {gst.percent}%</span>
      </div>
      <div className="meter sheen" style={{ ["--d" as string]: "7s" }}><div style={{ width: `${pct}%`, background: color }} /></div>
      <div className="muted" style={{ fontSize: 13 }}>{note} At the last three months' pace: {aud(gst.projectedCents, { cents: false })} a year.</div>
      <div className="muted" style={{ fontSize: 12 }}>{shortDate(gst.windowStart)} to {shortDate(gst.windowEnd)}, by date of service. GST-free NDIS income counts.</div>
    </section>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="card muted" role="status">{what}…</div>;
}

export function ErrorNote({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="notice bad" role="alert">
      <span className="error-text" style={{ flex: 1 }}>{error}</span>
      {retry ? <button className="btn small" onClick={retry}>Try again</button> : null}
    </div>
  );
}

/** Load JSON from the app server, with reload. */
export function useLoad<T>(path: string | null): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api.get<T>(path).then((d) => alive && (setData(d), setError(null)), (e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [path, n]);
  return { data, error, reload: useCallback(() => setN((x) => x + 1), []) };
}
