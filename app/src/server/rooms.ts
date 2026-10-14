// Project rooms, and the gate everything the operator writes for the team passes through.
//
// A room is a project's tasks seen as one live room. The project has a thread of its own (a task Ogdoad
// opens), and each part of the job is a sub-task of it, with a hire on it. The room shows every thread
// at once in time order, who is on the project, and who is working on which part right now. Hires talk
// to each other through the engine: a comment that mentions one wakes it.
//
// The gate: a message, a room's brief, a part's brief, what's typed into a cloud hire's terminal and a
// new hire's first message all go through the membrane first. Real identities become stand-ins. When
// the membrane changed or flagged anything, it's held for the operator's check (send, change, keep it
// local, or don't send) and sent only as checked. What leaves is noted in the crossings log, stand-ins
// and all, and the engine never holds a real identity. Coming back, every hire's message is checked,
// and a client's real detail in one is an alarm: that hire is paused.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { tokenRe, type Kind } from "../shared/standins.js";
import { harnessInfo, hireOfAgent, recipientOfAgent, recipientOfHire, recipientsOfComment, recordCrossing, recordDirectCrossing, type Recipient, type Where } from "./crossings.js";
import { propose, refuseBroken, type Lineup, type ProposedPart, type TeamMember } from "./dispatch/dispatch.js";
import { engineAuth } from "./engineClient.js";
import { hire as startHire, type HireInput } from "./hire.js";
import { HttpError, readJson, sendJson } from "./http.js";
import { Membrane, digestOf, type Change, type Warning } from "./membrane/membrane.js";
import { Outbox, type Held, type OutKind } from "./membrane/outbox.js";
import type { Flag } from "./membrane/quasi.js";
import { OGDOAD_HOME } from "./money/db.js";
import type { Money } from "./money/service.js";

export interface RoomsContext {
  serverUrl: string;
  companyId: string;
  practice: boolean;
  /** The practice copy on the old engine shares the real team (default: when practising); on its own Nous it has a made-up one. */
  sharedTeam?: boolean;
  home?: string;
  /** Horos, for what's typed into a hire's terminal and for hiring. */
  horos?: { base: string; headers: () => Record<string, string> };
  /** A client's real detail turned up in a hire's message (and the hire was paused). */
  onAlarm?: (title: string, body: string) => void;
  /** Where the membrane's local model listens (null or absent: that pass is off). */
  backstop?: string | null;
  /** Wake the local model when it's resting, and wait until it answers. */
  wakeBackstop?: () => Promise<void>;
  /** The dispatcher's model: where it listens (null: off), and how to wake it. */
  dispatch?: { url: string | null; wake?: () => Promise<void> };
}

interface EngineProject { id: string; name: string; description?: string | null; status: string; leadAgentId?: string | null; color?: string | null; createdAt: string; updatedAt: string; archivedAt?: string | null }
interface EngineIssue {
  id: string; identifier?: string | null; title: string; description?: string | null; status: string; projectId?: string | null; parentId?: string | null;
  assigneeAgentId?: string | null; assigneeUserId?: string | null; createdByAgentId?: string | null; createdByUserId?: string | null; createdAt: string; updatedAt: string;
}
interface EngineComment { id: string; body: string; createdAt: string; authorAgentId?: string | null; authorUserId?: string | null; authorType?: string }
interface EngineAgent { id: string; name: string; status?: string; role?: string | null; title?: string | null; capabilities?: string | null }
interface EngineRun { id: string; agentId: string; issueId?: string | null; status: string; startedAt?: string | null }

export interface Member { agentId: string; name: string; hireId: string | null; harness: string | null; where: Where; paused: boolean }
export interface Part {
  id: string; identifier: string | null; title: string; status: string; agentId: string | null; yours: boolean; thread: boolean; createdAt: string; updatedAt: string;
}
export type RoomMessage =
  | { id: string; at: string; partId: string; kind: "said"; from: "you" | "agent"; agentId: string | null; body: string; warnings?: Warning[] }
  | { id: string; at: string; partId: string; kind: "opened"; agentId: string | null; byYou: boolean; title: string }
  | { id: string; at: string; partId: string; kind: "note"; body: string };
export interface RoomSummary {
  id: string; name: string; status: string; color: string | null; lastAt: string; partCount: number; openCount: number;
  /** The agents on the project, and the hires behind them (for presence). */
  memberIds: string[]; memberHireIds: string[]; hasThread: boolean;
}
export interface Room extends RoomSummary {
  description: string; leadAgentId: string | null; threadId: string | null; parts: Part[]; members: Member[]; everyone: Member[];
  messages: RoomMessage[]; running: Array<{ agentId: string; issueId: string; status: string; startedAt: string | null }>;
  /** What each stand-in in the room stands for (on the operator's screen only). */
  links: Record<string, { real: string; kind: string }>;
  /** Held for the operator's check, in this room. */
  held: Array<{ id: string; kind: OutKind; createdAt: string }>;
}

/** One piece of what's going out (a message is one; a brief is its title and its body). */
export interface Piece {
  label: string; real: string; text: string; changes: Change[]; flags: Flag[];
  /** The operator wrote what goes themselves: text is theirs, sent exactly as written. */
  edited?: boolean;
  /** In an edited piece: real details the membrane would have stood in (positions in text), each with its stand-in. */
  exposed?: Change[];
}
export interface Check {
  id: string; kind: OutKind; state: Held["state"]; createdAt: string; projectId: string | null;
  /** Where it goes, in words. */
  where: string;
  reaches: Recipient[];
  pieces: Piece[];
  warn: boolean;
  hold: boolean;
  digest: string;
  /** A message in a room can be kept local instead: a note only the operator sees. */
  canKeep: boolean;
  notes: string[];
  /** What each stand-in in it stands for (on the operator's screen only). */
  links: Record<string, { real: string; kind: string }>;
}

interface SayPayload { body: string; projectId?: string | null; partId?: string | null; issueId?: string | null; clientRequestId?: string }
interface OpenPayload { name: string; brief: string; leadAgentId: string | null }
interface PartPayload { projectId: string; title: string; brief: string; agentId: string | null }
interface PromptPayload { hireId: string; text: string; label?: string; harness?: string }
interface HirePayload { input: HireInput }

const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const shortName = (name: string) => name.replace(/ - .*$/, "");
const mention = (m: { name: string; agentId: string }) => `[@${shortName(m.name)}](agent://${m.agentId})`;
const LIMIT = { name: 120, title: 240, text: 20_000 } as const;

/** Lists come back bare or wrapped, depending on the route. */
const items = <T>(v: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(v) ? v : v?.items ?? []);

/** What each kind carries that the membrane reads, in order. */
function readsOf(kind: OutKind, p: any): Array<{ label: string; real: string }> {
  if (kind === "open") return [{ label: "Name", real: p.name }, { label: "Brief", real: p.brief }];
  if (kind === "part") return [{ label: "Part", real: p.title }, { label: "Brief", real: p.brief }];
  if (kind === "prompt") return [{ label: "Typed", real: p.text }];
  if (kind === "hire") return [{ label: "First message", real: String(p.input?.brief ?? "") }];
  return [{ label: "Message", real: p.body }];
}

/** The same payload with the operator's changed words in it. */
function withReads(kind: OutKind, p: any, reals: string[]): any {
  if (kind === "open") return { ...p, name: reals[0], brief: reals[1] };
  if (kind === "part") return { ...p, title: reals[0], brief: reals[1] };
  if (kind === "prompt") return { ...p, text: reals[0] };
  if (kind === "hire") return { ...p, input: { ...p.input, brief: reals[0] } };
  return { ...p, body: reals[0] };
}

export class Rooms {
  private readonly home: string;
  private readonly membrane: Membrane;
  private readonly outbox: Outbox;
  private agentList: Promise<EngineAgent[]> | null = null;

  constructor(private readonly money: Money, private readonly ctx: RoomsContext) {
    this.home = ctx.home ?? OGDOAD_HOME;
    this.membrane = new Membrane(money);
    this.outbox = new Outbox(money);
  }

  private async engine<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.ctx.serverUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: { accept: "application/json", ...(init ? { "content-type": "application/json" } : {}), ...engineAuth() },
        body: init ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new HttpError(502, "engine_down", "The Ogdoad server didn't answer. Is it running?");
    }
    const text = await r.text();
    if (!r.ok) {
      let why = "";
      try {
        why = String(JSON.parse(text).error ?? "");
      } catch {}
      throw new HttpError(r.status === 404 ? 404 : 502, "engine", `The Ogdoad server turned that down${why ? `: ${why}` : ` (${r.status})`}.`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  /**
   * The room's thread among a project's tasks: the one these books recorded, or else a top-level task
   * named "The room: …" (opened by another copy of Ogdoad, such as the practice copy or a reinstall,
   * whose books never saw it). Found that way, it's remembered, so a room never gets a second thread.
   */
  private threadIn(projectId: string, issues: EngineIssue[]): string | null {
    const row = this.money.db.prepare("SELECT thread_issue_id FROM rooms WHERE project_id = ?").get(projectId) as { thread_issue_id: string } | undefined;
    if (row) return row.thread_issue_id;
    const found = issues.filter((i) => !i.parentId && /^The room: /.test(i.title)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!found) return null;
    this.money.db.prepare("INSERT OR IGNORE INTO rooms (project_id, thread_issue_id, opened_at) VALUES (?, ?, ?)").run(projectId, found.id, found.createdAt);
    return found.id;
  }

  private member(a: EngineAgent): Member {
    const h = hireOfAgent(a.id, this.home);
    return { agentId: a.id, name: shortName(a.name), hireId: h?.hireId ?? null, harness: h?.harness ?? null, where: h?.where ?? "unknown", paused: a.status === "paused" };
  }

  private agents(): Promise<EngineAgent[]> {
    return (this.agentList ??= this.engine<EngineAgent[] | { items: EngineAgent[] }>(`/api/companies/${this.ctx.companyId}/agents`).then(items, () => []));
  }

  /** The hires' own names: never mistaken for a client's. */
  private async protect(): Promise<string[]> {
    return (await this.agents()).map((a) => shortName(a.name));
  }

  private async issuesOf(projectId: string): Promise<EngineIssue[]> {
    const list = items(await this.engine<EngineIssue[] | { items: EngineIssue[] }>(`/api/companies/${this.ctx.companyId}/issues?projectId=${encodeURIComponent(projectId)}&limit=100`));
    // A server that ignores the filter must not leak other projects' tasks into a room.
    return list.filter((i) => !i.projectId || i.projectId === projectId);
  }

  private async project(projectId: string): Promise<EngineProject> {
    return this.engine<EngineProject>(`/api/projects/${encodeURIComponent(projectId)}`);
  }

  private summarise(p: EngineProject, issues: EngineIssue[], lastSaid?: string): RoomSummary {
    const thread = this.threadIn(p.id, issues);
    const parts = issues.filter((i) => i.id !== thread);
    const lastAt = [p.updatedAt, lastSaid, ...issues.map((i) => i.updatedAt)].filter(Boolean).sort().at(-1)!;
    const memberIds = [...new Set([p.leadAgentId, ...issues.map((i) => i.assigneeAgentId)].filter((x): x is string => !!x))];
    const memberHireIds = memberIds.map((id) => hireOfAgent(id, this.home)?.hireId).filter((x): x is string => !!x);
    return {
      id: p.id, name: this.membrane.relink(p.name), status: p.status, color: p.color ?? null, lastAt, partCount: parts.length,
      openCount: parts.filter((i) => OPEN.has(i.status)).length, memberIds, memberHireIds, hasThread: !!thread,
    };
  }

  /** Every live project as a room, the busiest first. */
  async list(): Promise<RoomSummary[]> {
    const projects = items(await this.engine<EngineProject[] | { items: EngineProject[] }>(`/api/companies/${this.ctx.companyId}/projects`)).filter((p) => !p.archivedAt);
    const rooms = await Promise.all(projects.map(async (p) => this.summarise(p, await this.issuesOf(p.id).catch(() => []))));
    return rooms.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /** One room: its parts, who's in it, everything said in it (oldest first), and who's working on what. */
  async get(projectId: string): Promise<Room> {
    const [p, issues, agents, runs] = await Promise.all([
      this.project(projectId),
      this.issuesOf(projectId),
      this.agents(),
      this.engine<EngineRun[]>(`/api/companies/${this.ctx.companyId}/live-runs`).catch(() => [] as EngineRun[]),
    ]);
    const threadId = this.threadIn(projectId, issues);
    const recent = [...issues].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
    const threads = await Promise.all(recent.map(async (i) => ({ issue: i, comments: items(await this.engine<EngineComment[]>(`/api/issues/${i.id}/comments?order=desc&limit=40`).catch((): EngineComment[] => [])) })));
    const byId = new Map(agents.map((a) => [a.id, a]));

    const messages: RoomMessage[] = [];
    const alarms: Array<{ c: EngineComment; issueId: string; warnings: Warning[] }> = [];
    for (const { issue, comments } of threads) {
      messages.push({ id: `opened-${issue.id}`, at: issue.createdAt, partId: issue.id, kind: "opened", agentId: issue.createdByAgentId ?? null, byYou: !issue.createdByAgentId, title: this.membrane.relink(issue.title) });
      for (const c of comments) {
        const fromAgent = !!c.authorAgentId || c.authorType === "agent";
        const { warnings } = this.membrane.back(c.body, { fromTeam: fromAgent });
        messages.push({ id: c.id, at: c.createdAt, partId: issue.id, kind: "said", from: fromAgent ? "agent" : "you", agentId: c.authorAgentId ?? null, body: c.body, ...(warnings.length ? { warnings } : {}) });
        if (fromAgent && warnings.some((w) => w.kind === "real")) alarms.push({ c, issueId: issue.id, warnings });
      }
    }
    const notes = this.money.db.prepare("SELECT * FROM room_notes WHERE project_id = ? ORDER BY created_at").all(projectId) as Array<{ id: string; part_id: string | null; body: string; created_at: string }>;
    for (const n of notes) messages.push({ id: `note-${n.id}`, at: n.created_at, partId: n.part_id ?? threadId ?? "", kind: "note", body: n.body });
    messages.sort((a, b) => a.at.localeCompare(b.at));

    // Who else reads this room: a local hire may hold real records, but not where cloud hires can read them.
    const readers = [p.leadAgentId, ...issues.map((i) => i.assigneeAgentId)].filter((x): x is string => !!x).map((id) => this.member(byId.get(id) ?? { id, name: "An agent" }));
    const cloudReads = readers.some((m) => m.where !== "local");
    for (const a of alarms) await this.alarm(a.c, a.issueId, projectId, a.c.authorAgentId ? this.member(byId.get(a.c.authorAgentId) ?? { id: a.c.authorAgentId, name: "A hire" }) : null, cloudReads);

    const involved = new Set<string>([p.leadAgentId, ...issues.map((i) => i.assigneeAgentId), ...messages.map((m) => ("agentId" in m ? m.agentId : null))].filter((x): x is string => !!x));
    const issueIds = new Set(issues.map((i) => i.id));
    const lastSaid = messages.at(-1)?.at;
    const shown = messages.slice(-200);
    const texts = [p.name, p.description ?? "", ...issues.map((i) => i.title), ...shown.map((m) => (m.kind === "said" ? m.body : ""))];
    // Re-read after any pause above, so the room shows it.
    const latest = alarms.length ? items(await this.engine<EngineAgent[] | { items: EngineAgent[] }>(`/api/companies/${this.ctx.companyId}/agents`).catch(() => agents)) : agents;
    const latestById = new Map(latest.map((a) => [a.id, a]));
    return {
      ...this.summarise(p, issues, lastSaid),
      description: this.membrane.relink(p.description ?? ""),
      leadAgentId: p.leadAgentId ?? null,
      threadId,
      parts: issues
        .map((i) => ({ id: i.id, identifier: i.identifier ?? null, title: this.membrane.relink(i.title), status: i.status, agentId: i.assigneeAgentId ?? null, yours: !!i.assigneeUserId, thread: i.id === threadId, createdAt: i.createdAt, updatedAt: i.updatedAt }))
        .sort((a, b) => Number(b.thread) - Number(a.thread) || a.createdAt.localeCompare(b.createdAt)),
      members: [...involved].map((id) => this.member(latestById.get(id) ?? byId.get(id) ?? { id, name: "An agent" })),
      everyone: latest.filter((a) => a.status !== "terminated").map((a) => this.member(a)),
      messages: shown,
      running: items(runs)
        .filter((r) => r.issueId && issueIds.has(r.issueId) && (r.status === "running" || r.status === "queued"))
        .map((r) => ({ agentId: r.agentId, issueId: r.issueId!, status: r.status, startedAt: r.startedAt ?? null })),
      links: this.membrane.lookup(texts.flatMap((t) => [...t.matchAll(tokenRe("gi"))].map((m) => m[0]))),
      held: this.outbox.waiting(projectId).map((h) => ({ id: h.id, kind: h.kind, createdAt: h.createdAt })),
    };
  }

  /**
   * A client's real detail in a hire's message. From a cloud (or unplaced) hire: it was never sent one,
   * so something is wrong (it read it somewhere, or someone typed it to it); it's paused, and resuming is
   * the operator's call. From a local hire: it may hold real records by design, but not where cloud hires
   * read them; that's an alarm too (the cloud can read it now), without a pause. Each noted once.
   */
  private async alarm(c: EngineComment, issueId: string, projectId: string, who: Member | null, cloudReads: boolean): Promise<void> {
    if (this.ctx.practice) return;
    if (this.money.db.prepare("SELECT 1 FROM events WHERE kind = 'membrane_alarm' AND subject_id = ?").get(c.id)) return;
    if (who?.where === "local") {
      if (!cloudReads) return;
      this.money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'ogdoad', 'membrane_alarm', ?, ?)")
        .run(new Date().toISOString(), c.id, JSON.stringify({ projectId, issueId, agentId: who.agentId, who: who.name, what: "a client's real detail where cloud hires can read it", paused: false, local: true }));
      this.ctx.onAlarm?.(`${who.name} put a real detail where the cloud can read it`, `${who.name} works locally, but its message in a room with cloud hires holds a client's real detail. Look at it in its room.`);
      return;
    }
    let paused = false;
    if (who?.agentId) paused = await this.engine(`/api/agents/${encodeURIComponent(who.agentId)}/pause`, { method: "POST", body: {} }).then(() => true, () => false);
    const name = who?.name ?? "A hire";
    this.money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'ogdoad', 'membrane_alarm', ?, ?)")
      .run(new Date().toISOString(), c.id, JSON.stringify({ projectId, issueId, agentId: who?.agentId ?? null, who: name, what: "a client's real detail", paused }));
    this.ctx.onAlarm?.(`A real detail is in ${name}'s message`, `${name} wrote a client's real detail it was never sent${paused ? ", so it's paused" : ""}. Look at it in its room.`);
  }

  private refuseInPractice(what: string): void {
    // The practice copy's books are made up; when its team is the real one, starting work is for the real app.
    if (this.ctx.sharedTeam ?? this.ctx.practice) throw new HttpError(400, "practice", `${what} from your real Ogdoad: the practice copy shares the real team.`);
  }

  private threadBrief(name: string, brief: string): string {
    return [
      brief.trim(),
      "---",
      `This is the room for the project "${name}". The operator and every hire on the project talk here, and each part of the job is a sub-task of this one.`,
      "To bring someone in, mention them in a comment, like this: [@Name](agent://their-agent-id). Whoever you mention is woken to read it.",
      "Names like C-4821, EMAIL-2210 or ADDR-1180 are stand-ins for real details the operator keeps private. Use them exactly as written, and never ask for the real ones.",
    ].filter(Boolean).join("\n\n");
  }

  private partBrief(name: string, brief: string, room: string, others: Member[]): string {
    return [
      brief.trim(),
      "---",
      `This is one part of the project "${name}". Its room is ${room}: post there to talk with the operator and the others.`,
      others.length ? `The others on this project: ${others.map(mention).join(", ")}. Mention one in a comment to bring them in.` : "",
      "Names like C-4821 are stand-ins for real details the operator keeps private. Use them exactly as written.",
    ].filter(Boolean).join("\n\n");
  }

  private noteBrief(issueId: string, agentId: string | null | undefined, text: string): void {
    if (!agentId || !text.trim()) return;
    recordCrossing(this.money, issueId, "message", Buffer.from(JSON.stringify({ body: text })), recipientOfAgent(agentId, this.home));
  }

  // --- The gate ----------------------------------------------------------------------------------

  /** Through the membrane: sent at once when there's nothing to check, or held for the operator. */
  private async through<T>(kind: OutKind, projectId: string | null, payload: any, deliver: (texts: string[]) => Promise<T>): Promise<T | { held: Check }> {
    const protect = await this.protect();
    const outs = await Promise.all(readsOf(kind, payload).map((r) => this.membrane.check(r.real, { protect, backstop: this.ctx.backstop, wake: this.ctx.wakeBackstop })));
    // The practice copy's books are made up, so it can't know the real clients' names: everything it
    // sends to the real team waits for a look.
    if (!this.ctx.practice && !outs.some((o) => o.hold)) return deliver(outs.map((o) => o.text));
    const h = this.outbox.hold(kind, projectId, payload);
    return { held: await this.checkOf(h) };
  }

  /** What a held item would send now, piece by piece, and where it goes. */
  private async checkOf(h: Held): Promise<Check> {
    const protect = await this.protect();
    const override: string[] | undefined = Array.isArray(h.payload.override) ? h.payload.override : undefined;
    const pieces = await Promise.all(readsOf(h.kind, h.payload).map(async (r, i) => {
      // The operator wrote what goes: it's theirs, sent as written. The membrane only points out any real
      // detail in it (with the stand-in it would have used), so putting one back is a choice made knowingly.
      if (override && typeof override[i] === "string") {
        const exposed = this.membrane.out(override[i], { protect }).changes;
        return { label: r.label, real: r.real, text: override[i], changes: [], flags: [], edited: true, exposed, hold: true, warn: false, model: undefined };
      }
      const o = await this.membrane.check(r.real, { protect, backstop: this.ctx.backstop, wake: this.ctx.wakeBackstop });
      return { label: r.label, real: o.real, text: o.text, changes: o.changes, flags: o.flags, hold: o.hold, warn: o.warn, model: o.model };
    }));
    const notes: string[] = [];
    if (override) notes.push("You wrote what goes. What you approve is sent exactly as it reads here.");
    if (this.ctx.practice) notes.push("The practice copy's books are made up, so it doesn't know your real clients and can't stand in their names. Check there are none in this.");
    if (pieces.some((p) => p.model === "down")) notes.push("The local model didn't answer, so only your books and the patterns checked this. Look for names they wouldn't know.");
    const { where, reaches } = await this.describe(h, pieces[0]?.text ?? "").catch(() => ({ where: "the team", reaches: [] as Recipient[] }));
    return {
      id: h.id, kind: h.kind, state: h.state, createdAt: h.createdAt, projectId: h.projectId, where, reaches,
      pieces: pieces.map(({ hold: _h, warn: _w, model: _m, ...p }) => p),
      warn: pieces.some((p) => p.warn),
      hold: this.ctx.practice || pieces.some((p) => p.hold),
      digest: digestOf(pieces),
      canKeep: h.kind === "say" && !!h.payload.projectId,
      notes,
      links: this.membrane.lookup(pieces.flatMap((p) => [...p.text.matchAll(tokenRe("gi")), ...(p.exposed ?? []).map((e) => [e.token])].map((m) => m[0]))),
    };
  }

  private async describe(h: Held, text: string): Promise<{ where: string; reaches: Recipient[] }> {
    const p = h.payload;
    if (h.kind === "open") return { where: "a new room", reaches: p.leadAgentId ? [recipientOfAgent(p.leadAgentId, this.home)] : [] };
    if (h.kind === "part") {
      const room = await this.project(p.projectId);
      return { where: `a new part in "${this.membrane.relink(room.name)}"`, reaches: p.agentId ? [recipientOfAgent(p.agentId, this.home)] : [] };
    }
    if (h.kind === "prompt") {
      const to = recipientOfHire(p.hireId, this.home, { label: p.label, harness: p.harness });
      return { where: `${to.who}'s terminal`, reaches: [to] };
    }
    if (h.kind === "hire") {
      const info = harnessInfo(String(p.input?.harness ?? ""));
      return { where: "a new hire's first message", reaches: [{ who: String(p.input?.label ?? "").trim() || "the new hire", via: info.via, where: info.where }] };
    }
    if (p.issueId) {
      const issue = await this.engine<EngineIssue>(`/api/issues/${encodeURIComponent(p.issueId)}`);
      return { where: `${issue.identifier ? `${issue.identifier}: ` : ""}${this.membrane.relink(issue.title)}`, reaches: await recipientsOfComment(p.issueId, text, this.ctx.serverUrl, this.home) };
    }
    const room = await this.project(p.projectId);
    const target = p.partId ?? this.threadIn(p.projectId, await this.issuesOf(p.projectId));
    const part = p.partId ? (await this.issuesOf(p.projectId)).find((i) => i.id === p.partId) : null;
    return {
      where: `the room "${this.membrane.relink(room.name)}"${part ? `, on ${this.membrane.relink(part.title)}` : ""}`,
      reaches: target ? await recipientsOfComment(target, text, this.ctx.serverUrl, this.home) : room.leadAgentId ? [recipientOfAgent(room.leadAgentId, this.home)] : [],
    };
  }

  private deliver(h: Held, texts: string[]): Promise<{ resultId: string; result: unknown }> {
    const p = h.payload;
    const wrap = <T>(r: Promise<T>, id: (x: T) => string) => r.then((result) => ({ resultId: id(result), result }));
    if (h.kind === "open") return wrap(this.deliverOpen(p, texts[0], texts[1]), (r) => r.id);
    if (h.kind === "part") return wrap(this.deliverPart(p, texts[0], texts[1]), (r) => r.id);
    if (h.kind === "prompt") return wrap(this.deliverPrompt(p, texts[0]), () => p.hireId);
    if (h.kind === "hire") return wrap(this.deliverHire(p, texts[0]), (r: any) => String(r?.id ?? ""));
    return wrap(this.deliverSay(p, texts[0]), (r) => r.issueId);
  }

  /** The held items still waiting, for Flow and the rooms. */
  waiting(projectId?: string): Promise<Check[]> {
    return Promise.all(this.outbox.waiting(projectId).map((h) => this.checkOf(h)));
  }

  async check(id: string): Promise<Check> {
    const h = this.outbox.get(id);
    if (!h) throw new HttpError(404, "no_check", "That isn't held any more.");
    return this.checkOf(h);
  }

  /**
   * Approved: send a held item, exactly as the operator saw it. If anything changed since, they see it
   * again. Real details the operator put back go only with a second yes (confirm): the person approving
   * is the one deciding, not the membrane or its model.
   */
  async sendHeld(id: string, digest: string, confirm = false): Promise<{ sent: unknown } | { changed: Check }> {
    const h = this.outbox.get(id);
    if (!h || h.state !== "held") throw new HttpError(409, "not_held", "That was already dealt with.");
    const c = await this.checkOf(h);
    if (c.digest !== digest) return { changed: c };
    const exposed = c.pieces.reduce((n, p) => n + (p.exposed?.length ?? 0), 0);
    if (exposed && !confirm) throw new HttpError(409, "confirm", `This sends ${exposed} real detail${exposed === 1 ? "" : "s"} as written. Approve again to send ${exposed === 1 ? "it" : "them"}.`);
    const { resultId, result } = await this.deliver(h, c.pieces.map((p) => p.text));
    this.outbox.close(id, "sent", resultId, { decision: "approved", edited: c.pieces.some((p) => p.edited), exposed, stoodIn: c.pieces.reduce((n, p) => n + p.changes.length, 0), flags: c.pieces.reduce((n, p) => n + p.flags.length, 0) });
    return { sent: result };
  }

  /** The operator writes what goes themselves (pieces), or hands it back to the membrane (null). */
  async setOutgoing(id: string, pieces: unknown): Promise<Check> {
    const h = this.outbox.get(id);
    if (!h || h.state !== "held") throw new HttpError(409, "not_held", "That was already dealt with.");
    const { override: _o, ...rest } = h.payload;
    if (pieces === null) {
      this.outbox.change(id, rest);
    } else {
      const now = readsOf(h.kind, h.payload);
      if (!Array.isArray(pieces) || pieces.length !== now.length) throw new HttpError(400, "pieces", "Send every piece back, changed or not.");
      const next = pieces.map((t) => String(t ?? "").trim());
      if (!next[0]) throw new HttpError(400, "empty", "There's nothing left to send. Deny it instead.");
      if (next.some((t) => t.length > LIMIT.text)) throw new HttpError(400, "too_long", "That's too long for one message.");
      this.outbox.change(id, { ...rest, override: next });
    }
    return this.checkOf(this.outbox.get(id)!);
  }

  /** The operator changed their words: check again. */
  async editHeld(id: string, reals: unknown): Promise<Check> {
    const h = this.outbox.get(id);
    if (!h || h.state !== "held") throw new HttpError(409, "not_held", "That was already dealt with.");
    const now = readsOf(h.kind, h.payload);
    if (!Array.isArray(reals) || reals.length !== now.length) throw new HttpError(400, "pieces", "Send every piece back, changed or not.");
    const next = reals.map((r) => String(r ?? "").trim());
    if (!next[0]) throw new HttpError(400, "empty", "There's nothing left to send. Use \"Don't send\" instead.");
    if (next.some((t) => t.length > LIMIT.text)) throw new HttpError(400, "too_long", "That's too long for one message.");
    // New words: the membrane reads them afresh, so any version the operator wrote of the old ones goes.
    const { override: _o, ...rest } = h.payload;
    this.outbox.change(id, withReads(h.kind, rest, next));
    return this.checkOf(this.outbox.get(id)!);
  }

  /** Keep a room message here instead: a note for the operator's eyes, never posted to the engine. */
  keepHeld(id: string): { kept: true } {
    const h = this.outbox.get(id);
    if (!h || h.state !== "held") throw new HttpError(409, "not_held", "That was already dealt with.");
    if (h.kind !== "say" || !h.payload.projectId) throw new HttpError(400, "cant_keep", "Only a message in a room can be kept as a note.");
    this.money.db.prepare("INSERT INTO room_notes (id, project_id, part_id, body, created_at) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), h.payload.projectId, h.payload.partId ?? null, h.payload.body, new Date().toISOString());
    this.outbox.close(id, "kept", null, { decision: "kept" });
    return { kept: true };
  }

  /** A detail the local model found: the operator says it's private, so it's stood in from now on. */
  async standInHeld(id: string, input: { text?: unknown; kind?: unknown }): Promise<Check> {
    const h = this.outbox.get(id);
    if (!h || h.state !== "held") throw new HttpError(409, "not_held", "That was already dealt with.");
    const text = String(input.text ?? "").trim();
    const kind = String(input.kind ?? "") as Kind;
    if (!text || text.length > 200) throw new HttpError(400, "text", "Say what to stand in.");
    if (!["who", "address", "email", "phone", "bank", "dob"].includes(kind)) throw new HttpError(400, "kind", "That can't be stood in.");
    if (!readsOf(h.kind, h.payload).some((r) => r.real.includes(text))) throw new HttpError(400, "text", "That isn't in what's held.");
    this.membrane.standIn(kind, text);
    return this.checkOf(h);
  }

  dropHeld(id: string): { dropped: true } {
    const h = this.outbox.get(id);
    if (!h || h.state !== "held") throw new HttpError(409, "not_held", "That was already dealt with.");
    this.outbox.close(id, "dropped", null, { decision: "denied", edited: Array.isArray(h.payload.override) });
    return { dropped: true };
  }

  // --- What goes through it ----------------------------------------------------------------------

  /** Open a room: a project, and its thread (with the lead on it, if there is one). */
  async open(input: { name?: unknown; brief?: unknown; leadAgentId?: unknown }): Promise<RoomSummary | { held: Check }> {
    this.refuseInPractice("Open rooms");
    const payload: OpenPayload = { name: String(input.name ?? "").trim(), brief: String(input.brief ?? "").trim(), leadAgentId: input.leadAgentId ? String(input.leadAgentId) : null };
    if (!payload.name) throw new HttpError(400, "name", "Give the room a name.");
    if (payload.name.length > LIMIT.name) throw new HttpError(400, "name", "Keep the name under 120 characters.");
    if (payload.brief.length > LIMIT.text) throw new HttpError(400, "brief", "The brief is too long for one message. Put the detail in a part.");
    return this.through("open", null, payload, ([name, brief]) => this.deliverOpen(payload, name, brief));
  }

  private async deliverOpen(p: OpenPayload, name: string, brief: string): Promise<RoomSummary> {
    const made = await this.engine<EngineProject>(`/api/companies/${this.ctx.companyId}/projects`, { method: "POST", body: { name, description: brief || null, status: "in_progress", leadAgentId: p.leadAgentId } });
    const thread = await this.engine<EngineIssue>(`/api/companies/${this.ctx.companyId}/issues`, {
      method: "POST",
      body: { title: `The room: ${name}`, description: this.threadBrief(name, brief), projectId: made.id, status: "todo", assigneeAgentId: p.leadAgentId },
    });
    this.money.db.prepare("INSERT INTO rooms (project_id, thread_issue_id, opened_at) VALUES (?, ?, ?)").run(made.id, thread.id, new Date().toISOString());
    this.noteBrief(thread.id, p.leadAgentId, brief || name);
    return this.summarise(made, [thread]);
  }

  /** The room's own thread, opened now if the project was started somewhere else. */
  private async ensureThread(p: EngineProject): Promise<string> {
    const known = this.threadIn(p.id, await this.issuesOf(p.id));
    if (known) return known;
    this.refuseInPractice("Start a room's thread");
    const thread = await this.engine<EngineIssue>(`/api/companies/${this.ctx.companyId}/issues`, {
      method: "POST",
      body: { title: `The room: ${p.name}`, description: this.threadBrief(p.name, p.description ?? ""), projectId: p.id, status: "todo", assigneeAgentId: p.leadAgentId ?? null },
    });
    this.money.db.prepare("INSERT INTO rooms (project_id, thread_issue_id, opened_at) VALUES (?, ?, ?)").run(p.id, thread.id, new Date().toISOString());
    return thread.id;
  }

  /** Add a part to the job: a sub-task of the room's thread, with a hire on it (or nobody yet). */
  async addPart(projectId: string, input: { title?: unknown; brief?: unknown; agentId?: unknown }): Promise<Part | { held: Check }> {
    this.refuseInPractice("Add parts");
    const payload: PartPayload = { projectId, title: String(input.title ?? "").trim(), brief: String(input.brief ?? "").trim(), agentId: input.agentId ? String(input.agentId) : null };
    if (!payload.title) throw new HttpError(400, "title", "Say what this part is.");
    if (payload.title.length > LIMIT.title) throw new HttpError(400, "title", "Keep the title under 240 characters.");
    if (payload.brief.length > LIMIT.text) throw new HttpError(400, "brief", "That brief is too long for one message.");
    await this.project(projectId);
    return this.through("part", projectId, payload, ([title, brief]) => this.deliverPart(payload, title, brief));
  }

  private async deliverPart(p: PartPayload, title: string, brief: string): Promise<Part> {
    const [room, agents] = await Promise.all([this.project(p.projectId), this.agents()]);
    const threadId = await this.ensureThread(room);
    const issues = await this.issuesOf(p.projectId);
    const thread = issues.find((i) => i.id === threadId);
    const onIt = new Set([room.leadAgentId, ...issues.map((i) => i.assigneeAgentId)].filter((x): x is string => !!x && x !== p.agentId));
    const others = agents.filter((a) => onIt.has(a.id)).map((a) => this.member(a));
    const made = await this.engine<EngineIssue>(`/api/companies/${this.ctx.companyId}/issues`, {
      method: "POST",
      body: { title, description: this.partBrief(room.name, brief, thread?.identifier ?? `"The room: ${room.name}"`, others), projectId: p.projectId, parentId: threadId, status: "todo", assigneeAgentId: p.agentId },
    });
    this.noteBrief(made.id, p.agentId, `${title}\n\n${brief}`);
    return { id: made.id, identifier: made.identifier ?? null, title: this.membrane.relink(made.title), status: made.status, agentId: p.agentId, yours: false, thread: false, createdAt: made.createdAt, updatedAt: made.updatedAt };
  }

  // --- The dispatcher ----------------------------------------------------------------------------

  /** The team as the dispatcher sees it: who each hire is, what it's for, and whether it runs locally. */
  private async teamForDispatch(): Promise<TeamMember[]> {
    return (await this.agents()).filter((a) => a.status !== "terminated").map((a) => {
      const h = hireOfAgent(a.id, this.home);
      return { agentId: a.id, name: shortName(a.name), via: h?.via ?? "the Ogdoad server", where: h?.where ?? "unknown", role: a.role ?? "general", title: a.title ?? null, capabilities: a.capabilities ?? null };
    });
  }

  /**
   * A lineup for a room, from the local dispatcher. It reads the room as the engine holds it (its name
   * and brief went through the membrane, so stand-ins only) and the parts it already has.
   */
  async proposeLineup(projectId: string): Promise<Lineup & { team: TeamMember[] }> {
    const [p, issues, team] = await Promise.all([this.project(projectId), this.issuesOf(projectId), this.teamForDispatch()]);
    const threadId = this.threadIn(projectId, issues);
    const job = { name: p.name, brief: (p.description ?? "").split(/\n\s*---\s*\n/)[0], existing: issues.filter((i) => i.id !== threadId).map((i) => i.title) };
    const lineup = await propose(job, team, { url: this.ctx.dispatch?.url ?? null, wake: this.ctx.dispatch?.wake });
    // On the operator's screen, the stand-ins read as who they are.
    return { ...lineup, parts: lineup.parts.map((x) => ({ ...x, title: this.membrane.relink(x.title), brief: this.membrane.relink(x.brief) })), team };
  }

  /**
   * The operator approves a lineup (as proposed or changed): each part is added, through the membrane
   * like any other. The rule holds here too. The decision is noted as a labelled example.
   */
  async approveLineup(projectId: string, input: { parts?: unknown; proposed?: unknown }): Promise<{ added: number; held: number; results: Array<Part | { held: Check }> }> {
    this.refuseInPractice("Add parts");
    const parts = (Array.isArray(input.parts) ? input.parts : []).map((p: any): ProposedPart => ({
      title: String(p?.title ?? ""), brief: String(p?.brief ?? ""), agentId: p?.agentId ? String(p.agentId) : null, why: String(p?.why ?? ""), needsRealData: p?.needsRealData === true,
    }));
    if (!parts.length) throw new HttpError(400, "empty", "There are no parts to add. Deny the lineup instead.");
    refuseBroken(parts, await this.teamForDispatch());
    const results: Array<Part | { held: Check }> = [];
    for (const p of parts) {
      const brief = [
        p.brief.trim(),
        p.needsRealData ? "This part needs the business's real records, so it stays with a local hire. Whatever you hand back to the room, use stand-ins (like C-4821) or totals, never real names or details: cloud hires read the room too." : "",
      ].filter(Boolean).join("\n\n");
      results.push(await this.addPart(projectId, { title: p.title, brief, agentId: p.agentId }));
    }
    const proposed = Array.isArray(input.proposed) ? input.proposed : [];
    const same = (a: any, b: ProposedPart) => a && String(a.title ?? "") === b.title && (a.agentId ?? null) === b.agentId && String(a.brief ?? "") === b.brief;
    const changed = parts.filter((p, i) => !same(proposed[i], p)).length + Math.max(0, proposed.length - parts.length);
    this.noteLineup(projectId, { decision: "approved", proposed: proposed.length, approved: parts.length, changed, realData: parts.filter((p) => p.needsRealData).length });
    const held = results.filter((r) => "held" in r).length;
    return { added: results.length - held, held, results };
  }

  denyLineup(projectId: string, input: { proposed?: unknown }): { denied: true } {
    this.noteLineup(projectId, { decision: "denied", proposed: Array.isArray(input.proposed) ? input.proposed.length : 0 });
    return { denied: true };
  }

  private noteLineup(projectId: string, detail: Record<string, unknown>): void {
    this.money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'lineup_decided', ?, ?)").run(new Date().toISOString(), projectId, JSON.stringify(detail));
  }

  /** Say something in the room: on its thread, or on one part. */
  async say(projectId: string, input: { body?: unknown; partId?: unknown }): Promise<{ ok: true; issueId: string } | { held: Check }> {
    const body = String(input.body ?? "").trim();
    if (!body) throw new HttpError(400, "body", "Nothing to send.");
    if (body.length > LIMIT.text) throw new HttpError(400, "body", "That's too long for one message.");
    const partId = input.partId ? String(input.partId) : null;
    if (partId && !(await this.issuesOf(projectId)).some((i) => i.id === partId)) throw new HttpError(404, "part", "That part isn't in this room.");
    if (!partId) await this.project(projectId);
    const payload: SayPayload = { body, projectId, partId };
    return this.through("say", projectId, payload, ([text]) => this.deliverSay(payload, text));
  }

  /** Say something on any task (SOPHIA's, a hire's): what the browser posts as a comment comes here. */
  async sayOn(issueId: string, input: { body?: unknown; clientRequestId?: unknown }): Promise<{ ok: true; issueId: string; comment: unknown } | { held: Check }> {
    const body = String(input.body ?? "").trim();
    if (!body) throw new HttpError(400, "body", "Nothing to send.");
    if (body.length > LIMIT.text) throw new HttpError(400, "body", "That's too long for one message.");
    const payload: SayPayload = { body, issueId, clientRequestId: input.clientRequestId ? String(input.clientRequestId) : undefined };
    return this.through("say", null, payload, ([text]) => this.deliverSay(payload, text));
  }

  private async deliverSay(p: SayPayload, text: string): Promise<{ ok: true; issueId: string; comment: unknown }> {
    const issueId = p.issueId ?? p.partId ?? (await this.ensureThread(await this.project(p.projectId!)));
    const comment = await this.engine(`/api/issues/${encodeURIComponent(issueId)}/comments`, { method: "POST", body: { body: text, clientRequestId: p.clientRequestId ?? randomUUID() } });
    for (const to of await recipientsOfComment(issueId, text, this.ctx.serverUrl, this.home)) {
      recordCrossing(this.money, issueId, "message", Buffer.from(JSON.stringify({ body: text })), to);
    }
    return { ok: true, issueId, comment };
  }

  /**
   * Typed into a hire's terminal. A local model may read Tier 0, so it goes as typed; anything else
   * (a cloud CLI, or a hire Ogdoad can't place) goes through the membrane.
   */
  async prompt(hireId: string, text: string, live?: { label?: string; harness?: string }): Promise<{ ok: true } | { held: Check }> {
    if (!text.trim()) throw new HttpError(400, "text", "Nothing to send.");
    const payload: PromptPayload = { hireId, text, label: live?.label, harness: live?.harness };
    if (recipientOfHire(hireId, this.home, live).where === "local" && !this.ctx.practice) return this.deliverPrompt(payload, text);
    return this.through("prompt", null, payload, ([t]) => this.deliverPrompt(payload, t));
  }

  private async deliverPrompt(p: PromptPayload, text: string): Promise<{ ok: true }> {
    if (!this.ctx.horos) throw new HttpError(503, "no_horos", "Horos isn't reachable from here.");
    const r = await fetch(`${this.ctx.horos.base}/v1/hires/${encodeURIComponent(p.hireId)}/prompt`, {
      method: "POST", headers: { "content-type": "application/json", ...this.ctx.horos.headers() }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!r?.ok) throw new HttpError(502, "horos", "Horos didn't take that. Is the hire still running?");
    recordDirectCrossing(this.money, p.hireId, text, recipientOfHire(p.hireId, this.home, { label: p.label, harness: p.harness }));
    return { ok: true };
  }

  /** Hire someone. A cloud hire's first message goes through the membrane like any other. */
  async hire(input: HireInput): Promise<unknown> {
    this.refuseInPractice("Hire");
    const payload: HirePayload = { input };
    const brief = String(input.brief ?? "").trim();
    if (!brief || harnessInfo(String(input.harness ?? "")).where === "local") return this.deliverHire(payload, brief);
    return this.through("hire", null, payload, ([b]) => this.deliverHire(payload, b));
  }

  private async deliverHire(p: HirePayload, brief: string): Promise<unknown> {
    if (!this.ctx.horos) throw new HttpError(503, "no_horos", "Horos isn't reachable from here.");
    const made = (await startHire(this.ctx.horos, this.home, { ...p.input, brief })) as { id: string; label?: string };
    if (brief) recordDirectCrossing(this.money, made.id, brief, recipientOfHire(made.id, this.home, { label: made.label, harness: String(p.input.harness ?? "") }));
    return made;
  }
}

/** /ogdoad/rooms[/:projectId[/parts|/say]] */
export async function handleRooms(money: Money, req: IncomingMessage, res: ServerResponse, url: URL, ctx: RoomsContext | null): Promise<void> {
  if (!ctx) throw new HttpError(409, "no_team", "Rooms open once SOPHIA is hired: she sets up the company they belong to.");
  const rooms = new Rooms(money, ctx);
  const [id, action] = url.pathname.split("/").filter(Boolean).slice(2); // after /ogdoad/rooms
  const method = req.method ?? "GET";
  const answer = (made: unknown) => sendJson(res, made && typeof made === "object" && "held" in made ? 202 : 201, made);
  if (!id && method === "GET") return sendJson(res, 200, { practice: ctx.sharedTeam ?? ctx.practice, rooms: await rooms.list() });
  if (!id && method === "POST") return answer(await rooms.open(await readJson(req)));
  if (id && !action && method === "GET") return sendJson(res, 200, await rooms.get(id));
  if (id && action === "parts" && method === "POST") return answer(await rooms.addPart(id, await readJson(req)));
  if (id && action === "say" && method === "POST") return answer(await rooms.say(id, await readJson(req)));
  if (id && action === "lineup" && method === "POST") {
    const decision = url.pathname.split("/").filter(Boolean)[4]; // /ogdoad/rooms/:id/lineup[/approve|/deny]
    if (!decision) return sendJson(res, 200, await rooms.proposeLineup(id));
    if (decision === "approve") return sendJson(res, 201, await rooms.approveLineup(id, await readJson(req)));
    if (decision === "deny") return sendJson(res, 200, rooms.denyLineup(id, await readJson(req)));
  }
  throw new HttpError(404, "not_found", "Nothing here.");
}

/** /ogdoad/membrane/held[/:id[/send|/edit|/keep|/drop]], /ogdoad/membrane/check and /ogdoad/membrane/links */
export async function handleMembrane(money: Money, req: IncomingMessage, res: ServerResponse, url: URL, ctx: RoomsContext | null): Promise<void> {
  const [what, id, action] = url.pathname.split("/").filter(Boolean).slice(2); // after /ogdoad/membrane
  const method = req.method ?? "GET";
  if (what === "check" && method === "POST") {
    // A quick look while typing: what would be stood in (nothing is kept, nothing is sent).
    const body = await readJson(req);
    const o = await new Membrane(money).check(String(body.text ?? "").slice(0, LIMIT.text), { protect: Array.isArray(body.protect) ? body.protect.map(String) : [], dry: true, backstop: ctx?.backstop });
    // Typing is the moment to wake the model, so it's ready by the time this is sent (no waiting here).
    if (o.model === "down") void ctx?.wakeBackstop?.();
    return sendJson(res, 200, { hold: o.hold, warn: o.warn, changes: o.changes.map((c) => ({ kind: c.kind, original: c.original })), flags: o.flags.map((f) => ({ kind: f.kind, text: f.text })) });
  }
  if (what === "links" && method === "POST") {
    // What these stand-ins stand for, for a page showing the team's words (on the operator's screen only).
    const body = await readJson(req);
    const tokens = (Array.isArray(body.tokens) ? body.tokens : []).map(String).filter((t: string) => /^[A-Z]{1,8}-[1-9][0-9]{3}$/i.test(t)).slice(0, 500);
    return sendJson(res, 200, new Membrane(money).lookup(tokens));
  }
  if (what !== "held") throw new HttpError(404, "not_found", "Nothing here.");
  if (!ctx) throw new HttpError(409, "no_team", "There's no team to send to until SOPHIA is hired.");
  const rooms = new Rooms(money, ctx);
  if (!id && method === "GET") return sendJson(res, 200, await rooms.waiting(url.searchParams.get("projectId") ?? undefined));
  if (id && !action && method === "GET") return sendJson(res, 200, await rooms.check(id));
  if (id && method === "POST") {
    const body = await readJson(req);
    if (action === "send") {
      const r = await rooms.sendHeld(id, String(body.digest ?? ""), body.confirm === true);
      // Changed since the operator looked: they get the new check to look at (not an error).
      return sendJson(res, "changed" in r ? 200 : 201, r);
    }
    if (action === "edit") return sendJson(res, 200, await rooms.editHeld(id, body.pieces));
    if (action === "keep") return sendJson(res, 200, rooms.keepHeld(id));
    if (action === "drop") return sendJson(res, 200, rooms.dropHeld(id));
    if (action === "standin") return sendJson(res, 200, await rooms.standInHeld(id, body));
    if (action === "outgoing") return sendJson(res, 200, await rooms.setOutgoing(id, body.pieces ?? null));
  }
  throw new HttpError(404, "not_found", "Nothing here.");
}
