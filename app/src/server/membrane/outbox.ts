// What the membrane holds on the way out: a message or a brief that names someone, waiting for the
// operator to see exactly what would leave (and send it, change it, keep it local, or not send it).
// It's kept in the encrypted books, with the operator's own words, until then. One left waiting
// becomes a Flow card, so nothing held is forgotten.

import { randomUUID } from "node:crypto";

import type { Raised } from "../flow/flow.js";
import type { Money } from "../money/service.js";

export type OutKind = "say" | "open" | "part" | "prompt" | "hire";
export type OutState = "held" | "sent" | "kept" | "dropped";

export interface Held { id: string; kind: OutKind; projectId: string | null; payload: any; state: OutState; resultId: string | null; createdAt: string; updatedAt: string }

const iso = () => new Date().toISOString();
const toHeld = (r: any): Held => ({ id: r.id, kind: r.kind, projectId: r.project_id, payload: JSON.parse(r.payload), state: r.state, resultId: r.result_id, createdAt: r.created_at, updatedAt: r.updated_at });

export class Outbox {
  constructor(private readonly money: Money) {}

  private get db() {
    return this.money.db;
  }

  hold(kind: OutKind, projectId: string | null, payload: unknown): Held {
    const id = randomUUID();
    const now = iso();
    this.db.prepare("INSERT INTO outbox (id, kind, project_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, kind, projectId, JSON.stringify(payload), now, now);
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'held', ?, ?)").run(now, id, kind);
    return this.get(id)!;
  }

  get(id: string): Held | null {
    const r = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get(id);
    return r ? toHeld(r) : null;
  }

  /** Still waiting (all of them, or one room's). */
  waiting(projectId?: string): Held[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM outbox WHERE state = 'held' AND project_id = ? ORDER BY created_at").all(projectId)
      : this.db.prepare("SELECT * FROM outbox WHERE state = 'held' ORDER BY created_at").all();
    return rows.map(toHeld);
  }

  change(id: string, payload: unknown): void {
    this.db.prepare("UPDATE outbox SET payload = ?, updated_at = ? WHERE id = ? AND state = 'held'").run(JSON.stringify(payload), iso(), id);
  }

  /**
   * Decided: sent (approved), kept here, or dropped (denied). The decision is noted with what it was
   * about (edited by the operator, real details sent knowingly): each one is a labelled example for a
   * local decider to learn from later.
   */
  close(id: string, state: Exclude<OutState, "held">, resultId: string | null = null, decision: Record<string, unknown> = {}): void {
    const now = iso();
    this.db.prepare("UPDATE outbox SET state = ?, result_id = ?, updated_at = ? WHERE id = ?").run(state, resultId, now, id);
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', ?, ?, ?)").run(now, `held_${state}`, id, JSON.stringify(decision));
  }
}

/** A short line of what's held, for Flow (real words: it's the operator's own screen). */
function gist(h: Held): string {
  const p = h.payload ?? {};
  const words = String(h.kind === "open" ? p.name : h.kind === "part" ? p.title : h.kind === "prompt" ? p.text : h.kind === "hire" ? p.input?.brief : p.body).replace(/\s+/g, " ").trim();
  return words.length > 90 ? `${words.slice(0, 89)}…` : words;
}

const WHAT: Record<OutKind, string> = { say: "A message", open: "A new room's brief", part: "A new part's brief", prompt: "What you typed to a hire", hire: "A new hire's first message" };

/** Held work, and alarms not yet seen, as Flow cards. A held one clears itself once it's decided. */
export function raisedFromMembrane(money: Money): Raised[] {
  const out: Raised[] = [];
  for (const h of new Outbox(money).waiting()) {
    out.push({
      key: `membrane:check:${h.id}`, title: "Check what goes out", source: "team", ref: `/flow/check/${h.id}`, urgency: 2, blocking: true,
      context: `${WHAT[h.kind]} is held: it names someone, or hints at who. "${gist(h)}". See exactly what the team would get, then send it, change it, or keep it here.`,
    });
  }
  const alarms = money.db.prepare("SELECT subject_id, detail FROM events WHERE kind = 'membrane_alarm' ORDER BY id DESC LIMIT 20").all() as Array<{ subject_id: string; detail: string }>;
  for (const a of alarms) {
    let d: any = {};
    try {
      d = JSON.parse(a.detail);
    } catch {}
    out.push({
      key: `membrane:alarm:${a.subject_id}`, title: `A real detail is in ${d.who ?? "a hire"}'s message`, source: "team", ref: d.projectId ? `/team/room/${d.projectId}` : null, urgency: 3,
      context: d.local
        ? `${d.who ?? "A local hire"} works locally, but it put a client's real detail in a room that cloud hires read, so they can read it now. Look at the message, and ask it to use stand-ins.`
        : `${d.who ?? "A hire"} wrote ${d.what ?? "a real detail"} it was never sent${d.paused ? ", so it's paused" : ""}. Look at the message, and find out how it got it. Resume it from its room once you're sure.`,
    });
  }
  return out;
}
