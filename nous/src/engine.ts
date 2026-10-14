// Nous's rules: what a company, its team, its rooms, tasks, talk and documents are, and what may
// change them. Both the native API and the translator call these, so there's one set of rules
// spoken in two vocabularies.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "./store.js";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const OPERATOR = "operator";

export class NousError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
const notFound = (what: string) => new NousError(404, "not_found", `No such ${what}.`);

/** Who's asking: the operator (their token), or a member on a run (its token). */
export type Who = { kind: "operator" } | { kind: "member"; memberId: string; companyId: string; runId: string };

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export type Priority = "critical" | "high" | "medium" | "low";
const STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];
export const CLOSED: TaskStatus[] = ["done", "cancelled"];

export interface Company { id: string; name: string; prefix: string; createdAt: string; updatedAt: string }
export interface Member { id: string; companyId: string; name: string; role: string; title: string; capabilities: string; status: "idle" | "working" | "paused" | "let_go"; createdAt: string; updatedAt: string }
export interface Room { id: string; companyId: string; name: string; brief: string | null; status: string; leadId: string | null; color: string | null; archivedAt: string | null; createdAt: string; updatedAt: string }
export interface Task {
  id: string; companyId: string; roomId: string | null; parentId: string | null; identifier: string; number: number;
  title: string; description: string; status: TaskStatus; priority: Priority;
  /** Who it's with: a member, or the operator (forOperator), or nobody yet. */
  assigneeId: string | null; forOperator: boolean;
  /** Who made it: a member, or the operator (null). */
  authorId: string | null;
  heldByRun: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
}
export interface Message { id: string; taskId: string; companyId: string; authorId: string | null; runId: string | null; body: string; requestId: string | null; createdAt: string }
export interface Doc { id: string; taskId: string; companyId: string; key: string; title: string; format: string; body: string; revision: number; authorId: string | null; createdAt: string; updatedAt: string }

export interface Question { id: string; prompt: string; helpText?: string | null; selectionMode: "single" | "multi"; required?: boolean; allowOther?: boolean; options: Array<{ id: string; label: string; description?: string | null; freeText?: boolean }> }
export interface Answer { questionId: string; optionIds: string[]; otherText: string | null }
export interface Card {
  id: string; taskId: string; companyId: string; kind: string; title: string | null;
  payload: { version?: number; title?: string | null; submitLabel?: string | null; questions: Question[] };
  status: "pending" | "answered" | "withdrawn"; authorId: string | null; answers: Answer[] | null; answeredAt: string | null; createdAt: string; updatedAt: string;
}
export interface Approval {
  id: string; companyId: string; type: string; payload: Record<string, unknown>; status: "pending" | "approved" | "rejected"; note: string | null;
  requestedBy: string | null; taskIds: string[]; decidedAt: string | null; createdAt: string; updatedAt: string;
}

/** A company brought in whole from another engine: ids, numbers and times kept. */
export interface ImportBatch {
  company: { id: string; name: string; prefix: string; nextNumber?: number; createdAt: string; updatedAt: string };
  members: Array<{ id: string; name: string; role: string; title: string; capabilities: string; status: Member["status"]; mailboxKey?: string | null; createdAt: string; updatedAt: string }>;
  rooms: Array<{ id: string; name: string; brief: string | null; status: string; leadId: string | null; color: string | null; archivedAt: string | null; createdAt: string; updatedAt: string }>;
  tasks: Array<{ id: string; roomId: string | null; parentId: string | null; number: number; title: string; description: string; status: TaskStatus; priority: Priority; assigneeId: string | null; forOperator: boolean; authorId: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string }>;
  messages: Array<{ id: string; taskId: string; authorId: string | null; body: string; requestId: string | null; createdAt: string }>;
  docs: Array<{ id: string; taskId: string; key: string; title: string; format: string; body: string; revision: number; authorId: string | null; createdAt: string; updatedAt: string }>;
  cards: Array<{ id: string; taskId: string; kind: string; title: string | null; payload: Card["payload"]; status: Card["status"]; authorId: string | null; answers: Answer[] | null; answeredAt: string | null; createdAt: string; updatedAt: string }>;
  approvals: Array<{ id: string; type: string; payload: Record<string, unknown>; status: Approval["status"]; note: string | null; requestedBy: string | null; taskIds: string[]; decidedAt: string | null; createdAt: string; updatedAt: string }>;
}

/** Why a member is woken. */
export type WakeReason = "assigned" | "message" | "mention" | "answer" | "decision" | "unfinished";
export interface WakeDetails { messageId?: string; cardId?: string; approvalId?: string; approvalStatus?: string }
export type Waker = (memberId: string, taskId: string | null, reason: WakeReason, details: WakeDetails) => void;

/** What changed, for whoever's listening (the live stream). */
export type Change =
  | { kind: "task"; companyId: string; taskId: string; roomId: string | null; action: string; by: Who }
  | { kind: "message"; companyId: string; taskId: string; roomId: string | null; messageId: string; by: Who }
  | { kind: "member"; companyId: string; memberId: string; status: string }
  | { kind: "approval"; companyId: string; approvalId: string; status: string }
  | { kind: "run"; companyId: string; runId: string; memberId: string; taskId: string | null; status: string };

const now = () => new Date().toISOString();

/** "Contract jobs 1a2b" -> "CON": three letters from the name, the way task identifiers begin. */
export function prefixFor(name: string): string {
  return name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "OGD";
}

const company = (r: any): Company => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, updatedAt: r.updated_at });
/** An approval asking for a new member. Members ask; the operator's yes creates the member (see decide). */
export const HIRE = "hire_agent";

const member = (r: any): Member => ({ id: r.id, companyId: r.company_id, name: r.name, role: r.role, title: r.title, capabilities: r.capabilities, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });
const room = (r: any): Room => ({ id: r.id, companyId: r.company_id, name: r.name, brief: r.brief, status: r.status, leadId: r.lead_id, color: r.color, archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at });
const task = (r: any): Task => ({
  id: r.id, companyId: r.company_id, roomId: r.room_id, parentId: r.parent_id, identifier: `${r.prefix}-${r.number}`, number: r.number,
  title: r.title, description: r.description, status: r.status, priority: r.priority, assigneeId: r.assignee_id, forOperator: !!r.for_operator,
  authorId: r.author_id, heldByRun: r.held_by_run, startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
const message = (r: any): Message => ({ id: r.id, taskId: r.task_id, companyId: r.company_id, authorId: r.author_id, runId: r.run_id, body: r.body, requestId: r.request_id, createdAt: r.created_at });
const doc = (r: any): Doc => ({ id: r.id, taskId: r.task_id, companyId: r.company_id, key: r.key, title: r.title, format: r.format, body: r.body, revision: r.revision, authorId: r.author_id, createdAt: r.created_at, updatedAt: r.updated_at });
const card = (r: any): Card => ({
  id: r.id, taskId: r.task_id, companyId: r.company_id, kind: r.kind, title: r.title, payload: JSON.parse(r.payload), status: r.status, authorId: r.author_id,
  answers: r.answer ? JSON.parse(r.answer) : null, answeredAt: r.answered_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** The members a message names: [@Name](agent://<id>). */
export function mentionsIn(body: string): string[] {
  return [...new Set([...body.matchAll(/\]\(agent:\/\/([0-9a-fA-F-]{36})\)/g)].map((m) => m[1].toLowerCase()))];
}

const TASK_SELECT = "SELECT t.*, c.prefix FROM tasks t JOIN companies c ON c.id = t.company_id";

export interface TaskPatch {
  title?: string; description?: string; status?: TaskStatus; priority?: Priority;
  assigneeId?: string | null; forOperator?: boolean; roomId?: string | null; parentId?: string | null;
}

export class Engine {
  readonly changes = new EventEmitter();
  /** Set by the work loop: how a member is woken. */
  waker: Waker | null = null;

  /** keysDir: where each member's mailbox key is written (what its seat or live worker takes jobs with). */
  constructor(readonly db: Db, readonly opts: { keysDir?: string } = {}) {
    this.changes.setMaxListeners(0);
  }

  emit(change: Change): void {
    this.changes.emit("change", change);
  }

  private wake(memberId: string, taskId: string | null, reason: WakeReason, details: WakeDetails = {}): void {
    this.waker?.(memberId, taskId, reason, details);
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** A member may act only within its own company: anything of another's looks exactly like nothing at all. */
  private sameCompany(who: Who, companyId: string, what = "company"): void {
    if (who.kind === "member" && who.companyId !== companyId) throw notFound(what);
  }

  // Companies ------------------------------------------------------------------------------------

  createCompany(name: string): Company {
    if (!name?.trim()) throw new NousError(400, "bad_request", "A company needs a name.");
    const id = randomUUID();
    const at = now();
    this.db.prepare("INSERT INTO companies (id, name, prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, name.trim(), prefixFor(name), at, at);
    return this.company(id);
  }

  company(id: string, who?: Who): Company {
    if (who) this.sameCompany(who, id);
    const r = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
    if (!r) throw notFound("company");
    return company(r);
  }

  companies(): Company[] {
    return (this.db.prepare("SELECT * FROM companies ORDER BY created_at").all() as any[]).map(company);
  }

  // The team ----------------------------------------------------------------------------------------

  createMember(companyId: string, input: { name: string; role?: string; title?: string; capabilities?: string }): Member {
    this.company(companyId);
    if (!input.name?.trim()) throw new NousError(400, "bad_request", "A member needs a name.");
    const id = randomUUID();
    const at = now();
    // Its mailbox key: written for its seat to read, kept here only as a hash.
    const key = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO members (id, company_id, name, role, title, capabilities, mailbox_key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, companyId, input.name.trim(), input.role ?? "general", input.title ?? "", input.capabilities ?? "", sha256(key), at, at);
    if (this.opts.keysDir) {
      mkdirSync(this.opts.keysDir, { recursive: true });
      const file = join(this.opts.keysDir, `${id}.key`);
      writeFileSync(file, key, { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        // Windows: the file sits under the operator's profile.
      }
    }
    return this.member(id);
  }

  /** The member a mailbox key belongs to (never a member who's been let go). */
  memberByMailboxKey(key: string): Member | null {
    const r = this.db.prepare("SELECT * FROM members WHERE mailbox_key_hash = ? AND status != 'let_go'").get(sha256(key));
    return r ? member(r) : null;
  }

  member(id: string, who?: Who): Member {
    const r = this.db.prepare("SELECT * FROM members WHERE id = ?").get(id);
    if (!r) throw notFound("member");
    const m = member(r);
    if (who) this.sameCompany(who, m.companyId, "member");
    return m;
  }

  members(companyId: string, who?: Who): Member[] {
    if (who) this.sameCompany(who, companyId);
    return (this.db.prepare("SELECT * FROM members WHERE company_id = ? ORDER BY created_at").all(companyId) as any[]).map(member);
  }

  /** Pause or resume a member. Only the operator decides that. */
  setPaused(id: string, paused: boolean): Member {
    const m = this.member(id);
    if (m.status === "let_go") throw new NousError(409, "let_go", "That member has been let go.");
    const status = paused ? "paused" : "idle";
    this.db.prepare("UPDATE members SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    this.emit({ kind: "member", companyId: m.companyId, memberId: id, status });
    return this.member(id);
  }

  // Rooms -------------------------------------------------------------------------------------------

  createRoom(companyId: string, input: { name: string; brief?: string | null; status?: string; leadId?: string | null; color?: string | null }): Room {
    this.company(companyId);
    if (!input.name?.trim()) throw new NousError(400, "bad_request", "A room needs a name.");
    if (input.leadId) this.member(input.leadId);
    const id = randomUUID();
    const at = now();
    this.db.prepare("INSERT INTO rooms (id, company_id, name, brief, status, lead_id, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, companyId, input.name.trim(), input.brief ?? null, input.status ?? "in_progress", input.leadId ?? null, input.color ?? null, at, at);
    return this.room(id);
  }

  room(id: string, who?: Who): Room {
    const r = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(id);
    if (!r) throw notFound("room");
    const x = room(r);
    if (who) this.sameCompany(who, x.companyId, "room");
    return x;
  }

  rooms(companyId: string, who?: Who): Room[] {
    if (who) this.sameCompany(who, companyId);
    return (this.db.prepare("SELECT * FROM rooms WHERE company_id = ? ORDER BY updated_at DESC").all(companyId) as any[]).map(room);
  }

  // Tasks -------------------------------------------------------------------------------------------

  task(id: string, who?: Who): Task {
    const r = this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
    if (!r) throw notFound("task");
    const t = task(r);
    if (who) this.sameCompany(who, t.companyId, "task");
    return t;
  }

  /** Newest first. assignee: "me" is whoever asks (the operator, or the member on its run). */
  tasks(companyId: string, filter: { roomId?: string; assignee?: string; statuses?: TaskStatus[]; limit?: number } = {}, who?: Who): Task[] {
    if (who) this.sameCompany(who, companyId);
    const where = ["t.company_id = ?"];
    const params: Array<string | number> = [companyId];
    if (filter.roomId) where.push("t.room_id = ?"), params.push(filter.roomId);
    if (filter.assignee === "me") {
      if (who?.kind === "member") where.push("t.assignee_id = ?"), params.push(who.memberId);
      else where.push("t.for_operator = 1");
    } else if (filter.assignee) where.push("t.assignee_id = ?"), params.push(filter.assignee);
    if (filter.statuses?.length) where.push(`t.status IN (${filter.statuses.map(() => "?").join(",")})`), params.push(...filter.statuses);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return (this.db.prepare(`${TASK_SELECT} WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ${limit}`).all(...params) as any[]).map(task);
  }

  createTask(companyId: string, input: TaskPatch & { title: string }, who: Who): Task {
    this.company(companyId, who);
    if (!input.title?.trim()) throw new NousError(400, "bad_request", "A task needs a title.");
    const status = input.status ?? "todo";
    this.checkFields(companyId, { ...input, status });
    if (status === "in_progress" && !input.assigneeId && !input.forOperator) throw new NousError(422, "needs_assignee", "A task in progress needs someone on it.");
    const id = randomUUID();
    const at = now();
    this.tx(() => {
      const { next_number } = this.db.prepare("SELECT next_number FROM companies WHERE id = ?").get(companyId) as { next_number: number };
      this.db.prepare("UPDATE companies SET next_number = next_number + 1, updated_at = ? WHERE id = ?").run(at, companyId);
      this.db.prepare(`INSERT INTO tasks (id, company_id, room_id, parent_id, number, title, description, status, priority, assignee_id, for_operator, author_id, started_at, finished_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, companyId, input.roomId ?? null, input.parentId ?? null, next_number, input.title.trim(), input.description ?? "", status, input.priority ?? "medium",
        input.assigneeId ?? null, input.forOperator ? 1 : 0, who.kind === "member" ? who.memberId : null,
        status === "in_progress" ? at : null, CLOSED.includes(status) ? at : null, at, at,
      );
    });
    const t = this.task(id);
    this.emit({ kind: "task", companyId, taskId: id, roomId: t.roomId, action: "created", by: who });
    // Given to a member (by someone else): the member wakes to it.
    if (t.assigneeId && !CLOSED.includes(t.status) && !(who.kind === "member" && who.memberId === t.assigneeId)) this.wake(t.assigneeId, id, "assigned");
    return t;
  }

  updateTask(id: string, patch: TaskPatch, who: Who): Task {
    const cur = this.task(id, who);
    this.checkFields(cur.companyId, patch);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Task;
    if (patch.assigneeId) next.forOperator = false;
    if (patch.forOperator) next.assigneeId = null;
    if (next.status === "in_progress" && !next.assigneeId && !next.forOperator) throw new NousError(422, "needs_assignee", "A task in progress needs someone on it.");
    // A member can't park a task in review unless something there owns the next step.
    if (who.kind === "member" && next.status === "in_review" && cur.status !== "in_review" && !this.somethingWaiting(id)) {
      throw new NousError(422, "nothing_to_review", "A task goes to review only when a card or an approval on it is waiting on the operator. Keep working, or ask first.");
    }
    const at = now();
    const startedAt = next.status === "in_progress" && !cur.startedAt ? at : cur.startedAt;
    const finishedAt = CLOSED.includes(next.status) ? (CLOSED.includes(cur.status) ? cur.finishedAt : at) : null;
    this.db.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, for_operator = ?, room_id = ?, parent_id = ?,
      started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(
      next.title, next.description, next.status, next.priority, next.assigneeId, next.forOperator ? 1 : 0, next.roomId, next.parentId, startedAt, finishedAt, at, id,
    );
    const t = this.task(id);
    this.emit({ kind: "task", companyId: t.companyId, taskId: id, roomId: t.roomId, action: "updated", by: who });
    if (t.assigneeId && t.assigneeId !== cur.assigneeId && !CLOSED.includes(t.status) && !(who.kind === "member" && who.memberId === t.assigneeId)) this.wake(t.assigneeId, id, "assigned");
    return t;
  }

  /** A pending card on the task, or a pending approval for it: something waiting on the operator. */
  private somethingWaiting(taskId: string): boolean {
    return !!(
      this.db.prepare("SELECT 1 FROM cards WHERE task_id = ? AND status = 'pending'").get(taskId) ??
      this.db.prepare("SELECT 1 FROM approval_tasks at JOIN approvals a ON a.id = at.approval_id WHERE at.task_id = ? AND a.status = 'pending'").get(taskId)
    );
  }

  private checkFields(companyId: string, p: TaskPatch): void {
    if (p.status !== undefined && !STATUSES.includes(p.status)) throw new NousError(400, "bad_request", `A task's status is one of: ${STATUSES.join(", ")}.`);
    if (p.priority !== undefined && !PRIORITIES.includes(p.priority)) throw new NousError(400, "bad_request", `A task's priority is one of: ${PRIORITIES.join(", ")}.`);
    if (p.title !== undefined && !p.title.trim()) throw new NousError(400, "bad_request", "A task needs a title.");
    for (const [field, value, get] of [
      ["assignee", p.assigneeId, (x: string) => this.member(x)],
      ["room", p.roomId, (x: string) => this.room(x)],
      ["parent task", p.parentId, (x: string) => this.task(x)],
    ] as const) {
      if (value && get(value).companyId !== companyId) throw new NousError(400, "bad_request", `That ${field} belongs to another company.`);
    }
  }

  // Talk ----------------------------------------------------------------------------------------------

  /** Say something on a task. The same requestId twice is one message: a retry never posts twice. */
  say(taskId: string, body: string, who: Who, requestId?: string | null): Message {
    const t = this.task(taskId, who);
    if (!body?.trim()) throw new NousError(400, "bad_request", "A message needs something in it.");
    if (requestId) {
      const seen = this.db.prepare("SELECT m.*, t.company_id FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.task_id = ? AND m.request_id = ?").get(taskId, requestId);
      if (seen) return message(seen);
    }
    const id = randomUUID();
    const at = now();
    this.db.prepare("INSERT INTO messages (id, task_id, author_id, run_id, body, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, taskId, who.kind === "member" ? who.memberId : null, who.kind === "member" ? who.runId : null, body, requestId ?? null, at);
    this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, taskId);
    const m = this.message(id);
    this.emit({ kind: "message", companyId: t.companyId, taskId, roomId: t.roomId, messageId: id, by: who });
    // Whoever the task is with hears it; whoever's named is woken too (each once, never the speaker).
    const author = who.kind === "member" ? who.memberId : null;
    if (t.assigneeId && t.assigneeId !== author && t.status !== "cancelled") this.wake(t.assigneeId, taskId, "message", { messageId: id });
    for (const named of mentionsIn(body)) {
      if (named === author || named === t.assigneeId) continue;
      const r = this.db.prepare("SELECT company_id FROM members WHERE id = ?").get(named) as { company_id: string } | undefined;
      if (r?.company_id === t.companyId) this.wake(named, taskId, "mention", { messageId: id });
    }
    return m;
  }

  message(id: string): Message {
    const r = this.db.prepare("SELECT m.*, t.company_id FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.id = ?").get(id);
    if (!r) throw notFound("message");
    return message(r);
  }

  /** A task's talk, newest first unless asked otherwise; limit keeps the newest (or oldest) N. */
  messages(taskId: string, opts: { newestFirst?: boolean; limit?: number } = {}, who?: Who): Message[] {
    this.task(taskId, who);
    const order = opts.newestFirst === false ? "ASC" : "DESC";
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    return (this.db.prepare(`SELECT m.*, t.company_id FROM messages m JOIN tasks t ON t.id = m.task_id WHERE m.task_id = ? ORDER BY m.created_at ${order}, m.rowid ${order} LIMIT ${limit}`).all(taskId) as any[]).map(message);
  }

  // Documents -----------------------------------------------------------------------------------------

  putDoc(taskId: string, key: string, input: { title?: string; format?: string; body?: string }, who: Who): Doc {
    const t = this.task(taskId, who);
    if (!/^[\w.-]{1,80}$/.test(key)) throw new NousError(400, "bad_request", "A document's key is letters, digits, dots, dashes or underscores.");
    const at = now();
    const cur = this.db.prepare("SELECT * FROM docs WHERE task_id = ? AND key = ?").get(taskId, key) as any;
    if (cur) {
      this.db.prepare("UPDATE docs SET title = ?, format = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(input.title ?? cur.title, input.format ?? cur.format, input.body ?? cur.body, at, cur.id);
    } else {
      this.db.prepare("INSERT INTO docs (id, task_id, key, title, format, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), taskId, key, input.title ?? key, input.format ?? "markdown", input.body ?? "", who.kind === "member" ? who.memberId : null, at, at);
    }
    this.emit({ kind: "task", companyId: t.companyId, taskId, roomId: t.roomId, action: "document", by: who });
    return this.doc(taskId, key)!;
  }

  doc(taskId: string, key: string, who?: Who): Doc | null {
    this.task(taskId, who);
    const r = this.db.prepare("SELECT d.*, t.company_id FROM docs d JOIN tasks t ON t.id = d.task_id WHERE d.task_id = ? AND d.key = ?").get(taskId, key);
    return r ? doc(r) : null;
  }

  docs(taskId: string, who?: Who): Doc[] {
    this.task(taskId, who);
    return (this.db.prepare("SELECT d.*, t.company_id FROM docs d JOIN tasks t ON t.id = d.task_id WHERE d.task_id = ? ORDER BY d.updated_at DESC").all(taskId) as any[]).map(doc);
  }

  // Cards: questions for the operator ------------------------------------------------------------

  createCard(taskId: string, input: { kind?: string; title?: string | null; payload: Card["payload"] }, who: Who): Card {
    const t = this.task(taskId, who);
    const kind = input.kind ?? "ask_user_questions";
    if (kind !== "ask_user_questions") throw new NousError(400, "bad_request", "Nous's cards ask questions (kind: ask_user_questions).");
    const questions = input.payload?.questions;
    if (!Array.isArray(questions) || !questions.length) throw new NousError(400, "bad_request", "A card needs at least one question.");
    for (const q of questions) {
      if (!q?.id || !q.prompt || !["single", "multi"].includes(q.selectionMode) || !Array.isArray(q.options)) {
        throw new NousError(400, "bad_request", "Each question needs an id, a prompt, a selectionMode (single or multi) and options.");
      }
    }
    const id = randomUUID();
    const at = now();
    this.db.prepare("INSERT INTO cards (id, task_id, kind, title, payload, author_id, run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, taskId, kind, input.title ?? input.payload.title ?? null, JSON.stringify(input.payload), who.kind === "member" ? who.memberId : null, who.kind === "member" ? who.runId : null, at, at);
    this.emit({ kind: "task", companyId: t.companyId, taskId, roomId: t.roomId, action: "card", by: who });
    return this.card(id);
  }

  card(id: string, who?: Who): Card {
    const r = this.db.prepare("SELECT c.*, t.company_id FROM cards c JOIN tasks t ON t.id = c.task_id WHERE c.id = ?").get(id);
    if (!r) throw notFound("card");
    const c = card(r);
    if (who) this.sameCompany(who, c.companyId, "card");
    return c;
  }

  cards(taskId: string, who?: Who): Card[] {
    this.task(taskId, who);
    return (this.db.prepare("SELECT c.*, t.company_id FROM cards c JOIN tasks t ON t.id = c.task_id WHERE c.task_id = ? ORDER BY c.created_at").all(taskId) as any[]).map(card);
  }

  /** The operator answers a card; whoever asked wakes to the answers. */
  answerCard(id: string, answers: Answer[]): Card {
    const c = this.card(id);
    if (c.status !== "pending") throw new NousError(409, "already_answered", "That card has been answered already.");
    const known = new Set(c.payload.questions.map((q) => q.id));
    const clean = (Array.isArray(answers) ? answers : [])
      .filter((a) => known.has(a?.questionId))
      .map((a) => ({ questionId: a.questionId, optionIds: Array.isArray(a.optionIds) ? a.optionIds.map(String) : [], otherText: a.otherText ?? null }));
    const at = now();
    this.db.prepare("UPDATE cards SET status = 'answered', answer = ?, answered_at = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(clean), at, at, id);
    const t = this.task(c.taskId);
    this.emit({ kind: "task", companyId: c.companyId, taskId: c.taskId, roomId: t.roomId, action: "card_answered", by: { kind: "operator" } });
    if (c.authorId) this.wake(c.authorId, c.taskId, "answer", { cardId: id });
    return this.card(id);
  }

  // Approvals --------------------------------------------------------------------------------------

  createApproval(companyId: string, input: { type: string; payload?: Record<string, unknown>; taskIds?: string[] }, who: Who): Approval {
    this.company(companyId, who);
    if (!input.type?.trim()) throw new NousError(400, "bad_request", "An approval needs a type.");
    const taskIds = [...new Set(input.taskIds ?? [])];
    for (const t of taskIds) if (this.task(t, who).companyId !== companyId) throw new NousError(400, "bad_request", "Those tasks belong to another company.");
    const payload = { ...(input.payload ?? {}) };
    if (input.type === HIRE) {
      // Checked now, so the operator's yes can't fail later; the member's id is Nous's to fill in.
      if (typeof payload.name !== "string" || !payload.name.trim()) throw new NousError(422, "needs_name", "A hire needs a name (payload.name).");
      delete payload.memberId;
    }
    const id = randomUUID();
    const at = now();
    this.tx(() => {
      this.db.prepare("INSERT INTO approvals (id, company_id, type, payload, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, companyId, input.type, JSON.stringify(payload), who.kind === "member" ? who.memberId : null, at, at);
      for (const t of taskIds) this.db.prepare("INSERT INTO approval_tasks (approval_id, task_id) VALUES (?, ?)").run(id, t);
    });
    this.emit({ kind: "approval", companyId, approvalId: id, status: "pending" });
    return this.approval(id);
  }

  approval(id: string, who?: Who): Approval {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as any;
    if (!r) throw notFound("approval");
    if (who) this.sameCompany(who, r.company_id, "approval");
    const taskIds = (this.db.prepare("SELECT task_id FROM approval_tasks WHERE approval_id = ?").all(id) as Array<{ task_id: string }>).map((x) => x.task_id);
    return {
      id: r.id, companyId: r.company_id, type: r.type, payload: JSON.parse(r.payload), status: r.status, note: r.note, requestedBy: r.requested_by,
      taskIds, decidedAt: r.decided_at, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** The operator decides. Whoever asked is told either way, with the note. */
  decide(id: string, approve: boolean, note: string | null): Approval {
    const a = this.approval(id);
    if (a.status !== "pending") throw new NousError(409, "already_decided", `That approval was ${a.status} already.`);
    const status = approve ? "approved" : "rejected";
    const at = now();
    const hired = this.tx(() => {
      this.db.prepare("UPDATE approvals SET status = ?, note = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(status, note, at, at, id);
      // An approved hire becomes a member, and its id goes back on the approval for whoever asked.
      if (!approve || a.type !== HIRE) return null;
      const text = (v: unknown) => (typeof v === "string" ? v : undefined);
      const m = this.createMember(a.companyId, { name: String(a.payload.name), role: text(a.payload.role), title: text(a.payload.title), capabilities: text(a.payload.capabilities) });
      this.db.prepare("UPDATE approvals SET payload = ? WHERE id = ?").run(JSON.stringify({ ...a.payload, memberId: m.id }), id);
      return m;
    });
    if (hired) this.emit({ kind: "member", companyId: a.companyId, memberId: hired.id, status: hired.status });
    this.emit({ kind: "approval", companyId: a.companyId, approvalId: id, status });
    if (a.requestedBy) this.wake(a.requestedBy, a.taskIds[0] ?? null, "decision", { approvalId: id, approvalStatus: status });
    return this.approval(id);
  }

  /** What's waiting on the operator: open cards and pending approvals, newest first. */
  waiting(companyId: string): Array<{ kind: "card"; card: Card; task: Task } | { kind: "approval"; approval: Approval }> {
    this.company(companyId);
    const cards = (this.db.prepare("SELECT c.*, t.company_id FROM cards c JOIN tasks t ON t.id = c.task_id WHERE t.company_id = ? AND c.status = 'pending'").all(companyId) as any[]).map(card);
    const approvals = (this.db.prepare("SELECT id FROM approvals WHERE company_id = ? AND status = 'pending'").all(companyId) as Array<{ id: string }>).map((r) => this.approval(r.id));
    return [
      ...cards.map((c) => ({ kind: "card" as const, card: c, task: this.task(c.taskId), at: c.createdAt })),
      ...approvals.map((a) => ({ kind: "approval" as const, approval: a, at: a.createdAt })),
    ].sort((x, y) => y.at.localeCompare(x.at)).map(({ at: _at, ...item }) => item);
  }

  // Moving in ----------------------------------------------------------------------------------------

  /**
   * Bring a company in from another engine, keeping every id, number and time, so whatever points at
   * it (Horos's seats, the app's records) still does. Idempotent: run again, it updates what's there.
   * Nothing is woken, and no run is made: history isn't work.
   */
  importBatch(input: ImportBatch): Record<string, number> {
    const b: ImportBatch = { ...input, members: input.members ?? [], rooms: input.rooms ?? [], tasks: input.tasks ?? [], messages: input.messages ?? [], docs: input.docs ?? [], cards: input.cards ?? [], approvals: input.approvals ?? [] };
    const co = b.company;
    if (!co?.id || !co.name || !co.prefix) throw new NousError(400, "bad_request", "An import names its company: id, name and prefix.");
    const nextNumber = Math.max(co.nextNumber ?? 1, ...b.tasks.map((t) => t.number + 1));
    this.tx(() => {
      this.db.pragma("defer_foreign_keys = ON");
      this.db.prepare(`INSERT INTO companies (id, name, prefix, next_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, prefix = excluded.prefix, next_number = MAX(companies.next_number, excluded.next_number), updated_at = excluded.updated_at`)
        .run(co.id, co.name, co.prefix, nextNumber, co.createdAt, co.updatedAt);
      for (const m of b.members) {
        this.db.prepare(`INSERT INTO members (id, company_id, name, role, title, capabilities, status, mailbox_key_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, title = excluded.title, capabilities = excluded.capabilities, status = excluded.status,
          mailbox_key_hash = COALESCE(excluded.mailbox_key_hash, members.mailbox_key_hash), updated_at = excluded.updated_at`)
          .run(m.id, co.id, m.name, m.role, m.title, m.capabilities, m.status, m.mailboxKey ? sha256(m.mailboxKey) : null, m.createdAt, m.updatedAt);
        if (m.mailboxKey && this.opts.keysDir) {
          mkdirSync(this.opts.keysDir, { recursive: true });
          writeFileSync(join(this.opts.keysDir, `${m.id}.key`), m.mailboxKey, { mode: 0o600 });
        }
      }
      for (const r of b.rooms) {
        this.db.prepare(`INSERT INTO rooms (id, company_id, name, brief, status, lead_id, color, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, brief = excluded.brief, status = excluded.status, lead_id = excluded.lead_id, color = excluded.color,
          archived_at = excluded.archived_at, updated_at = excluded.updated_at`)
          .run(r.id, co.id, r.name, r.brief, r.status, r.leadId, r.color, r.archivedAt, r.createdAt, r.updatedAt);
      }
      for (const t of b.tasks) {
        this.db.prepare(`INSERT INTO tasks (id, company_id, room_id, parent_id, number, title, description, status, priority, assignee_id, for_operator, author_id, started_at, finished_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, parent_id = excluded.parent_id, title = excluded.title, description = excluded.description, status = excluded.status,
          priority = excluded.priority, assignee_id = excluded.assignee_id, for_operator = excluded.for_operator, started_at = excluded.started_at, finished_at = excluded.finished_at,
          updated_at = excluded.updated_at`)
          .run(t.id, co.id, t.roomId, t.parentId, t.number, t.title, t.description, t.status, t.priority, t.assigneeId, t.forOperator ? 1 : 0, t.authorId,
            t.startedAt, t.finishedAt, t.createdAt, t.updatedAt);
      }
      for (const m of b.messages) {
        this.db.prepare("INSERT INTO messages (id, task_id, author_id, run_id, body, request_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?) ON CONFLICT DO NOTHING")
          .run(m.id, m.taskId, m.authorId, m.body, m.requestId, m.createdAt);
      }
      for (const d of b.docs) {
        this.db.prepare(`INSERT INTO docs (id, task_id, key, title, format, body, revision, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id, key) DO UPDATE SET title = excluded.title, format = excluded.format, body = excluded.body, revision = MAX(docs.revision, excluded.revision), updated_at = excluded.updated_at`)
          .run(d.id, d.taskId, d.key, d.title, d.format, d.body, d.revision, d.authorId, d.createdAt, d.updatedAt);
      }
      for (const c of b.cards) {
        this.db.prepare(`INSERT INTO cards (id, task_id, kind, title, payload, status, author_id, answer, answered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, answer = excluded.answer, answered_at = excluded.answered_at, updated_at = excluded.updated_at`)
          .run(c.id, c.taskId, c.kind, c.title, JSON.stringify(c.payload), c.status, c.authorId, c.answers ? JSON.stringify(c.answers) : null, c.answeredAt, c.createdAt, c.updatedAt);
      }
      for (const a of b.approvals) {
        this.db.prepare(`INSERT INTO approvals (id, company_id, type, payload, status, note, requested_by, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, note = excluded.note, decided_at = excluded.decided_at, updated_at = excluded.updated_at`)
          .run(a.id, co.id, a.type, JSON.stringify(a.payload), a.status, a.note, a.requestedBy, a.decidedAt, a.createdAt, a.updatedAt);
        for (const t of a.taskIds) this.db.prepare("INSERT INTO approval_tasks (approval_id, task_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(a.id, t);
      }
    });
    return this.counts(co.id);
  }

  /** How much a company holds: what an import is checked against. */
  counts(companyId: string): Record<string, number> {
    const one = (sql: string) => (this.db.prepare(sql).get(companyId) as { n: number }).n;
    return {
      members: one("SELECT COUNT(*) AS n FROM members WHERE company_id = ?"),
      rooms: one("SELECT COUNT(*) AS n FROM rooms WHERE company_id = ?"),
      tasks: one("SELECT COUNT(*) AS n FROM tasks WHERE company_id = ?"),
      messages: one("SELECT COUNT(*) AS n FROM messages m JOIN tasks t ON t.id = m.task_id WHERE t.company_id = ?"),
      docs: one("SELECT COUNT(*) AS n FROM docs d JOIN tasks t ON t.id = d.task_id WHERE t.company_id = ?"),
      cards: one("SELECT COUNT(*) AS n FROM cards c JOIN tasks t ON t.id = c.task_id WHERE t.company_id = ?"),
      approvals: one("SELECT COUNT(*) AS n FROM approvals WHERE company_id = ?"),
    };
  }

  // Claiming work ----------------------------------------------------------------------------------

  /** Whether a run is still under way (queued or running). */
  runLive(runId: string | null): boolean {
    if (!runId) return false;
    return !!this.db.prepare("SELECT 1 FROM runs WHERE id = ? AND status IN ('queued', 'running')").get(runId);
  }

  /**
   * A member on a run takes a task: it's theirs and in progress. Claiming your own task again is a
   * no-op; a task another member is working is theirs (409).
   */
  claim(taskId: string, who: Who, expected?: TaskStatus[]): Task {
    if (who.kind !== "member") throw new NousError(403, "members_only", "Only a member on a run claims a task.");
    const t = this.task(taskId, who);
    if (t.status === "in_progress" && t.assigneeId === who.memberId) {
      if (t.heldByRun !== who.runId) this.db.prepare("UPDATE tasks SET held_by_run = ? WHERE id = ?").run(who.runId, taskId);
      return this.task(taskId);
    }
    const heldByOther = t.status === "in_progress" && t.assigneeId && t.assigneeId !== who.memberId;
    if (heldByOther || (t.heldByRun && t.heldByRun !== who.runId && this.runLive(t.heldByRun) && t.assigneeId !== who.memberId)) {
      throw new NousError(409, "taken", "Another member is working on that task.");
    }
    if (expected?.length && !expected.includes(t.status)) throw new NousError(409, "not_claimable", `That task is ${t.status}, not one of: ${expected.join(", ")}.`);
    if (CLOSED.includes(t.status)) throw new NousError(409, "closed", "That task is closed.");
    const at = now();
    this.db.prepare("UPDATE tasks SET status = 'in_progress', assignee_id = ?, for_operator = 0, held_by_run = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?")
      .run(who.memberId, who.runId, at, at, taskId);
    this.emit({ kind: "task", companyId: t.companyId, taskId, roomId: t.roomId, action: "claimed", by: who });
    return this.task(taskId);
  }

  /** Let a task go: back to the queue, with nobody on it. */
  release(taskId: string, who: Who): Task {
    const t = this.task(taskId, who);
    if (who.kind === "member" && t.assigneeId !== who.memberId) throw new NousError(409, "not_yours", "Only whoever holds a task lets it go.");
    const at = now();
    const status = t.status === "in_progress" ? "todo" : t.status;
    this.db.prepare("UPDATE tasks SET status = ?, assignee_id = CASE WHEN ? = 'todo' THEN NULL ELSE assignee_id END, held_by_run = NULL, updated_at = ? WHERE id = ?").run(status, status, at, taskId);
    this.emit({ kind: "task", companyId: t.companyId, taskId, roomId: t.roomId, action: "released", by: who });
    return this.task(taskId);
  }
}
