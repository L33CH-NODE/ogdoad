// V. Work: today's shifts on a timeline with a now-line, and what's next. Opened, it's the week (each
// shift with its note and billing state), one shift and its note, and what's ready to bill. A shift
// that's over without its note shows amber until the note is written; notes never leave this machine.

import { useEffect, useMemo, useState } from "react";

import { Icon } from "../components/icons";
import type { Billable, Shift } from "../lib/api";
import { aud } from "../lib/format";
import { useLive } from "../lib/live";
import { match, navigate, usePath } from "../lib/router";
import { useZoom, Zone } from "./ControlCenter";
import { useCenter } from "./data";
import { AddShift, BillPanel, ShiftRoom } from "./ShiftRoom";
import { dayLabel, hm, localDay, mondayOf, plusDays, shiftState, who } from "./workBits";

const AREAS = ["work", "money", "practice"];
const toH = (t: string) => Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60;

function Timeline({ shifts, now }: { shifts: Shift[]; now: Date }) {
  const live = shifts.filter((s) => s.status !== "cancelled");
  const start = Math.min(7, ...live.map((s) => Math.floor(toH(s.start))));
  const end = Math.max(19, ...live.map((s) => Math.min(24, Math.ceil(toH(s.start) + s.minutes / 60))));
  const span = end - start;
  const hours = now.getHours() + now.getMinutes() / 60;
  const x = ((hours - start) / span) * 100;
  const labels = [start, start + Math.round(span / 4), start + Math.round(span / 2), start + Math.round((3 * span) / 4), end];
  return (
    <>
      <div className="timeline" aria-label={live.length ? `Today: ${live.map((s) => `${who(s)} ${hm(s.start)} to ${hm(s.end)}`).join("; ")}` : "Today: no shifts"}>
        {Array.from({ length: span + 1 }, (_, i) => <span key={i} className="tick" style={{ left: `${(i / span) * 100}%` }} />)}
        {live.map((s) => {
          const left = ((toH(s.start) - start) / span) * 100;
          const width = Math.min(100 - left, ((s.minutes / 60) / span) * 100);
          const st = shiftState(s);
          return (
            <button key={s.id} className={`shift-block ${s.phase} t-${st.tone}`} style={{ left: `${left}%`, width: `${width}%` }} onClick={() => navigate(`/work/shift/${s.id}`)} title={`${who(s)} · ${hm(s.start)}–${hm(s.end)} · ${st.label}`}>
              <span>{who(s)}</span>
            </button>
          );
        })}
        {!live.length ? <span className="empty-day">No shifts today</span> : null}
        {x >= 0 && x <= 100 ? <span className="nowline" style={{ left: `${x}%` }} /> : null}
      </div>
      <div className="timeline-hours mono">{labels.map((h, i) => <span key={i}>{hm(`${String(h % 24).padStart(2, "0")}:00`)}</span>)}</div>
    </>
  );
}

function Week({ monday, shifts, today, picked }: { monday: string; shifts: Shift[]; today: string; picked?: string }) {
  const days = Array.from({ length: 7 }, (_, i) => plusDays(monday, i));
  return (
    <div className="week">
      {days.map((d) => {
        const list = shifts.filter((s) => s.day === d);
        return (
          <div key={d} className={`week-day${d === today ? " today" : ""}`}>
            <span className="week-date">{dayLabel(d)}</span>
            <div className="week-list">
            {list.length ? list.map((s) => {
              const st = shiftState(s);
              return (
                <button key={s.id} className={`week-shift${s.id === picked ? " picked" : ""}${s.status === "cancelled" ? " cancelled" : ""}`} onClick={() => navigate(`/work/shift/${s.id}`)}>
                  <span className="mono week-time">{hm(s.start)}–{hm(s.end)}</span>
                  <span className="week-who">{who(s)}<span className="muted">{s.support ? ` · ${s.support}` : ""}</span></span>
                  <span className={`chip quiet t-${st.tone}`}>{st.label}</span>
                </button>
              );
            }) : <span className="muted week-none">free</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function WorkZone() {
  const { info } = useCenter();
  const path = usePath();
  const open = useZoom() === "work";
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const today = localDay(now);
  const todays = useLive<Shift[]>(`/ogdoad/work/shifts?from=${today}&to=${today}`, AREAS);
  const billable = useLive<Billable[]>("/ogdoad/work/billable", AREAS);

  const picked = match("/work/shift/:id", path)?.id;
  const billing = match("/work/bill/:client", path)?.client;
  const adding = path === "/work/new";
  const [weekOf, setWeekOf] = useState(today);
  const monday = useMemo(() => mondayOf(weekOf), [weekOf]);
  const week = useLive<Shift[]>(open ? `/ogdoad/work/shifts?from=${monday}&to=${plusDays(monday, 6)}` : null, AREAS);

  const list = todays.data ?? [];
  const next = list.find((s) => s.status !== "cancelled" && s.phase !== "over");
  const due = (week.data ?? list).filter((s) => s.phase === "over" && s.status !== "cancelled" && !s.billed && s.note !== "final").length;
  const ready = (billable.data ?? []).filter((b) => b.shifts > 0);
  const readyCents = ready.reduce((a, b) => a + b.cents, 0);
  const clock = now.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const chip = <span className="chip quiet">{clock}</span>;

  const summary = (
    <div className="zfoot">
      {next ? <span>{next.phase === "now" ? "On now" : "Next"}: <strong style={{ color: "var(--fg)" }}>{who(next)}</strong> {hm(next.start)}{next.support ? ` · ${next.support}` : ""}</span> : <span>{list.length ? "Done for today" : "A free day"}</span>}
      <span className="spacer" />
      {due ? <button className="link-btn" style={{ color: "var(--warn)" }} onClick={() => navigate("/work")}>{due} note{due === 1 ? "" : "s"} due</button> : null}
      {ready.length ? <button className="link-btn" onClick={() => navigate(`/work/bill/${ready[0].clientId}`)}>{aud(readyCents, { cents: false })} ready to bill</button> : null}
    </div>
  );

  if (!open) {
    return (
      <Zone id="work" chip={chip}>
        <Timeline shifts={list} now={now} />
        {summary}
      </Zone>
    );
  }

  return (
    <Zone id="work" chip={chip}>
      <Timeline shifts={list} now={now} />
      <div className="room-cols" style={{ marginTop: 8 }}>
        <div className="stack" style={{ gap: 10, minWidth: 0 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="row" style={{ gap: 6 }}>
              <button className="icon-btn" onClick={() => setWeekOf(plusDays(monday, -7))} aria-label="The week before"><Icon name="back" size={14} /></button>
              <strong>Week of {dayLabel(monday, { day: "numeric", month: "long" })}</strong>
              <button className="icon-btn flip" onClick={() => setWeekOf(plusDays(monday, 7))} aria-label="The week after"><Icon name="back" size={14} /></button>
              {monday !== mondayOf(today) ? <button className="link-btn" style={{ fontSize: 12 }} onClick={() => setWeekOf(today)}>this week</button> : null}
            </div>
            <button className="btn small primary" onClick={() => navigate("/work/new")}><Icon name="plus" size={14} /> Add a shift</button>
          </div>
          <Week monday={monday} shifts={week.data ?? []} today={today} picked={picked} />
        </div>
        <div className="stack" style={{ gap: 12, minWidth: 0 }}>
          {adding ? <AddShift today={today} onAdded={(s) => { setWeekOf(s.day); navigate(`/work/shift/${s.id}`); }} />
            : picked ? <ShiftRoom id={picked} onDay={setWeekOf} />
            : <BillPanel billable={billable.data ?? []} focus={billing} />}
          <p className="muted tier0"><Icon name="shield" size={14} /> {info?.practice
            ? "These shifts and notes are made up. In your real books, notes stay on this machine, encrypted with your key, and are never sent to a cloud model."
            : "Shift notes stay on this machine, in your encrypted books. They're never sent to a cloud model."}</p>
        </div>
      </div>
    </Zone>
  );
}
