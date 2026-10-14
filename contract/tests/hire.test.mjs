// The engine as a hire sees it on a job (its run credentials), and the mailbox protocol that Horos
// seats and live workers speak.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ENGINE, MAILBOX, call, eventually, freshCompany, liveAgent, mailboxKey, nextJob, ok } from "../client.mjs";

const co = await freshCompany("hire");

test("health, and a company's name and the prefix its task identifiers use", async () => {
  assert.equal((await fetch(`${ENGINE}/api/health`)).ok, true);
  const c = await ok("GET", `/api/companies/${co.id}`);
  assert.equal(c.id, co.id);
  assert.equal(typeof c.name, "string");
  assert.match(c.issuePrefix, /^[A-Z][A-Z0-9]*$/);
});

test("a hire on a job: who it is, its task's context, a sub-task of its own, and letting a task go", async () => {
  const agent = await liveAgent(co.id, "Planner", { role: "ceo", title: "CEO", capabilities: "Runs the company." });
  const task = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Plan the week", status: "todo", priority: "high", assigneeAgentId: agent.id });
  const { asAgent, done } = await nextJob(agent.id);

  const me = await ok("GET", "/api/agents/me", undefined, asAgent);
  assert.deepEqual([me.id, me.name, me.companyId, me.role], [agent.id, "Planner", co.id, "ceo"]);

  const context = await ok("GET", `/api/issues/${task.id}/heartbeat-context`, undefined, asAgent);
  assert.equal(typeof context, "object");

  await ok("POST", `/api/issues/${task.id}/checkout`, { agentId: agent.id, expectedStatuses: ["todo"] }, asAgent);
  const sub = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Draft Monday", status: "todo", parentId: task.id, assigneeAgentId: agent.id }, asAgent);
  assert.equal(sub.parentId, task.id);
  assert.equal(sub.createdByAgentId, agent.id);

  const released = await ok("POST", `/api/issues/${task.id}/release`, {}, asAgent);
  assert.equal(released.status, "todo", "an in-progress task goes back to the queue");
  await done();
});

test("without run credentials a request is the operator's, never a hire's", async () => {
  const r = await call("GET", "/api/agents/me");
  assert.ok(r.status >= 400, "no hire is 'me' without credentials");
});

// The engine Ogdoad started on names the task in a run's status only when the run ends (an assignment
// already shows as activity.logged on the task). Ogdoad's own will name it from the start too.
test("the live stream tells a room when a hire's run on one of its tasks finishes", async () => {
  const agent = await liveAgent(co.id, "Visible");
  const events = [];
  const ws = new WebSocket(`${ENGINE.replace(/^http/, "ws")}/api/companies/${co.id}/events/ws`, { headers: { origin: ENGINE } });
  ws.onmessage = (e) => events.push(JSON.parse(e.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    const task = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Be seen", status: "todo", assigneeAgentId: agent.id });
    await eventually(() => events.find((x) => x.type === "activity.logged" && x.payload?.entityType === "issue" && x.payload?.entityId === task.id), { what: "activity on the task" });
    const { done } = await nextJob(agent.id);
    await done();
    await eventually(() => events.find((x) => x.type === "heartbeat.run.status" && x.payload?.issueId === task.id), { what: "a heartbeat.run.status event naming the task" });
  } finally {
    ws.close();
  }
});

test("the mailbox: health without a key, nothing without a key, and a job's heartbeat, log and close", async () => {
  const health = await (await fetch(`${MAILBOX}/v1/health`)).json();
  assert.equal(health.ok, true);
  assert.equal((await fetch(`${MAILBOX}/v1/next?wait=0`)).status, 401);

  const agent = await liveAgent(co.id, "Worker");
  await ok("POST", `/api/companies/${co.id}/issues`, { title: "Mailbox", status: "todo", assigneeAgentId: agent.id });
  const { job, heartbeat, done } = await nextJob(agent.id);
  assert.equal(job.protocol, "paperclip-live-agent/1");
  const key = await mailboxKey(agent.id);
  assert.equal((await fetch(`${MAILBOX}/v1/next?wait=0`, { headers: { authorization: `Bearer ${key}` } })).status, 204, "one job at a time: nothing else queued");

  assert.deepEqual((await heartbeat()).body, { cancel: false, settled: false });
  const log = await fetch(`${MAILBOX}/v1/jobs/${job.jobId}/log`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ stream: "stdout", text: "working\n" }) });
  assert.equal(log.status, 200);
  assert.deepEqual((await done({ ok: true, summary: "Closed." })).body, { cancel: false, settled: true });
  assert.deepEqual((await done({ ok: true })).body, { cancel: true, settled: true }, "a settled job stays settled");

  const stranger = await fetch(`${MAILBOX}/v1/jobs/${job.jobId}/heartbeat`, { method: "POST", headers: { authorization: "Bearer someone-else", "content-type": "application/json" }, body: "{}" });
  assert.equal(stranger.status, 404, "another key can't touch the job");
});
