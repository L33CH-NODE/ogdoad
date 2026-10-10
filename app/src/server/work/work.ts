// Work: the operator's shifts, the note each one needs, and the way finished shifts become invoice
// lines. Shifts sit in the same encrypted database as Money. Their notes are health and personal
// records: Tier 0, local only, never sent to a cloud model.

import { randomUUID } from "node:crypto";

import type { Raised } from "../flow/flow.js";
import { addDays, MoneyError, type Invoice, type LineInput, type Money } from "../money/service.js";

export interface Shift {
  id: string;
  clientId: string;
  clientName: string;
  /** The shift's own participant, or the client's. */
  participantName: string;
  day: string;
  start: string;
  end: string;
  minutes: number;
  support: string;
  rateCents: number;
  km: number;
  kmRateCents: number;
  /** Hours at the rate, plus travel. */
  cents: number;
  status: "planned" | "done" | "cancelled";
  /** Where it sits against the clock right now. */
  phase: "ahead" | "now" | "over";
  note: "none" | "draft" | "final";
  incident: boolean;
  incidentReported: boolean;
  /** The draft or invoice it's on; null when it's free to bill. */
  billed: { invoiceId: string; status: string; number: string | null } | null;
  seriesId: string | null;
}

export interface ShiftNote {
  body: string;
  goals: string;
  followUp: string;
  incident: boolean;
  incidentDetail: string;
  incidentReportedAt: string | null;
  final: boolean;
  writtenBy: string;
  updatedAt: string;
}

export type ShiftDetail = Shift & { noteText: ShiftNote | null };

export interface ShiftInput {
  clientId: string;
  day: string;
  start: string;
  end: string;
  participantName?: string;
  support?: string;
  rateCents?: number;
  km?: number;
  kmRateCents?: number;
  /** Also make the same shift on each of the next N weeks (up to 26). */
  repeatWeeks?: number;
}

export interface Billable {
  clientId: string;
  clientName: string;
  shifts: number;
  cents: number;
  from: string;
  to: string;
  /** Finished shifts for this client still waiting on their note. */
  waitingOnNotes: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const iso = () => new Date().toISOString();
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const dayIndex = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const aud = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });

/** The business's wall clock: today's date and the minutes since midnight, in its own timezone. */
export function clockIn(timezone: string, now = new Date()): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** How long a shift runs. An end at or before the start runs past midnight. */
export function shiftMinutes(start: string, end: string): number {
  const d = toMin(end) - toMin(start);
  return d > 0 ? d : d + 1440;
}

/** "9am", "12:30pm": times as people say them (invoice lines keep the 24-hour clock). */
export function spoken(t: string): string {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  return `${h % 12 || 12}${m === "00" ? "" : `:${m}`}${h < 12 ? "am" : "pm"}`;
}

/** "Tue 7 Oct" */
export function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}

function requireTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !HHMM.test(value)) throw new MoneyError("bad_time", `${field} must be a time like 09:30.`);
  return value;
}
function requireDay(value: unknown): string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new MoneyError("bad_date", "The day must be a date like 2026-10-09.");
  return value;
}
function requireCents(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new MoneyError("bad_amount", `${field} must be whole cents, zero or more.`);
  return value as number;
}

export class Work {
  /** actor: who the trail names ("operator", or "practice" for the practice copy's made-up roster). */
  constructor(private readonly money: Money, private readonly actor = "operator") {}

  private get db() {
    return this.money.db;
  }

  private event(kind: string, subjectId: string | null, detail: string): void {
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, ?, ?, ?, ?)").run(iso(), this.actor, kind, subjectId, detail);
  }

  private clock() {
    return clockIn(this.money.settings().timezone);
  }

  private toShift(r: any, clock = this.clock()): Shift {
    const minutes = shiftMinutes(r.start_time, r.end_time);
    const startAbs = dayIndex(r.day) * 1440 + toMin(r.start_time);
    const nowAbs = dayIndex(clock.day) * 1440 + clock.minutes;
    const active = r.invoice_id && r.invoice_status && r.invoice_status !== "rejected" && r.invoice_status !== "void";
    return {
      id: r.id, clientId: r.client_id, clientName: r.client_name, participantName: r.participant_name || r.client_participant || "",
      day: r.day, start: r.start_time, end: r.end_time, minutes, support: r.support, rateCents: r.rate_cents, km: r.km, kmRateCents: r.km_rate_cents,
      cents: Math.round((minutes / 60) * r.rate_cents) + Math.round(r.km * r.km_rate_cents),
      status: r.status,
      phase: nowAbs < startAbs ? "ahead" : nowAbs < startAbs + minutes ? "now" : "over",
      note: r.note_final === null || r.note_final === undefined ? "none" : r.note_final ? "final" : "draft",
      incident: !!r.note_incident, incidentReported: !!r.note_incident_reported_at,
      billed: active ? { invoiceId: r.invoice_id, status: r.invoice_status, number: r.invoice_number } : null,
      seriesId: r.series_id,
    };
  }

  private select(where: string, params: unknown[]): Shift[] {
    const rows = this.db.prepare(`SELECT s.*, c.name AS client_name, c.participant_name AS client_participant,
        n.final AS note_final, n.incident AS note_incident, n.incident_reported_at AS note_incident_reported_at,
        i.status AS invoice_status, i.number AS invoice_number
      FROM shifts s JOIN clients c ON c.id = s.client_id
      LEFT JOIN shift_notes n ON n.shift_id = s.id
      LEFT JOIN invoices i ON i.id = s.invoice_id
      ${where} ORDER BY s.day, s.start_time`).all(...params) as any[];
    const clock = this.clock();
    return rows.map((r) => this.toShift(r, clock));
  }

  shifts(range: { from?: string; to?: string } = {}): Shift[] {
    const from = range.from ? requireDay(range.from) : "0000-01-01";
    const to = range.to ? requireDay(range.to) : "9999-12-31";
    return this.select("WHERE s.day BETWEEN ? AND ?", [from, to]);
  }

  shift(id: string): ShiftDetail {
    const [s] = this.select("WHERE s.id = ?", [id]);
    if (!s) throw new MoneyError("no_shift", "No such shift.");
    const n = this.db.prepare("SELECT * FROM shift_notes WHERE shift_id = ?").get(id) as any;
    return {
      ...s,
      noteText: n ? { body: n.body, goals: n.goals, followUp: n.follow_up, incident: !!n.incident, incidentDetail: n.incident_detail, incidentReportedAt: n.incident_reported_at, final: !!n.final, writtenBy: n.written_by, updatedAt: n.updated_at } : null,
    };
  }

  /** The last shift for a client: what a new one starts from (support, rate, travel rate). */
  private lastFor(clientId: string): any {
    return this.db.prepare("SELECT * FROM shifts WHERE client_id = ? ORDER BY day DESC, start_time DESC LIMIT 1").get(clientId);
  }

  add(input: ShiftInput): Shift[] {
    const client = this.money.client(String(input.clientId ?? ""));
    if (!client) throw new MoneyError("no_client", "Pick the client the shift is for.");
    const day = requireDay(input.day);
    const start = requireTime(input.start, "The start");
    const end = requireTime(input.end, "The end");
    if (start === end) throw new MoneyError("bad_time", "A shift needs an end that isn't its start.");
    const last = this.lastFor(client.id);
    const rate = input.rateCents === undefined ? last?.rate_cents ?? 0 : requireCents(input.rateCents, "The rate");
    const kmRate = input.kmRateCents === undefined ? last?.km_rate_cents ?? 0 : requireCents(input.kmRateCents, "The travel rate");
    const km = Number(input.km ?? 0);
    if (!(km >= 0) || km > 2000) throw new MoneyError("bad_km", "Travel must be between 0 and 2000 km.");
    const repeat = Math.trunc(Number(input.repeatWeeks ?? 0));
    if (!(repeat >= 0 && repeat <= 26)) throw new MoneyError("bad_repeat", "Repeat for up to 26 weeks.");
    const support = String(input.support ?? last?.support ?? "").trim().slice(0, 200);
    const participant = String(input.participantName ?? "").trim().slice(0, 200);
    const series = repeat ? randomUUID() : null;
    const ids: string[] = [];
    const now = iso();
    this.db.exec("BEGIN");
    try {
      const insert = this.db.prepare(`INSERT INTO shifts (id, client_id, participant_name, day, start_time, end_time, support, rate_cents, km, km_rate_cents, series_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let w = 0; w <= repeat; w++) {
        const id = randomUUID();
        insert.run(id, client.id, participant, addDays(day, w * 7), start, end, support, rate, km, kmRate, series, now, now);
        ids.push(id);
      }
      this.event("shift_added", ids[0], `${client.name} · ${shortDay(day)} ${start}${repeat ? ` · and ${repeat} more week${repeat === 1 ? "" : "s"}` : ""}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return ids.map((id) => this.shift(id));
  }

  private editable(id: string): Shift {
    const s = this.shift(id);
    if (s.billed) throw new MoneyError("billed", `It's on ${s.billed.number ? `invoice ${s.billed.number}` : "a draft"} already. Reject the draft (or void the invoice) to change it.`);
    return s;
  }

  update(id: string, patch: Partial<Omit<ShiftInput, "repeatWeeks">>): Shift {
    const cur = this.editable(id);
    const day = patch.day === undefined ? cur.day : requireDay(patch.day);
    const start = patch.start === undefined ? cur.start : requireTime(patch.start, "The start");
    const end = patch.end === undefined ? cur.end : requireTime(patch.end, "The end");
    if (start === end) throw new MoneyError("bad_time", "A shift needs an end that isn't its start.");
    const clientId = patch.clientId ?? cur.clientId;
    if (!this.money.client(clientId)) throw new MoneyError("no_client", "No such client.");
    const km = patch.km === undefined ? cur.km : Number(patch.km);
    if (!(km >= 0) || km > 2000) throw new MoneyError("bad_km", "Travel must be between 0 and 2000 km.");
    const own = this.db.prepare("SELECT participant_name FROM shifts WHERE id = ?").get(id) as { participant_name: string };
    this.db.prepare(`UPDATE shifts SET client_id = ?, participant_name = ?, day = ?, start_time = ?, end_time = ?, support = ?, rate_cents = ?, km = ?, km_rate_cents = ?, updated_at = ? WHERE id = ?`).run(
      clientId, patch.participantName === undefined ? own.participant_name : String(patch.participantName).trim().slice(0, 200), day, start, end,
      patch.support === undefined ? cur.support : String(patch.support).trim().slice(0, 200),
      patch.rateCents === undefined ? cur.rateCents : requireCents(patch.rateCents, "The rate"), km,
      patch.kmRateCents === undefined ? cur.kmRateCents : requireCents(patch.kmRateCents, "The travel rate"), iso(), id);
    const after = this.shift(id);
    this.event("shift_updated", id, `${after.clientName} · ${shortDay(after.day)} ${after.start}`);
    return after;
  }

  /** cancel, or restore a cancelled shift. */
  setCancelled(id: string, cancelled: boolean): Shift {
    const cur = this.editable(id);
    if (cancelled && cur.status === "cancelled") return cur;
    const status = cancelled ? "cancelled" : cur.note === "final" ? "done" : "planned";
    this.db.prepare("UPDATE shifts SET status = ?, updated_at = ? WHERE id = ?").run(status, iso(), id);
    this.event(cancelled ? "shift_cancelled" : "shift_restored", id, `${cur.clientName} · ${shortDay(cur.day)} ${cur.start}`);
    return this.shift(id);
  }

  /** Write (or finish) a shift's note. A final note marks the shift done, and lets it be billed. */
  writeNote(id: string, input: Partial<Omit<ShiftNote, "incidentReportedAt" | "writtenBy" | "updatedAt">>): ShiftDetail {
    const s = this.shift(id);
    if (s.status === "cancelled") throw new MoneyError("cancelled", "That shift was cancelled. Restore it first.");
    const prev = s.noteText;
    const n = {
      body: String(input.body ?? prev?.body ?? "").slice(0, 20_000),
      goals: String(input.goals ?? prev?.goals ?? "").slice(0, 10_000),
      followUp: String(input.followUp ?? prev?.followUp ?? "").slice(0, 10_000),
      incident: input.incident ?? prev?.incident ?? false,
      incidentDetail: String(input.incidentDetail ?? prev?.incidentDetail ?? "").slice(0, 20_000),
      final: input.final ?? prev?.final ?? false,
    };
    if (n.final && s.phase === "ahead") throw new MoneyError("not_yet", "This shift hasn't started yet. Save it as a draft, and finish it afterwards.");
    if (n.final && !n.body.trim()) throw new MoneyError("empty_note", "Say what happened before you finish the note.");
    if (n.incident && n.final && !n.incidentDetail.trim()) throw new MoneyError("empty_incident", "Describe the incident before you finish the note.");
    const now = iso();
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO shift_notes (shift_id, body, goals, follow_up, incident, incident_detail, final, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(shift_id) DO UPDATE SET body = excluded.body, goals = excluded.goals, follow_up = excluded.follow_up, incident = excluded.incident,
          incident_detail = excluded.incident_detail, final = excluded.final, updated_at = excluded.updated_at,
          incident_reported_at = CASE WHEN excluded.incident = 1 THEN incident_reported_at ELSE NULL END`)
        .run(id, n.body, n.goals, n.followUp, n.incident ? 1 : 0, n.incidentDetail, n.final ? 1 : 0, now, now);
      this.db.prepare("UPDATE shifts SET status = ?, updated_at = ? WHERE id = ?").run(n.final ? "done" : "planned", now, id);
      // The trail says a note was written, never what's in it.
      this.event(n.final ? "note_finished" : "note_saved", id, `${s.clientName} · ${shortDay(s.day)}${n.incident ? " · with an incident" : ""}`);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.shift(id);
  }

  incidentReported(id: string): ShiftDetail {
    const s = this.shift(id);
    if (!s.noteText?.incident) throw new MoneyError("no_incident", "That shift's note has no incident.");
    this.db.prepare("UPDATE shift_notes SET incident_reported_at = ?, updated_at = ? WHERE shift_id = ?").run(iso(), iso(), id);
    this.event("incident_reported", id, `${s.clientName} · ${shortDay(s.day)}`);
    return this.shift(id);
  }

  /** Per client: finished shifts with their notes, not on any live draft or invoice yet. */
  billable(): Billable[] {
    const free = this.select("WHERE s.status != 'cancelled'", []).filter((s) => !s.billed && s.phase === "over");
    const by = new Map<string, Billable>();
    for (const s of free) {
      const b = by.get(s.clientId) ?? { clientId: s.clientId, clientName: s.clientName, shifts: 0, cents: 0, from: s.day, to: s.day, waitingOnNotes: 0 };
      if (s.note === "final") {
        // Shifts come in date order, so the first billable one opens the range and the last closes it.
        if (!b.shifts) b.from = s.day;
        b.to = s.day;
        b.shifts++;
        b.cents += s.cents;
      } else {
        b.waitingOnNotes++;
      }
      by.set(s.clientId, b);
    }
    return [...by.values()].sort((a, b) => b.cents - a.cents);
  }

  /**
   * One draft for a client from their finished, noted, unbilled shifts (optionally within dates):
   * a line per shift (hours at the rate) and one for each shift's travel. The operator checks it and
   * issues it in Money, as with any draft.
   */
  bill(clientId: string, range: { from?: string; to?: string } = {}): Invoice {
    const client = this.money.client(clientId);
    if (!client) throw new MoneyError("no_client", "No such client.");
    const shifts = this.shifts(range).filter((s) => s.clientId === clientId && s.status !== "cancelled" && !s.billed && s.phase === "over" && s.note === "final");
    if (!shifts.length) throw new MoneyError("nothing_to_bill", `No finished shifts with notes for ${client.name}${range.from || range.to ? " in those dates" : ""}.`);
    const people = new Set(shifts.map((s) => s.participantName));
    const mixed = people.size > 1;
    const lines: LineInput[] = [];
    for (const s of shifts) {
      const who = mixed && s.participantName ? `${s.participantName} · ` : "";
      lines.push({ description: `${who}${s.support || "Support"} · ${shortDay(s.day)}, ${s.start}–${s.end}`, quantity: Math.round((s.minutes / 60) * 100) / 100, unitCents: s.rateCents, serviceDate: s.day });
      if (s.km > 0 && s.kmRateCents > 0) lines.push({ description: `${who}Travel · ${shortDay(s.day)}, ${s.km} km`, quantity: s.km, unitCents: s.kmRateCents, serviceDate: s.day });
    }
    const only = !mixed ? [...people][0] : "";
    const draft = this.money.createDraft({
      clientId, lines, serviceFrom: shifts[0].day, serviceTo: shifts.at(-1)!.day,
      participantName: only && only !== client.participantName ? only : "",
    }, this.actor);
    const mark = this.db.prepare("UPDATE shifts SET invoice_id = ?, updated_at = ? WHERE id = ?");
    for (const s of shifts) mark.run(draft.id, iso(), s.id);
    this.event("shifts_billed", draft.id, `${shifts.length} shift${shifts.length === 1 ? "" : "s"} for ${client.name}`);
    return draft;
  }
}

/** What Work is waiting on the operator for: notes to write, incidents to report, shifts to bill. */
export function raisedFromWork(work: Work, today: string): Raised[] {
  const out: Raised[] = [];
  const shifts = work.shifts({});
  for (const s of shifts) {
    if (s.status === "cancelled") continue;
    const who = s.participantName || s.clientName;
    if (s.phase === "over" && s.note !== "final" && !s.billed) {
      // A note is easiest written the same day; after that it presses.
      out.push({
        key: `work:note:${s.id}`, title: `Write the note for ${who}'s shift`,
        context: `${shortDay(s.day)}, ${spoken(s.start)}–${spoken(s.end)}${s.support ? ` · ${s.support}` : ""}.${s.note === "draft" ? " There's a draft to finish." : ""} Billing waits on it.`,
        source: "work", ref: `/work/shift/${s.id}`, dueOn: s.day, urgency: s.day < addDays(today, -1) ? 2 : 1, blocking: true,
      });
    }
    if (s.incident && !s.incidentReported) {
      out.push({
        key: `work:incident:${s.id}`, title: `Report the incident from ${who}'s shift`,
        context: `Noted on ${shortDay(s.day)}. Check the NDIS Commission's current rules for how quickly it must be reported, then mark it reported here.`,
        source: "work", ref: `/work/shift/${s.id}`, urgency: 3, blocking: true,
      });
    }
  }
  for (const b of work.billable().filter((x) => x.shifts > 0)) {
    out.push({
      key: `work:bill:${b.clientId}`, title: `Bill ${b.clientName} for ${b.shifts} shift${b.shifts === 1 ? "" : "s"}`,
      context: `${aud(b.cents)}, ${shortDay(b.from)}${b.to !== b.from ? ` to ${shortDay(b.to)}` : ""}. Makes a draft for you to check.`,
      source: "work", ref: `/work/bill/${b.clientId}`, cents: b.cents, urgency: 1,
    });
  }
  return out;
}
