// The work loop: a task given to a hire becomes a job in its mailbox; the hire works it with run
// credentials; what it raises (questions, approvals) reaches the operator; the answers wake it again.

import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { call, eventually, freshCompany, liveAgent, nextJob, noJob, ok } from "../client.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const co = await freshCompany("jobs");
const attention = async () => (await ok("GET", `/api/companies/${co.id}/attention?all=true`)).items;

/** A hire with a task assigned, its first job taken and the task checked out. */
async function working(name) {
  const agent = await liveAgent(co.id, name);
  const task = await ok("POST", `/api/companies/${co.id}/issues`, { title: `${name}'s task`, status: "todo", assigneeAgentId: agent.id });
  const job = await nextJob(agent.id);
  await ok("POST", `/api/issues/${task.id}/checkout`, { agentId: agent.id, expectedStatuses: ["todo", "backlog", "blocked", "in_review"] }, job.asAgent);
  return { agent, task, job };
}

/**
 * A well-behaved hire ends a job with its task settled: done, or in review while a card or an approval
 * waits on the operator (the engine won't park a task in review with nobody owning the next step).
 */
async function close(j, task, status) {
  await ok("PATCH", `/api/issues/${task.id}`, { status }, j.asAgent);
  await j.done();
}

test("assigning a task wakes the hire: a run shows as live, and a job with run credentials is in its mailbox", async () => {
  const agent = await liveAgent(co.id, "Starter");
  const task = await ok("POST", `/api/companies/${co.id}/issues`, { title: "First job", status: "todo", assigneeAgentId: agent.id });
  const run = await eventually(async () => (await ok("GET", `/api/companies/${co.id}/live-runs`)).find((r) => r.agentId === agent.id), { what: "a live run" });
  assert.equal(run.issueId, task.id);
  assert.ok(["queued", "running"].includes(run.status));

  const { job, done } = await nextJob(agent.id);
  assert.equal(job.agentId, agent.id);
  assert.equal(job.taskId, task.id);
  assert.equal(job.wakeReason, "issue_assigned");
  assert.equal(typeof job.prompt, "string");
  assert.ok(job.leaseSec > 0);
  for (const k of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_TASK_ID"]) assert.equal(typeof job.env[k], "string", k);
  assert.equal(job.env.PAPERCLIP_TASK_ID, task.id);

  assert.deepEqual((await done({ ok: true, summary: "Nothing to do." })).body, { cancel: false, settled: true });
  assert.equal(run.id, job.runId, "a live run's id is the job's run");
  await eventually(async () => !(await ok("GET", `/api/companies/${co.id}/live-runs`)).some((r) => r.id === job.runId && ["queued", "running"].includes(r.status)), { what: "that run to end" });
});

test("on a job the hire checks the task out, talks, writes a document and closes the task, all as itself", async () => {
  const { agent, task, job } = await working("Writer");
  assert.equal((await ok("GET", `/api/issues/${task.id}`)).status, "in_progress", "checkout claims it");
  // Checking out again is a no-op for the same hire.
  await ok("POST", `/api/issues/${task.id}/checkout`, { agentId: agent.id, expectedStatuses: ["todo", "backlog", "blocked", "in_review"] }, job.asAgent);

  const said = await ok("POST", `/api/issues/${task.id}/comments`, { body: "Working on it." }, job.asAgent);
  assert.equal(said.authorType, "agent");
  assert.equal(said.authorAgentId, agent.id);

  await ok("PUT", `/api/issues/${task.id}/documents/profile`, { title: "Company profile", format: "markdown", body: "# Profile" }, job.asAgent);
  const doc = (await ok("GET", `/api/issues/${task.id}/documents`)).find((d) => d.key === "profile");
  assert.equal(doc.createdByAgentId, agent.id);
  assert.ok(!doc.createdByUserId);

  assert.equal((await ok("PATCH", `/api/issues/${task.id}`, { status: "done", comment: "Done." }, job.asAgent)).status, "done");
  await job.done();
});

test("one task, one hire: another hire can't check out a task that's already being worked", async () => {
  const first = await working("First");
  const second = await working("Second");
  const r = await call("POST", `/api/issues/${first.task.id}/checkout`, { agentId: second.agent.id, expectedStatuses: ["todo", "backlog", "blocked", "in_review"] }, second.job.asAgent);
  assert.equal(r.status, 409);
  await close(first.job, first.task, "done");
  await close(second.job, second.task, "done");
});

test("the operator's comment on a hire's task wakes the hire, naming the comment", async () => {
  const { task, job, agent } = await working("Listener");
  await close(job, task, "done");
  const c = await ok("POST", `/api/issues/${task.id}/comments`, { body: "One more thing.", clientRequestId: randomUUID() });
  const again = await nextJob(agent.id);
  assert.equal(again.job.taskId, task.id);
  assert.ok(["issue_commented", "issue_reopened_via_comment"].includes(again.job.wakeReason), again.job.wakeReason);
  assert.equal(again.job.env.PAPERCLIP_WAKE_COMMENT_ID, c.id);
  await again.done();
});

test("a question card: raised by the hire, shown to the operator, answered, gone from the feed, and the hire woken", async () => {
  const { task, job, agent } = await working("Asker");
  const card = await ok("POST", `/api/issues/${task.id}/interactions`, {
    kind: "ask_user_questions",
    title: "A few questions",
    payload: { version: 1, questions: [{ id: "size", prompt: "How big is the business?", selectionMode: "single", options: [{ id: "solo", label: "Just me" }, { id: "team", label: "A team" }, { id: "other", label: "Other", freeText: true }] }] },
  }, job.asAgent);
  await close(job, task, "in_review");

  const cards = await ok("GET", `/api/issues/${task.id}/interactions`);
  assert.ok(Array.isArray(cards), "a bare array");
  const c = cards.find((x) => x.id === card.id);
  assert.equal(c.kind, "ask_user_questions");
  assert.equal(c.status, "pending");
  assert.equal(c.createdByAgentId, agent.id);
  assert.match(c.createdAt, ISO);
  const q = c.payload.questions[0];
  assert.deepEqual([q.id, q.prompt, q.selectionMode, q.options.length], ["size", "How big is the business?", "single", 3]);
  assert.equal(q.options[2].freeText, true);

  const item = await eventually(async () => (await attention()).find((i) => i.subject?.id === card.id), { what: "the card in the attention feed" });
  assert.equal(item.sourceKind, "issue_thread_interaction");
  assert.equal(item.relatedIssue?.id, task.id);
  assert.ok(["critical", "high", "medium", "low"].includes(item.severity));
  assert.equal(typeof item.whyNow, "string");
  assert.equal(item.detail?.kind, "questions");
  assert.equal(item.detail?.firstQuestionText, "How big is the business?");
  assert.equal(item.detail?.questionCount, 1);

  await ok("POST", `/api/issues/${task.id}/interactions/${card.id}/respond`, { answers: [{ questionId: "size", optionIds: ["other"], otherText: "Two of us" }] });
  assert.equal((await ok("GET", `/api/issues/${task.id}/interactions`)).find((x) => x.id === card.id).status, "answered");
  await eventually(async () => !(await attention()).some((i) => i.subject?.id === card.id), { what: "the answered card to leave the feed" });

  const woken = await nextJob(agent.id);
  assert.equal(woken.job.taskId, task.id);
  await woken.done();
});

test("an approval: asked for by the hire, shown to the operator, decided with a note, gone from the feed, and the hire told", async () => {
  const { task, job, agent } = await working("Spender");
  const asked = await ok("POST", `/api/companies/${co.id}/approvals`, { type: "request_board_approval", requestedByAgentId: agent.id, issueIds: [task.id], payload: { title: "Buy a domain", summary: "For the site", recommendedAction: "approve" } }, job.asAgent);
  await close(job, task, "in_review");

  const a = await ok("GET", `/api/approvals/${asked.id}`);
  assert.equal(a.status, "pending");
  assert.equal(a.type, "request_board_approval");
  assert.equal(a.requestedByAgentId, agent.id);
  assert.equal(a.payload.title, "Buy a domain");
  assert.match(a.createdAt, ISO);

  const item = await eventually(async () => (await attention()).find((i) => i.subject?.id === asked.id), { what: "the approval in the attention feed" });
  assert.equal(item.sourceKind, "approval");
  assert.equal(item.subject.kind, "approval");

  await ok("POST", `/api/approvals/${asked.id}/approve`, { decisionNote: "Go ahead." });
  const decided = await ok("GET", `/api/approvals/${asked.id}`);
  assert.equal(decided.status, "approved");
  assert.equal(decided.decisionNote, "Go ahead.");
  await eventually(async () => !(await attention()).some((i) => i.subject?.id === asked.id), { what: "the decided approval to leave the feed" });

  const told = await nextJob(agent.id);
  assert.equal(told.job.env.PAPERCLIP_APPROVAL_ID, asked.id);
  assert.equal(told.job.env.PAPERCLIP_APPROVAL_STATUS, "approved");
  await told.done();
});

// Ogdoad does better: the engine it started on wakes the hire when you approve, not when you reject.
test("a rejected approval says so, and the hire is told", async () => {
  const { task, job, agent } = await working("Hopeful");
  const asked = await ok("POST", `/api/companies/${co.id}/approvals`, { type: "request_board_approval", requestedByAgentId: agent.id, issueIds: [task.id], payload: { title: "Hire ten people" } }, job.asAgent);
  await close(job, task, "in_review");
  await ok("POST", `/api/approvals/${asked.id}/reject`, { decisionNote: "Not yet." });
  assert.equal((await ok("GET", `/api/approvals/${asked.id}`)).status, "rejected");
  const told = await nextJob(agent.id);
  assert.equal(told.job.env.PAPERCLIP_APPROVAL_STATUS, "rejected");
  await told.done();
});

// Ogdoad does better: a hire is only asked for, and the operator's yes is what makes the member. The engine
// Ogdoad started on makes the agent first and leaves it waiting, so a no leaves one behind.
test("a hire asks for a hire: making one is refused with the way to ask, and the operator's yes makes the member", async () => {
  const { task, job, agent } = await working("Recruiter");
  const direct = await call("POST", `/api/companies/${co.id}/agents`, { name: "Shortcut", adapterType: "live_agent" }, job.asAgent);
  assert.equal(direct.status, 403);
  assert.match(String(direct.body?.error), /agent-hires/, "the refusal names the way to ask");

  const asked = await ok("POST", `/api/companies/${co.id}/agent-hires`, { name: "Builder", role: "engineer", title: "Engineer", sourceIssueIds: [task.id] }, job.asAgent);
  assert.equal(asked.approval.type, "hire_agent");
  assert.equal(asked.approval.status, "pending");
  assert.equal(asked.approval.requestedByAgentId, agent.id);
  await close(job, task, "in_review");
  assert.ok(!(await ok("GET", `/api/companies/${co.id}/agents`)).some((a) => a.name === "Builder"), "asking makes nobody");

  await ok("POST", `/api/approvals/${asked.approval.id}/approve`, { decisionNote: "Welcome." });
  const memberId = (await ok("GET", `/api/approvals/${asked.approval.id}`)).payload.memberId;
  const hired = (await ok("GET", `/api/companies/${co.id}/agents`)).find((a) => a.id === memberId);
  assert.equal(hired?.name, "Builder");
  const told = await nextJob(agent.id);
  assert.equal(told.job.env.PAPERCLIP_APPROVAL_ID, asked.approval.id);
  assert.equal(told.job.env.PAPERCLIP_APPROVAL_STATUS, "approved");
  await told.done();
});

// Ogdoad does better here. Rooms, the crossings log and the briefs all say a mention wakes the hire it
// names; the engine Ogdoad started on treats a mention as context only, so it's expected to fail there.
test("a mention wakes the hire it names", async () => {
  const { task, job } = await working("Mentioner");
  await close(job, task, "done");
  const other = await liveAgent(co.id, "Named");
  await ok("POST", `/api/issues/${task.id}/comments`, { body: `Over to you, [@Named](agent://${other.id}).`, clientRequestId: randomUUID() });
  const r = await noJob(other.id, 8);
  assert.equal(r.woken, true, "the named hire got a job");
});
