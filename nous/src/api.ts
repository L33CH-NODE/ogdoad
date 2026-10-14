// Nous's own API (/v1): lean objects, lists as { items }, errors as plain sentences.

import { NousError, type Engine, type Priority, type TaskPatch, type TaskStatus } from "./engine.js";
import { created, needOperator, needSomeone, type Router } from "./http.js";

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

export function nativeRoutes(r: Router, engine: () => Engine): void {
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
