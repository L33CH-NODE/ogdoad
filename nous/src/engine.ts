// Nous's rules: what a company, its team, its rooms, tasks, talk and documents are, and what may
// change them. Both the native API and the translator call these, so there's one set of rules
// spoken in two vocabularies.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type { Db } from "./store.js";

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

/** What changed, for whoever's listening (the live stream). */
export type Change =
  | { kind: "task"; companyId: string; taskId: string; roomId: string | null; action: string; by: Who }
  | { kind: "message"; companyId: string; taskId: string; roomId: string | null; messageId: string; by: Who }
  | { kind: "member"; companyId: string; memberId: string; status: string };

const now = () => new Date().toISOString();

/** "Contract jobs 1a2b" -> "CON": three letters from the name, the way task identifiers begin. */
export function prefixFor(name: string): string {
  return name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "OGD";
}

const company = (r: any): Company => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, updatedAt: r.updated_at });
const member = (r: any): Member => ({ id: r.id, companyId: r.company_id, name: r.name, role: r.role, title: r.title, capabilities: r.capabilities, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at });
const room = (r: any): Room => ({ id: r.id, companyId: r.company_id, name: r.name, brief: r.brief, status: r.status, leadId: r.lead_id, color: r.color, archivedAt: r.archived_at, createdAt: r.created_at, updatedAt: r.updated_at });
const task = (r: any): Task => ({
  id: r.id, companyId: r.company_id, roomId: r.room_id, parentId: r.parent_id, identifier: `${r.prefix}-${r.number}`, number: r.number,
  title: r.title, description: r.description, status: r.status, priority: r.priority, assigneeId: r.assignee_id, forOperator: !!r.for_operator,
  authorId: r.author_id, heldByRun: r.held_by_run, startedAt: r.started_at, finishedAt: r.finished_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
const message = (r: any): Message => ({ id: r.id, taskId: r.task_id, companyId: r.company_id, authorId: r.author_id, runId: r.run_id, body: r.body, requestId: r.request_id, createdAt: r.created_at });
const doc = (r: any): Doc => ({ id: r.id, taskId: r.task_id, companyId: r.company_id, key: r.key, title: r.title, format: r.format, body: r.body, revision: r.revision, authorId: r.author_id, createdAt: r.created_at, updatedAt: r.updated_at });

const TASK_SELECT = "SELECT t.*, c.prefix FROM tasks t JOIN companies c ON c.id = t.company_id";

export interface TaskPatch {
  title?: string; description?: string; status?: TaskStatus; priority?: Priority;
  assigneeId?: string | null; forOperator?: boolean; roomId?: string | null; parentId?: string | null;
}

export class Engine {
  readonly changes = new EventEmitter();

  constructor(readonly db: Db) {
    this.changes.setMaxListeners(0);
  }

  private emit(change: Change): void {
    this.changes.emit("change", change);
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
    this.db.prepare("INSERT INTO members (id, company_id, name, role, title, capabilities, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, companyId, input.name.trim(), input.role ?? "general", input.title ?? "", input.capabilities ?? "", at, at);
    return this.member(id);
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
    return t;
  }

  updateTask(id: string, patch: TaskPatch, who: Who): Task {
    const cur = this.task(id, who);
    this.checkFields(cur.companyId, patch);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Task;
    if (patch.assigneeId) next.forOperator = false;
    if (patch.forOperator) next.assigneeId = null;
    if (next.status === "in_progress" && !next.assigneeId && !next.forOperator) throw new NousError(422, "needs_assignee", "A task in progress needs someone on it.");
    const at = now();
    const startedAt = next.status === "in_progress" && !cur.startedAt ? at : cur.startedAt;
    const finishedAt = CLOSED.includes(next.status) ? (CLOSED.includes(cur.status) ? cur.finishedAt : at) : null;
    this.db.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, assignee_id = ?, for_operator = ?, room_id = ?, parent_id = ?,
      started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`).run(
      next.title, next.description, next.status, next.priority, next.assigneeId, next.forOperator ? 1 : 0, next.roomId, next.parentId, startedAt, finishedAt, at, id,
    );
    const t = this.task(id);
    this.emit({ kind: "task", companyId: t.companyId, taskId: id, roomId: t.roomId, action: "updated", by: who });
    return t;
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
}
