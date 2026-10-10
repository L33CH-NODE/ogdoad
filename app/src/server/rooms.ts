// Project rooms: a project's tasks seen as one live room. The project has a thread of its own (a task
// Ogdoad opens), and each part of the job is a sub-task of it, with a hire on it. The room shows every
// thread at once in time order, who is on the project, and who is working on which part right now.
// Hires already talk to each other through the engine: a comment that mentions one wakes it. The room
// makes that visible, and every message that leaves for a hire is noted in the crossings log.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { hireOfAgent, recipientOfAgent, recipientsOfComment, recordCrossing, type Where } from "./crossings.js";
import { HttpError, readJson, sendJson } from "./http.js";
import { OGDOAD_HOME } from "./money/db.js";
import type { Money } from "./money/service.js";

export interface RoomsContext { serverUrl: string; companyId: string; practice: boolean; home?: string }

interface EngineProject { id: string; name: string; description?: string | null; status: string; leadAgentId?: string | null; color?: string | null; createdAt: string; updatedAt: string; archivedAt?: string | null }
interface EngineIssue {
  id: string; identifier?: string | null; title: string; description?: string | null; status: string; projectId?: string | null; parentId?: string | null;
  assigneeAgentId?: string | null; assigneeUserId?: string | null; createdByAgentId?: string | null; createdByUserId?: string | null; createdAt: string; updatedAt: string;
}
interface EngineComment { id: string; body: string; createdAt: string; authorAgentId?: string | null; authorUserId?: string | null; authorType?: string }
interface EngineAgent { id: string; name: string; status?: string }
interface EngineRun { id: string; agentId: string; issueId?: string | null; status: string; startedAt?: string | null }

export interface Member { agentId: string; name: string; hireId: string | null; harness: string | null; where: Where }
export interface Part {
  id: string; identifier: string | null; title: string; status: string; agentId: string | null; yours: boolean; thread: boolean; createdAt: string; updatedAt: string;
}
export type RoomMessage =
  | { id: string; at: string; partId: string; kind: "said"; from: "you" | "agent"; agentId: string | null; body: string }
  | { id: string; at: string; partId: string; kind: "opened"; agentId: string | null; byYou: boolean; title: string };
export interface RoomSummary {
  id: string; name: string; status: string; color: string | null; lastAt: string; partCount: number; openCount: number;
  /** The agents on the project, and the hires behind them (for presence). */
  memberIds: string[]; memberHireIds: string[]; hasThread: boolean;
}
export interface Room extends RoomSummary {
  description: string; leadAgentId: string | null; threadId: string | null; parts: Part[]; members: Member[]; everyone: Member[];
  messages: RoomMessage[]; running: Array<{ agentId: string; issueId: string; status: string; startedAt: string | null }>;
}

const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const shortName = (name: string) => name.replace(/ - .*$/, "");
const mention = (m: { name: string; agentId: string }) => `[@${shortName(m.name)}](agent://${m.agentId})`;

/** Lists come back bare or wrapped, depending on the route. */
const items = <T>(v: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(v) ? v : v?.items ?? []);

export class Rooms {
  private readonly home: string;

  constructor(private readonly money: Money, private readonly ctx: RoomsContext) {
    this.home = ctx.home ?? OGDOAD_HOME;
  }

  private async engine<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
    let r: Response;
    try {
      r = await fetch(`${this.ctx.serverUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: { accept: "application/json", ...(init ? { "content-type": "application/json" } : {}) },
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
      throw new HttpError(502, "engine", `The Ogdoad server turned that down${why ? `: ${why}` : ` (${r.status})`}.`);
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
    return { agentId: a.id, name: shortName(a.name), hireId: h?.hireId ?? null, harness: h?.harness ?? null, where: h?.where ?? "unknown" };
  }

  private async agents(): Promise<EngineAgent[]> {
    return items(await this.engine<EngineAgent[] | { items: EngineAgent[] }>(`/api/companies/${this.ctx.companyId}/agents`).catch(() => []));
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
    return { id: p.id, name: p.name, status: p.status, color: p.color ?? null, lastAt, partCount: parts.length, openCount: parts.filter((i) => OPEN.has(i.status)).length, memberIds, memberHireIds, hasThread: !!thread };
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

    const messages: RoomMessage[] = [];
    for (const { issue, comments } of threads) {
      messages.push({ id: `opened-${issue.id}`, at: issue.createdAt, partId: issue.id, kind: "opened", agentId: issue.createdByAgentId ?? null, byYou: !issue.createdByAgentId, title: issue.title });
      for (const c of comments) {
        const fromAgent = !!c.authorAgentId || c.authorType === "agent";
        messages.push({ id: c.id, at: c.createdAt, partId: issue.id, kind: "said", from: fromAgent ? "agent" : "you", agentId: c.authorAgentId ?? null, body: c.body });
      }
    }
    messages.sort((a, b) => a.at.localeCompare(b.at));

    const byId = new Map(agents.map((a) => [a.id, a]));
    const involved = new Set<string>([p.leadAgentId, ...issues.map((i) => i.assigneeAgentId), ...messages.map((m) => m.agentId)].filter((x): x is string => !!x));
    const issueIds = new Set(issues.map((i) => i.id));
    const lastSaid = messages.at(-1)?.at;
    return {
      ...this.summarise(p, issues, lastSaid),
      description: p.description ?? "",
      leadAgentId: p.leadAgentId ?? null,
      threadId,
      parts: issues
        .map((i) => ({ id: i.id, identifier: i.identifier ?? null, title: i.title, status: i.status, agentId: i.assigneeAgentId ?? null, yours: !!i.assigneeUserId, thread: i.id === threadId, createdAt: i.createdAt, updatedAt: i.updatedAt }))
        .sort((a, b) => Number(b.thread) - Number(a.thread) || a.createdAt.localeCompare(b.createdAt)),
      members: [...involved].map((id) => this.member(byId.get(id) ?? { id, name: "An agent" })),
      everyone: agents.filter((a) => a.status !== "terminated").map((a) => this.member(a)),
      messages: messages.slice(-200),
      running: items(runs)
        .filter((r) => r.issueId && issueIds.has(r.issueId) && (r.status === "running" || r.status === "queued"))
        .map((r) => ({ agentId: r.agentId, issueId: r.issueId!, status: r.status, startedAt: r.startedAt ?? null })),
    };
  }

  private refuseInPractice(what: string): void {
    // The practice copy's books are made up, but its team is the real one: starting work is for the real app.
    if (this.ctx.practice) throw new HttpError(400, "practice", `${what} from your real Ogdoad: the practice copy shares the real team.`);
  }

  private threadBrief(name: string, brief: string): string {
    return [
      brief.trim(),
      "---",
      `This is the room for the project "${name}". The operator and every hire on the project talk here, and each part of the job is a sub-task of this one.`,
      "To bring someone in, mention them in a comment, like this: [@Name](agent://their-agent-id). Whoever you mention is woken to read it.",
    ].filter(Boolean).join("\n\n");
  }

  private partBrief(name: string, brief: string, room: string, others: Member[]): string {
    return [
      brief.trim(),
      "---",
      `This is one part of the project "${name}". Its room is ${room}: post there to talk with the operator and the others.`,
      others.length ? `The others on this project: ${others.map(mention).join(", ")}. Mention one in a comment to bring them in.` : "",
    ].filter(Boolean).join("\n\n");
  }

  private noteBrief(issueId: string, agentId: string | null | undefined, text: string): void {
    if (!agentId || !text.trim()) return;
    recordCrossing(this.money, issueId, "message", Buffer.from(JSON.stringify({ body: text })), recipientOfAgent(agentId, this.home));
  }

  /** Open a room: a project, and its thread (with the lead on it, if there is one). */
  async open(input: { name?: unknown; brief?: unknown; leadAgentId?: unknown }): Promise<RoomSummary> {
    this.refuseInPractice("Open rooms");
    const name = String(input.name ?? "").trim();
    const brief = String(input.brief ?? "").trim();
    const lead = input.leadAgentId ? String(input.leadAgentId) : null;
    if (!name) throw new HttpError(400, "name", "Give the room a name.");
    if (name.length > 120) throw new HttpError(400, "name", "Keep the name under 120 characters.");
    if (brief.length > 20_000) throw new HttpError(400, "brief", "The brief is too long for one message. Put the detail in a part.");
    const p = await this.engine<EngineProject>(`/api/companies/${this.ctx.companyId}/projects`, { method: "POST", body: { name, description: brief || null, status: "in_progress", leadAgentId: lead } });
    const thread = await this.engine<EngineIssue>(`/api/companies/${this.ctx.companyId}/issues`, {
      method: "POST",
      body: { title: `The room: ${name}`, description: this.threadBrief(name, brief), projectId: p.id, status: "todo", assigneeAgentId: lead },
    });
    this.money.db.prepare("INSERT INTO rooms (project_id, thread_issue_id, opened_at) VALUES (?, ?, ?)").run(p.id, thread.id, new Date().toISOString());
    this.noteBrief(thread.id, lead, brief || name);
    return this.summarise(p, [thread]);
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
  async addPart(projectId: string, input: { title?: unknown; brief?: unknown; agentId?: unknown }): Promise<Part> {
    this.refuseInPractice("Add parts");
    const title = String(input.title ?? "").trim();
    const brief = String(input.brief ?? "").trim();
    const agentId = input.agentId ? String(input.agentId) : null;
    if (!title) throw new HttpError(400, "title", "Say what this part is.");
    if (title.length > 240) throw new HttpError(400, "title", "Keep the title under 240 characters.");
    const [p, agents] = await Promise.all([this.project(projectId), this.agents()]);
    const threadId = await this.ensureThread(p);
    const issues = await this.issuesOf(projectId);
    const thread = issues.find((i) => i.id === threadId);
    const onIt = new Set([p.leadAgentId, ...issues.map((i) => i.assigneeAgentId)].filter((x): x is string => !!x && x !== agentId));
    const others = agents.filter((a) => onIt.has(a.id)).map((a) => this.member(a));
    const made = await this.engine<EngineIssue>(`/api/companies/${this.ctx.companyId}/issues`, {
      method: "POST",
      body: { title, description: this.partBrief(p.name, brief, thread?.identifier ?? `"The room: ${p.name}"`, others), projectId, parentId: threadId, status: "todo", assigneeAgentId: agentId },
    });
    this.noteBrief(made.id, agentId, `${title}\n\n${brief}`);
    return { id: made.id, identifier: made.identifier ?? null, title: made.title, status: made.status, agentId, yours: false, thread: false, createdAt: made.createdAt, updatedAt: made.updatedAt };
  }

  /** Say something in the room: on its thread, or on one part. Everyone it reaches is noted. */
  async say(projectId: string, input: { body?: unknown; partId?: unknown }): Promise<{ ok: true; issueId: string }> {
    const body = String(input.body ?? "").trim();
    if (!body) throw new HttpError(400, "body", "Nothing to send.");
    if (body.length > 20_000) throw new HttpError(400, "body", "That's too long for one message.");
    let issueId: string;
    if (input.partId) {
      issueId = String(input.partId);
      const issues = await this.issuesOf(projectId);
      if (!issues.some((i) => i.id === issueId)) throw new HttpError(404, "part", "That part isn't in this room.");
    } else {
      issueId = await this.ensureThread(await this.project(projectId));
    }
    await this.engine(`/api/issues/${encodeURIComponent(issueId)}/comments`, { method: "POST", body: { body, clientRequestId: randomUUID() } });
    for (const to of await recipientsOfComment(issueId, body, this.ctx.serverUrl, this.home)) {
      recordCrossing(this.money, issueId, "message", Buffer.from(JSON.stringify({ body })), to);
    }
    return { ok: true, issueId };
  }
}

/** /ogdoad/rooms[/:projectId[/parts|/say]] */
export async function handleRooms(money: Money, req: IncomingMessage, res: ServerResponse, url: URL, ctx: RoomsContext | null): Promise<void> {
  if (!ctx) throw new HttpError(409, "no_team", "Rooms open once SOPHIA is hired: she sets up the company they belong to.");
  const rooms = new Rooms(money, ctx);
  const [id, action] = url.pathname.split("/").filter(Boolean).slice(2); // after /ogdoad/rooms
  const method = req.method ?? "GET";
  if (!id && method === "GET") return sendJson(res, 200, { practice: ctx.practice, rooms: await rooms.list() });
  if (!id && method === "POST") return sendJson(res, 201, await rooms.open(await readJson(req)));
  if (id && !action && method === "GET") return sendJson(res, 200, await rooms.get(id));
  if (id && action === "parts" && method === "POST") return sendJson(res, 201, await rooms.addPart(id, await readJson(req)));
  if (id && action === "say" && method === "POST") return sendJson(res, 201, await rooms.say(id, await readJson(req)));
  throw new HttpError(404, "not_found", "Nothing here.");
}
