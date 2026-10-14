// Nous's own API (/v1): lean objects, lists as { items }, errors as plain sentences.

import { NousError, type Engine, type Priority, type TaskPatch, type TaskStatus } from "./engine.js";
import { created, needOperator, needSomeone, type Router } from "./http.js";
import type { Work } from "./work.js";

/** Only the fields a task patch may carry, whatever else the body holds. */
export function taskPatch(b: any): TaskPatch {
  const p: TaskPatch = {};
  if (b.title !== undefined) p.title = String(b.title);
  if (b.description !== undefined) p.description = String(b.description ?? "");
  if (b.status !== undefined) p.status = b.status as TaskStatus;
  if (b.priority !== undefined) p.priority = b.priority as Priority;
  if (b.assigneeId !== undefined) p.assigneeId = b.assigneeId;
  if (b.forOperator !== undefined) p.forOperator = !!b.forOperator;
  if (b.roomId !== undefined) p.roomId = b.roomId;
  if (b.parentId !== undefined) p.parentId = b.parentId;
  return p;
}

const statuses = (s: string | null) => (s ? (s.split(",").filter(Boolean) as TaskStatus[]) : undefined);
const limit = (s: string | null) => (s ? Number(s) || undefined : undefined);

export function nativeRoutes(r: Router, engine: () => Engine, work: () => Work): void {
  r.on("GET", "/v1/me", (c) => {
    const who = needSomeone(c);
    if (who.kind !== "member") throw new NousError(404, "not_a_member", "The operator isn't a member; sign with a run's token.");
    return { ...engine().member(who.memberId), runId: who.runId };
  });
  r.on("POST", "/v1/tasks/:id/claim", async (c) => {
    const b = await c.body();
    return engine().claim(c.params.id, needSomeone(c), Array.isArray(b.expect) ? b.expect : undefined);
  });
  r.on("POST", "/v1/tasks/:id/release", (c) => engine().release(c.params.id, needSomeone(c)));
  r.on("GET", "/v1/tasks/:id/context", (c) => {
    const e = engine();
    const t = e.task(c.params.id, needSomeone(c));
    return { task: t, messages: e.messages(t.id, { limit: 20 }), docs: e.docs(t.id).map(({ body: _b, ...d }) => d), cards: e.cards(t.id) };
  });

  r.on("GET", "/v1/tasks/:id/cards", (c) => ({ items: engine().cards(c.params.id, needSomeone(c)) }));
  r.on("POST", "/v1/tasks/:id/cards", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    return created(engine().createCard(c.params.id, { kind: b.kind, title: b.title, payload: b.payload }, who));
  });
  r.on("POST", "/v1/cards/:id/answer", async (c) => (needOperator(c), engine().answerCard(c.params.id, (await c.body()).answers)));

  r.on("POST", "/v1/companies/:co/approvals", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    return created(engine().createApproval(c.params.co, { type: b.type, payload: b.payload, taskIds: b.taskIds }, who));
  });
  r.on("GET", "/v1/approvals/:id", (c) => engine().approval(c.params.id, needSomeone(c)));
  r.on("POST", "/v1/approvals/:id/decide", async (c) => {
    needOperator(c);
    const b = await c.body();
    if (typeof b.approve !== "boolean") throw new NousError(400, "bad_request", "Say approve: true or false.");
    return engine().decide(c.params.id, b.approve, b.note ?? null);
  });
  r.on("POST", "/v1/import", async (c) => (needOperator(c), { counts: engine().importBatch(await c.body()) }));
  r.on("GET", "/v1/companies/:co/counts", (c) => (needOperator(c), engine().counts(c.params.co)));
  r.on("GET", "/v1/companies/:co/waiting", (c) => (needOperator(c), { items: engine().waiting(c.params.co) }));
  r.on("GET", "/v1/companies/:co/runs", (c) => {
    engine().company(c.params.co, needSomeone(c));
    return { items: work().live(c.params.co) };
  });

  r.on("GET", "/v1/companies", (c) => (needOperator(c), { items: engine().companies() }));
  r.on("POST", "/v1/companies", async (c) => (needOperator(c), created(engine().createCompany((await c.body()).name))));
  r.on("GET", "/v1/companies/:co", (c) => engine().company(c.params.co, needSomeone(c)));

  r.on("GET", "/v1/companies/:co/members", (c) => ({ items: engine().members(c.params.co, needSomeone(c)) }));
  r.on("POST", "/v1/companies/:co/members", async (c) => {
    needOperator(c);
    const b = await c.body();
    return created(engine().createMember(c.params.co, { name: b.name, role: b.role, title: b.title, capabilities: b.capabilities }));
  });
  r.on("GET", "/v1/members/:id", (c) => engine().member(c.params.id, needSomeone(c)));
  r.on("PATCH", "/v1/members/:id", async (c) => {
    needOperator(c);
    const b = await c.body();
    return b.paused === undefined ? engine().member(c.params.id) : engine().setPaused(c.params.id, !!b.paused);
  });

  r.on("GET", "/v1/companies/:co/rooms", (c) => ({ items: engine().rooms(c.params.co, needSomeone(c)) }));
  r.on("POST", "/v1/companies/:co/rooms", async (c) => {
    needOperator(c);
    const b = await c.body();
    return created(engine().createRoom(c.params.co, { name: b.name, brief: b.brief, status: b.status, leadId: b.leadId, color: b.color }));
  });
  r.on("GET", "/v1/rooms/:id", (c) => engine().room(c.params.id, needSomeone(c)));

  r.on("GET", "/v1/companies/:co/tasks", (c) => {
    const q = c.url.searchParams;
    return { items: engine().tasks(c.params.co, { roomId: q.get("room") ?? undefined, assignee: q.get("assignee") ?? undefined, statuses: statuses(q.get("status")), limit: limit(q.get("limit")) }, needSomeone(c)) };
  });
  r.on("POST", "/v1/companies/:co/tasks", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    return created(engine().createTask(c.params.co, { ...taskPatch(b), title: b.title }, who));
  });
  r.on("GET", "/v1/tasks/:id", (c) => engine().task(c.params.id, needSomeone(c)));
  r.on("PATCH", "/v1/tasks/:id", async (c) => engine().updateTask(c.params.id, taskPatch(await c.body()), needSomeone(c)));

  r.on("GET", "/v1/tasks/:id/messages", (c) => {
    const q = c.url.searchParams;
    return { items: engine().messages(c.params.id, { newestFirst: q.get("newest") !== "0", limit: limit(q.get("limit")) }, needSomeone(c)) };
  });
  r.on("POST", "/v1/tasks/:id/messages", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    return created(engine().say(c.params.id, b.body, who, b.requestId));
  });

  r.on("GET", "/v1/tasks/:id/docs", (c) => ({ items: engine().docs(c.params.id, needSomeone(c)) }));
  r.on("GET", "/v1/tasks/:id/docs/:key", (c) => {
    const d = engine().doc(c.params.id, c.params.key, needSomeone(c));
    if (!d) throw new NousError(404, "not_found", "No such document.");
    return d;
  });
  r.on("PUT", "/v1/tasks/:id/docs/:key", async (c) => {
    const who = needSomeone(c);
    const b = await c.body();
    return engine().putDoc(c.params.id, c.params.key, { title: b.title, format: b.format, body: b.body }, who);
  });
}
