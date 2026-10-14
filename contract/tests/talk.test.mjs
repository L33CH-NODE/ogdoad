// What's said on a task (comments), what's made on it (documents), and the live event stream.

import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { ENGINE, eventually, freshCompany, ok, operatorHeaders } from "../client.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const co = await freshCompany("talk");
const room = await ok("POST", `/api/companies/${co.id}/projects`, { name: "Talk", description: null, status: "in_progress", leadAgentId: null });
const task = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Talk here", projectId: room.id, status: "todo" });

test("the operator's comment: its id, body, time, and authored by a user, not an agent", async () => {
  const c = await ok("POST", `/api/issues/${task.id}/comments`, { body: "Hello team", clientRequestId: randomUUID() });
  assert.equal(typeof c.id, "string");
  assert.equal(c.body, "Hello team");
  assert.match(c.createdAt, ISO);
  assert.equal(c.authorAgentId ?? null, null);
  assert.notEqual(c.authorType, "agent");
});

test("the same clientRequestId twice is one comment: a retry never posts twice", async () => {
  const id = randomUUID();
  const a = await ok("POST", `/api/issues/${task.id}/comments`, { body: "Only once", clientRequestId: id });
  const b = await ok("POST", `/api/issues/${task.id}/comments`, { body: "Only once", clientRequestId: id });
  assert.equal(a.id, b.id);
  const all = await ok("GET", `/api/issues/${task.id}/comments?order=desc&limit=100`);
  assert.equal(all.filter((c) => c.body === "Only once").length, 1);
});

test("comments come back newest first as a plain list, and limit keeps the newest", async () => {
  const t = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Order", projectId: room.id, status: "todo" });
  for (const body of ["one", "two", "three"]) await ok("POST", `/api/issues/${t.id}/comments`, { body, clientRequestId: randomUUID() });
  const newest = await ok("GET", `/api/issues/${t.id}/comments?order=desc&limit=2`);
  assert.ok(Array.isArray(newest), "a bare array");
  assert.deepEqual(newest.map((c) => c.body), ["three", "two"]);
  for (const f of ["id", "body", "createdAt", "authorType", "authorAgentId"]) assert.ok(f in newest[0], f);
});

test("a document on a task: listed as a plain array, and read back whole by its key", async () => {
  await ok("PUT", `/api/issues/${task.id}/documents/plan`, { title: "The plan", format: "markdown", body: "# Plan\n\nStep one." });
  const docs = await ok("GET", `/api/issues/${task.id}/documents`);
  assert.ok(Array.isArray(docs));
  const d = docs.find((x) => x.key === "plan");
  for (const f of ["id", "issueId", "key", "title", "createdByAgentId", "createdByUserId", "updatedAt"]) assert.ok(f in d, f);
  assert.equal(d.issueId, task.id);
  assert.match(d.updatedAt, ISO);
  assert.equal((await ok("GET", `/api/issues/${task.id}/documents/plan`)).body, "# Plan\n\nStep one.");
});

test("the live stream tells a page when a task in its room changes", async () => {
  const events = [];
  const ws = new WebSocket(`${ENGINE.replace(/^http/, "ws")}/api/companies/${co.id}/events/ws`, { headers: operatorHeaders });
  ws.onmessage = (e) => events.push(JSON.parse(e.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    await ok("POST", `/api/issues/${task.id}/comments`, { body: "Something changed", clientRequestId: randomUUID() });
    const e = await eventually(() => events.find((x) => x.type === "activity.logged" && x.payload?.entityType === "issue" && x.payload?.entityId === task.id), { what: "an activity.logged event for the task" });
    assert.equal(typeof e.payload, "object");
  } finally {
    ws.close();
  }
});
