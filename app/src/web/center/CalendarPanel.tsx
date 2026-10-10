// The calendar Work keeps in step with: the operator's own CalDAV calendar (Radicale, Baïkal or Nextcloud
// on a home box, over the tailnet). Events say "Shift · C-0412" and the times, nothing else, unless
// names are switched on here. Moving an event in the calendar moves its shift.

import { useEffect, useState } from "react";

import { Icon } from "../components/icons";
import { api, type CalendarReport, type CalendarSettings } from "../lib/api";
import { ago } from "../lib/format";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";
import { useCenter } from "./data";

const sentence = (r: CalendarReport) => {
  const bits = [
    r.created && `${r.created} sent`, r.updated && `${r.updated} updated`, r.deleted && `${r.deleted} removed`,
    r.moved && `${r.moved} moved from the calendar`, r.cancelled && `${r.cancelled} cancelled from the calendar`,
  ].filter(Boolean);
  return bits.length ? `${bits.join(", ")}.` : "Already in step.";
};

/** One line for under the bill panel: where the calendar stands. */
export function CalendarLine() {
  const { data } = useLive<CalendarSettings>("/ogdoad/work/calendar", ["work"]);
  if (!data) return null;
  return (
    <button className="calendar-line" onClick={() => navigate("/work/calendar")}>
      <Icon name="calendar" size={14} />
      {data.kind === "none" ? <span>Calendar sync is off. <u>Set it up</u></span>
        : data.lastError ? <span style={{ color: "var(--warn)" }}>The calendar sync isn't working. <u>See why</u></span>
        : <span>In step with {hostOf(data.url)}{data.lastSyncAt ? `, ${ago(data.lastSyncAt)}` : ""}</span>}
    </button>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function CalendarPanel() {
  const { info, say } = useCenter();
  const { data, reload } = useLive<CalendarSettings>("/ogdoad/work/calendar", ["work"]);
  const [form, setForm] = useState({ url: "", username: "", password: "", showNames: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    if (data) setForm({ url: data.url, username: data.username, password: "", showNames: data.showNames });
  }, [data?.url, data?.username, data?.showNames]);
  if (!data) return <p className="muted">Opening the calendar settings…</p>;

  const run = async (fn: () => Promise<{ settings: CalendarSettings; report: CalendarReport | null }>) => {
    setBusy(true);
    setNote(null);
    try {
      const { settings, report } = await fn();
      reload();
      if (report) {
        setNote(report.errors.length ? { text: report.errors[0], bad: true } : { text: sentence(report) });
        if (!report.errors.length) say("Work", `calendar: ${sentence(report)}`, "good");
      } else if (settings.kind === "none") setNote({ text: "Calendar sync is off. Events already sent stay in the calendar." });
    } catch (err) {
      setNote({ text: (err as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(() => api.put("/ogdoad/work/calendar", { kind: "caldav", ...form, password: form.password || undefined }));

  return (
    <div className="panel stack" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong style={{ fontSize: 17 }}>Your calendar</strong>
        <span className={`chip quiet ${data.kind === "none" ? "" : data.lastError ? "t-warn" : "t-good"}`}>{data.kind === "none" ? "off" : data.lastError ? "not working" : "in step"}</span>
      </div>
      <span className="muted" style={{ fontSize: 13, marginTop: -4 }}>
        Your own CalDAV calendar: Radicale, Baïkal or Nextcloud on a home box, reached over your tailnet. Shifts go out as events; move one in the calendar and the shift moves here, delete one that hasn't happened and it's cancelled.
      </span>
      {info?.practice ? (
        <div className="notice"><Icon name="shield" size={16} /><span>The practice copy doesn't sync a calendar: its shifts are made up. Set it up in your real Ogdoad.</span></div>
      ) : (
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label className="field">The calendar's address
            <input className="input" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="http://homebox:5232/you/shifts/" autoComplete="off" spellCheck={false} required />
          </label>
          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>Login
              <input className="input" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} autoComplete="off" />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>Password
              <input className="input" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder={data.hasPassword ? "Kept (type to change)" : ""} autoComplete="new-password" />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.showNames} onChange={(e) => setForm((f) => ({ ...f, showNames: e.target.checked }))} />
            Show names in the calendar
          </label>
          <span className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>
            {form.showNames ? "Events will carry the participant's and client's names, so they sit on that server too." : "Off: events say \"Shift · C-0412\" and the times, nothing else. Each shift shows its code here."}
          </span>
          {note ? <p className={note.bad ? "error-text" : "muted"} role={note.bad ? "alert" : "status"} style={{ margin: 0 }}>{note.text}</p> : null}
          {!note && data.lastError ? <p className="error-text" style={{ margin: 0 }}>{data.lastError}</p> : null}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {data.kind !== "none" ? <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => api.put("/ogdoad/work/calendar", { kind: "none" }))}>Turn it off</button> : null}
            {data.kind !== "none" ? <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => api.post("/ogdoad/work/calendar/sync"))}>Sync now</button> : null}
            <button type="submit" className="btn small primary" disabled={busy || !form.url.trim()}>{busy ? "Working…" : data.kind === "none" ? "Turn it on" : "Save"}</button>
          </div>
          {data.lastSyncAt ? <span className="muted" style={{ fontSize: 12 }}>Last in step {ago(data.lastSyncAt)}. It keeps itself in step every ten minutes, and soon after any shift changes.</span> : null}
        </form>
      )}
      <span className="muted" style={{ fontSize: 12 }}>Google Calendar comes later: it needs Google's own sign-in.</span>
    </div>
  );
}
