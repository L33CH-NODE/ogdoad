// VII. Signals: everything that happens, as it happens, one line each: Horos and the hires, Money and
// the bank, SOPHIA's replies, and what you did. Quiet in deep work: only errors come through, and the
// rest is counted for when you're back.

import { useEffect, useState } from "react";

import type { Signal } from "../lib/api";
import { useZoom, Zone } from "./ControlCenter";
import { useCenter } from "./data";

const TONE: Record<Signal["tone"], string> = { good: "var(--good)", c1: "var(--c1)", warn: "var(--warn)", bad: "var(--bad)", muted: "var(--muted)", primary: "var(--primary)" };
const FILTERS = [
  { id: "all", label: "All" },
  { id: "team", label: "Team" },
  { id: "money", label: "Money" },
  { id: "you", label: "You" },
] as const;

function kindOf(s: Signal): "team" | "money" | "you" {
  if (s.who === "you" || s.kind === "session" || s.kind.startsWith("task_")) return "you";
  if (s.id.toString().startsWith("h") || s.who === "SOPHIA") return "team";
  return "money";
}

function time(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).replace(/\s?[ap]m$/i, "") : d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function SignalsZone() {
  const { signals, unread, markRead, deep } = useCenter();
  const open = useZoom() === "signals";
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  useEffect(() => {
    if (open && unread) markRead();
  }, [open, unread]);
  const shown = open && filter !== "all" ? signals.filter((s) => kindOf(s) === filter) : signals;
  const chip = deep.on
    ? <span className="chip quiet" style={{ color: "var(--primary)" }}>deep work{deep.held ? ` · ${deep.held} held` : ""}</span>
    : unread ? <span className="chip quiet" style={{ color: "var(--c1)" }}>{unread} new</span> : <span className="live" style={{ color: "var(--c1)" }} aria-label="live" />;

  return (
    <Zone id="signals" chip={chip}>
      {open ? (
        <div className="tabs" role="group" aria-label="Show">
          {FILTERS.map((f) => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
      ) : null}
      <ol className={`signals mono${open ? " open" : ""}`} aria-live="polite">
        {(open ? shown : shown.slice(0, 24)).map((s, i) => (
          <li key={s.id} className={i === 0 ? "enter" : ""}>
            <span className="muted">{time(s.at)}</span>
            <span className="who" style={{ color: TONE[s.tone] }}>{s.who}</span>
            <span className="what">{s.text}</span>
          </li>
        ))}
        {!shown.length ? <li className="muted">Quiet so far.</li> : null}
      </ol>
    </Zone>
  );
}
