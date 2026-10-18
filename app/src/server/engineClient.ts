// How the app speaks to Nous, Ogdoad's engine: its own API (/v1), every call signed with the operator's
// token, and its key handed over when the vault opens. The engine's words (tasks, messages, members,
// rooms) stay here; the rest of the app keeps its own.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HttpError } from "./http.js";
import { OGDOAD_HOME } from "./money/db.js";

export const NOUS_HOME = process.env.OGDOAD_NOUS_HOME ?? join(OGDOAD_HOME, "nous");
const TOKEN_FILE = join(NOUS_HOME, "operator.token");

let token: string | null = null;

/** The headers that make a call the operator's. */
export function engineAuth(): Record<string, string> {
  if (!token && existsSync(TOKEN_FILE)) token = readFileSync(TOKEN_FILE, "utf8").trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Nous's state: up or not, locked or not. */
export async function nousState(serverUrl: string): Promise<{ up: boolean; locked: boolean }> {
  try {
    const r = await fetch(`${serverUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
    const h = (await r.json()) as { locked?: boolean };
    return { up: r.ok, locked: h.locked !== false };
  } catch {
    return { up: false, locked: true };
  }
}

/** Hand Nous its key (once the vault is open). Nous keeps it until it stops: "after first unlock". */
export async function handNousKey(serverUrl: string, key: Buffer): Promise<boolean> {
  try {
    const r = await fetch(`${serverUrl}/v1/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json", ...engineAuth() },
      body: JSON.stringify({ key: key.toString("hex") }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// --- What Nous holds, as it answers -----------------------------------------------------------------

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled";
export interface NousMember { id: string; companyId: string; name: string; role: string; title: string; capabilities: string; status: "idle" | "working" | "paused" | "let_go"; createdAt: string; updatedAt: string }
export interface NousRoom { id: string; companyId: string; name: string; brief: string | null; status: string; leadId: string | null; color: string | null; archivedAt: string | null; createdAt: string; updatedAt: string }
export interface NousTask {
  id: string; companyId: string; roomId: string | null; parentId: string | null; identifier: string; number: number;
  title: string; description: string; status: TaskStatus; priority: "critical" | "high" | "medium" | "low";
  /** A member it's with, or the operator's (forOperator). */
  assigneeId: string | null; forOperator: boolean;
  /** The member who made it; null when the operator did. */
  authorId: string | null;
  heldByRun: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
}
/** authorId null: the operator wrote it. */
export interface NousMessage { id: string; taskId: string; companyId: string; authorId: string | null; runId: string | null; body: string; requestId: string | null; createdAt: string }
export interface NousDoc { id: string; taskId: string; companyId: string; key: string; title: string; format: string; body: string; revision: number; authorId: string | null; createdAt: string; updatedAt: string }
export interface NousQuestion { id: string; prompt: string; options: Array<{ id: string; label: string }> }
export interface NousCard {
  id: string; taskId: string; companyId: string; kind: string; title: string | null; payload: { title?: string | null; questions: NousQuestion[] };
  status: "pending" | "answered" | "withdrawn"; authorId: string | null; createdAt: string; updatedAt: string;
}
export interface NousApproval { id: string; companyId: string; type: string; payload: Record<string, unknown>; status: "pending" | "approved" | "rejected"; note: string | null; requestedBy: string | null; taskIds: string[]; createdAt: string; updatedAt: string }
export interface NousRun { id: string; companyId: string; memberId: string; taskId: string | null; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; startedAt: string | null }
/** What's waiting on the operator: a member's open card (with its task), or a pending approval. */
export type NousWaiting = { kind: "card"; card: NousCard; task: NousTask } | { kind: "approval"; approval: NousApproval };

const enc = encodeURIComponent;

/** Nous's /v1, as the operator. Errors come back as HttpErrors carrying Nous's own plain sentence. */
export class Nous {
  constructor(readonly base: string, private readonly timeoutMs = 8000) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.base}${path}`, {
        method,
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...engineAuth() },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new HttpError(502, "engine_down", "The Ogdoad server didn't answer. Is it running?");
    }
    const text = await r.text();
    if (!r.ok) {
      let why = "";
      try {
        const j = JSON.parse(text);
        why = String(j.message ?? j.error ?? "");
      } catch {}
      // Nous's messages are whole sentences already.
      throw new HttpError(r.status === 404 ? 404 : 502, "engine", `The Ogdoad server turned that down${why ? `: ${why}` : ` (${r.status}).`}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  private async list<T>(path: string): Promise<T[]> {
    return (await this.call<{ items: T[] }>("GET", path)).items ?? [];
  }

  members(companyId: string) {
    return this.list<NousMember>(`/v1/companies/${enc(companyId)}/members`);
  }
  setPaused(memberId: string, paused: boolean) {
    return this.call<NousMember>("PATCH", `/v1/members/${enc(memberId)}`, { paused });
  }

  rooms(companyId: string) {
    return this.list<NousRoom>(`/v1/companies/${enc(companyId)}/rooms`);
  }
  room(id: string) {
    return this.call<NousRoom>("GET", `/v1/rooms/${enc(id)}`);
  }
  createRoom(companyId: string, input: { name: string; brief?: string | null; status?: string; leadId?: string | null }) {
    return this.call<NousRoom>("POST", `/v1/companies/${enc(companyId)}/rooms`, input);
  }

  /** Newest first. assignee "me" is the operator's own. */
  tasks(companyId: string, filter: { room?: string; assignee?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (filter.room) q.set("room", filter.room);
    if (filter.assignee) q.set("assignee", filter.assignee);
    if (filter.limit) q.set("limit", String(filter.limit));
    return this.list<NousTask>(`/v1/companies/${enc(companyId)}/tasks${q.size ? `?${q}` : ""}`);
  }
  task(id: string) {
    return this.call<NousTask>("GET", `/v1/tasks/${enc(id)}`);
  }
  createTask(companyId: string, input: { title: string; description?: string; status?: TaskStatus; assigneeId?: string | null; roomId?: string | null; parentId?: string | null }) {
    return this.call<NousTask>("POST", `/v1/companies/${enc(companyId)}/tasks`, input);
  }

  /** Newest first. */
  messages(taskId: string, limit = 40) {
    return this.list<NousMessage>(`/v1/tasks/${enc(taskId)}/messages?limit=${limit}`);
  }
  say(taskId: string, body: string, requestId: string) {
    return this.call<NousMessage>("POST", `/v1/tasks/${enc(taskId)}/messages`, { body, requestId });
  }

  docs(taskId: string) {
    return this.list<NousDoc>(`/v1/tasks/${enc(taskId)}/docs`);
  }
  runs(companyId: string) {
    return this.list<NousRun>(`/v1/companies/${enc(companyId)}/runs`);
  }
  waiting(companyId: string) {
    return this.list<NousWaiting>(`/v1/companies/${enc(companyId)}/waiting`);
  }
}
