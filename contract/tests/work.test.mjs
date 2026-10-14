// Rooms and their work: projects, tasks (issues) and the team, as Ogdoad's app and UI use them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { call, freshCompany, liveAgent, ok } from "../client.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const list = (body) => (Array.isArray(body) ? body : body?.items);

const co = await freshCompany("work");
const agent = await liveAgent(co.id, "Builder - Claude Code");

test("the team: each member's id, name, status, role, title and what they can do", async () => {
  const team = list(await ok("GET", `/api/companies/${co.id}/agents`));
  const a = team.find((x) => x.id === agent.id);
  assert.ok(a, "the hire is on the team");
  for (const f of ["id", "name", "status", "role", "title"]) assert.equal(typeof a[f], "string", f);
  assert.ok("capabilities" in a);
  assert.equal(a.name, "Builder - Claude Code", "names keep their ' - Harness' suffix; the UI trims it");
});

test("pausing a hire shows on the team at once, and resuming clears it", async () => {
  await ok("POST", `/api/agents/${agent.id}/pause`, {});
  const paused = list(await ok("GET", `/api/companies/${co.id}/agents`)).find((x) => x.id === agent.id);
  assert.equal(paused.status, "paused");
  await ok("POST", `/api/agents/${agent.id}/resume`, {});
  const back = list(await ok("GET", `/api/companies/${co.id}/agents`)).find((x) => x.id === agent.id);
  assert.notEqual(back.status, "paused");
});

test("a room is a project: opened with a lead and a brief, listed, and read back", async () => {
  const room = await ok("POST", `/api/companies/${co.id}/projects`, { name: "Launch", description: "The brief.\n---\nNotes", status: "in_progress", leadAgentId: agent.id });
  for (const f of ["id", "name", "status", "updatedAt"]) assert.equal(typeof room[f], "string", f);
  assert.equal(room.status, "in_progress");
  assert.equal(room.leadAgentId, agent.id);
  assert.ok("color" in room);
  assert.match(room.updatedAt, ISO);

  const listed = list(await ok("GET", `/api/companies/${co.id}/projects`)).find((p) => p.id === room.id);
  assert.equal(listed.description, "The brief.\n---\nNotes", "the brief comes back exactly as written");
  assert.equal(listed.archivedAt ?? null, null, "an open room isn't archived");
  assert.equal((await ok("GET", `/api/projects/${room.id}`)).name, "Launch");
});

test("a task: made in a room, under its thread, with an identifier like ABC-12 and the operator as its author", async () => {
  const room = await ok("POST", `/api/companies/${co.id}/projects`, { name: "Tasks", description: null, status: "in_progress", leadAgentId: null });
  const thread = await ok("POST", `/api/companies/${co.id}/issues`, { title: "The room: Tasks", description: "", projectId: room.id, status: "todo", assigneeAgentId: null });
  const part = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Draft the plan", description: "Steps", projectId: room.id, parentId: thread.id, status: "todo", assigneeAgentId: null });

  assert.match(part.identifier, /^[A-Z][A-Z0-9]*-\d+$/);
  assert.equal(part.status, "todo");
  assert.equal(part.projectId, room.id);
  assert.equal(part.parentId, thread.id);
  assert.equal(part.assigneeAgentId, null);
  assert.ok(!part.createdByAgentId, "made by the operator, not an agent");
  assert.match(part.createdAt, ISO);
  assert.match(part.updatedAt, ISO);

  const inRoom = list(await ok("GET", `/api/companies/${co.id}/issues?projectId=${room.id}&limit=100`));
  assert.deepEqual(inRoom.map((i) => i.id).sort(), [thread.id, part.id].sort(), "only that room's tasks");
  for (const f of ["id", "identifier", "title", "status", "projectId", "parentId", "assigneeAgentId", "assigneeUserId", "createdByAgentId", "createdAt", "updatedAt"]) assert.ok(f in inRoom[0], f);
  assert.equal(list(await ok("GET", `/api/companies/${co.id}/issues?limit=1`)).length, 1, "limit is honoured");

  const one = await ok("GET", `/api/issues/${part.id}`);
  assert.equal(one.identifier, part.identifier);
  assert.equal(one.title, "Draft the plan");
});

test("'me' is the operator: a task assigned to them is found with assigneeUserId=me", async () => {
  const mine = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Sign the contract", status: "todo" });
  const operator = mine.createdByUserId;
  assert.ok(operator, "an operator-made task names its user");
  const yours = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Yours to do", status: "todo", assigneeUserId: operator, priority: "high" });
  const found = list(await ok("GET", `/api/companies/${co.id}/issues?assigneeUserId=me&limit=100`));
  assert.ok(found.some((i) => i.id === yours.id));
  assert.ok(!found.some((i) => i.id === mine.id), "unassigned tasks aren't 'mine'");
  const y = found.find((i) => i.id === yours.id);
  assert.equal(y.priority, "high");
});

test("statuses: in_progress needs someone on it; done and cancelled close a task", async () => {
  const t = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Status rules", status: "todo" });
  const r = await call("PATCH", `/api/issues/${t.id}`, { status: "in_progress" });
  assert.equal(r.status, 422);
  assert.equal(typeof r.body.error, "string");
  assert.equal((await ok("PATCH", `/api/issues/${t.id}`, { status: "done" })).status, "done");
  const c = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Dropped", status: "backlog" });
  assert.equal((await ok("PATCH", `/api/issues/${c.id}`, { status: "cancelled" })).status, "cancelled");
});

test("not found is a 404 with an error message, for tasks, rooms and approvals", async () => {
  const none = "00000000-0000-0000-0000-000000000000";
  for (const path of [`/api/issues/${none}`, `/api/projects/${none}`, `/api/approvals/${none}`]) {
    const r = await call("GET", path);
    assert.equal(r.status, 404, path);
    assert.equal(typeof r.body?.error, "string", path);
  }
});
