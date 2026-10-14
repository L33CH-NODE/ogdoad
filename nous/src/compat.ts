// The translator: the routes and shapes of the engine Ogdoad started on (/api/...), answered by Nous's
// own rules. It keeps the app, Horos's wizard and every hire working unchanged on the day Nous takes
// over, until each moves to /v1. The shapes carry the fields Ogdoad reads (docs/ENGINE-CONTRACT.md),
// not the old engine's ninety.

import { NousError, OPERATOR, type Company, type Doc, type Engine, type Member, type Message, type Room, type Task, type TaskPatch } from "./engine.js";
import { created, needOperator, needSomeone, type Router } from "./http.js";

export const toCompany = (c: Company) => ({ id: c.id, name: c.name, issuePrefix: c.prefix, status: "active", createdAt: c.createdAt, updatedAt: c.updatedAt });

const AGENT_STATUS = { idle: "idle", working: "running", paused: "paused", let_go: "terminated" } as const;
export const toAgent = (m: Member) => ({
  id: m.id, companyId: m.companyId, name: m.name, role: m.role, title: m.title, capabilities: m.capabilities,
  status: AGENT_STATUS[m.status], adapterType: "live_agent", createdAt: m.createdAt, updatedAt: m.updatedAt,
});

export const toProject = (r: Room) => ({
  id: r.id, companyId: r.companyId, name: r.name, description: r.brief, status: r.status, leadAgentId: r.leadId, color: r.color,
  archivedAt: r.archivedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export const toIssue = (t: Task) => ({
  id: t.id, companyId: t.companyId, projectId: t.roomId, parentId: t.parentId, identifier: t.identifier, issueNumber: t.number,
  title: t.title, description: t.description, status: t.status, priority: t.priority,
  assigneeAgentId: t.assigneeId, assigneeUserId: t.forOperator ? OPERATOR : null,
  createdByAgentId: t.authorId, createdByUserId: t.authorId ? null : OPERATOR,
  checkoutRunId: t.heldByRun, startedAt: t.startedAt,
  completedAt: t.status === "done" ? t.finishedAt : null, cancelledAt: t.status === "cancelled" ? t.finishedAt : null,
  createdAt: t.createdAt, updatedAt: t.updatedAt,
});

export const toComment = (m: Message) => ({
  id: m.id, companyId: m.companyId, issueId: m.taskId, body: m.body,
  authorType: m.authorId ? "agent" : "user", authorAgentId: m.authorId, authorUserId: m.authorId ? null : OPERATOR,
  createdByRunId: m.runId, clientRequestId: m.requestId, createdAt: m.createdAt, updatedAt: m.createdAt,
});

export const toDocument = (d: Doc) => ({
  id: d.id, companyId: d.companyId, issueId: d.taskId, key: d.key, title: d.title, format: d.format, body: d.body,
  latestRevisionNumber: d.revision, createdByAgentId: d.authorId, createdByUserId: d.authorId ? null : OPERATOR,
  createdAt: d.createdAt, updatedAt: d.updatedAt,
});

/** An old-style patch or create body, in Nous's terms. Any operator user id means the operator. */
function patchFrom(b: any): TaskPatch {
  const p: TaskPatch = {};
  if (b.title !== undefined) p.title = String(b.title);
  if (b.description !== undefined) p.description = String(b.description ?? "");
  if (b.status !== undefined) p.status = b.status;
  if (b.priority !== undefined) p.priority = b.priority;
  if (b.assigneeAgentId !== undefined) p.assigneeId = b.assigneeAgentId;
  if (b.assigneeUserId !== undefined) p.forOperator = !!b.assigneeUserId;
  if (b.projectId !== undefined) p.roomId = b.projectId;
  if (b.parentId !== undefined) p.parentId = b.parentId;
  return p;
}

export function compatRoutes(r: Router, engine: () => Engine): void {
  r.on("POST", "/api/companies", async (c) => (needOperator(c), created(toCompany(engine().createCompany((await c.body()).name)))));
  r.on("GET", "/api/companies/:co", (c) => toCompany(engine().company(c.params.co, needSomeone(c))));

  r.on("GET", "/api/companies/:co/agents", (c) => engine().members(c.params.co, needSomeone(c)).map(toAgent));
  r.on("POST", "/api/companies/:co/agents", async (c) => {
    needOperator(c);
    const b = await c.body();
    return created(toAgent(engine().createMember(c.params.co, { name: b.name, role: b.role, title: b.title, capabilities: b.capabilities })));
  });
  r.on("POST", "/api/agents/:id/pause", (c) => (needOperator(c), toAgent(engine().setPaused(c.params.id, true))));
  r.on("POST", "/api/agents/:id/resume", (c) => (needOperator(c), toAgent(engine().setPaused(c.params.id, false))));

  r.on("GET", "/api/companies/:co/projects", (c) => engine().rooms(c.params.co, needSomeone(c)).map(toProject));
  r.on("POST", "/api/companies/:co/projects", async (c) => {
    needOperator(c);
    const b = await c.body();
    return created(toProject(engine().createRoom(c.params.co, { name: b.name, brief: b.description, status: b.status, leadId: b.leadAgentId, color: b.color })));
  });
  r.on("GET", "/api/projects/:id", (c) => toProject(engine().room(c.params.id, needSomeone(c))));

  r.on("GET", "/api/companies/:co/issues", (c) => {
    const q = c.url.searchParams;
    const assignee = q.get("assigneeUserId") === "me" ? "me" : (q.get("assigneeAgentId") ?? undefined);
    const statuses = q.get("status")?.split(",").filter(Boolean) as any;
    return engine().tasks(c.params.co, { roomId: q.get("projectId") ?? undefined, assignee, statuses, limit: Number(q.get("limit")) || undefined }, needSomeone(c)).map(toIssue);
  });
  r.on("POST", "/api/companies/:co/issues", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    return created(toIssue(engine().createTask(c.params.co, { ...patchFrom(b), title: b.title }, who)));
  });
  r.on("GET", "/api/issues/:id", (c) => toIssue(engine().task(c.params.id, needSomeone(c))));
  r.on("PATCH", "/api/issues/:id", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    const e = engine();
    const t = e.updateTask(c.params.id, patchFrom(b), who);
    if (typeof b.comment === "string" && b.comment.trim()) e.say(t.id, b.comment, who);
    return toIssue(e.task(t.id));
  });

  r.on("GET", "/api/issues/:id/comments", (c) => {
    const q = c.url.searchParams;
    return engine().messages(c.params.id, { newestFirst: q.get("order") !== "asc", limit: Number(q.get("limit")) || undefined }, needSomeone(c)).map(toComment);
  });
  r.on("POST", "/api/issues/:id/comments", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    return created(toComment(engine().say(c.params.id, b.body, who, b.clientRequestId)));
  });

  r.on("GET", "/api/issues/:id/documents", (c) => engine().docs(c.params.id, needSomeone(c)).map(toDocument));
  r.on("GET", "/api/issues/:id/documents/:key", (c) => {
    const d = engine().doc(c.params.id, c.params.key, needSomeone(c));
    if (!d) throw new NousError(404, "not_found", "No such document.");
    return toDocument(d);
  });
  r.on("PUT", "/api/issues/:id/documents/:key", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    const existed = !!engine().doc(c.params.id, c.params.key, who);
    const d = toDocument(engine().putDoc(c.params.id, c.params.key, { title: b.title, format: b.format, body: b.body }, who));
    return existed ? d : created(d);
  });
}

