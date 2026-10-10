// Small shared pieces of Work: dates on the operator's own clock, times as people say them, and what
// a shift needs next, in a word.

import type { Shift } from "../lib/api";

/** The browser's own date (the operator's machine keeps the business's clock). */
export const localDay = (d = new Date()) => d.toLocaleDateString("en-CA");

export const plusDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The Monday that starts a day's week. */
export const mondayOf = (day: string) => plusDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));

/** "9am", "12:30pm" */
export const hm = (t: string) => {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  return `${h % 12 || 12}${m === "00" ? "" : `:${m}`}${h < 12 ? "am" : "pm"}`;
};

/** "Tue 7 Oct" (or whatever parts are asked for). */
export const dayLabel = (day: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-AU", { ...opts, timeZone: "UTC" }).replace(",", "");

/** Who the shift is with: the participant, or the client when it names none. */
export const who = (s: Shift) => s.participantName || s.clientName;

export type Tone = "warn" | "good" | "c1" | "muted" | "primary" | "bad";

/** What a shift needs, in a word, and the tone to show it in. */
export function shiftState(s: Shift): { label: string; tone: Tone } {
  if (s.status === "cancelled") return { label: "cancelled", tone: "muted" };
  if (s.incident && !s.incidentReported) return { label: "incident to report", tone: "bad" };
  if (s.billed) return { label: s.billed.number ? `on ${s.billed.number}` : "on a draft", tone: "good" };
  if (s.phase === "now") return { label: "on now", tone: "primary" };
  if (s.phase === "ahead") return { label: s.note === "draft" ? "note started" : "ahead", tone: "c1" };
  return s.note === "final" ? { label: "noted · ready to bill", tone: "good" } : { label: s.note === "draft" ? "finish the note" : "note due", tone: "warn" };
}
