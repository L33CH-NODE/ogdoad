// The work loop's promises, on a throwaway store: one run at a time, merged wakes, leases that put a
// job back in the queue, tokens that die with their run, and a repair run after an unfinished job.

import { test } from "node:test";
import assert from "node:assert/strict";

import { Engine, type Who } from "../engine.js";
import { openStore } from "../store.js";
import { Work } from "../work.js";

const operator: Who = { kind: "operator" };

function setup() {
  const engine = new Engine(openStore(":memory:"));
  const work = new Work(engine, { apiUrl: "http://127.0.0.1:0", leaseSec: 60 });
  const co = engine.createCompany("Loop Co");
  const hire = engine.createMember(co.id, { name: "Hire" });
  return { engine, work, co, hire };
}

test("one run at a time: a second task waits its turn, and doesn't time out behind the first", async () => {
  const { engine, work, co, hire } = setup();
  const a = engine.createTask(co.id, { title: "A", assigneeId: hire.id }, operator);
  const b = engine.createTask(co.id, { title: "B", assigneeId: hire.id }, operator);
  const first = await work.next(hire, 0);
  assert.equal(first?.taskId, a.id);
  assert.equal(await work.next(hire, 0), null, "nothing more while the first runs");
  work.touch(hire, first!.jobId, "done", { ok: true });
  const second = await work.next(hire, 0);
  assert.equal(second?.taskId, b.id);
  work.stop();
});

test("wakes for the same task merge into one waiting run, carrying the newest reason", async () => {
  const { engine, work, co, hire } = setup();
  const t = engine.createTask(co.id, { title: "Busy", assigneeId: hire.id }, operator);
  engine.say(t.id, "First", operator);
  const latest = engine.say(t.id, "Second", operator);
  assert.equal(work.live(co.id).length, 1, "one run, not three");
  const job = await work.next(hire, 0);
  assert.equal(job?.wakeReason, "issue_commented");
  assert.equal(job?.env.NOUS_WAKE_MESSAGE_ID, latest.id);
  assert.equal(job?.env.PAPERCLIP_WAKE_COMMENT_ID, latest.id, "the old name too, for outside workers");
  assert.match(job!.prompt, /Second \(this woke you\)|this woke you\): Second/);
  assert.match(job!.prompt, /\/v1 with `Authorization: Bearer \$NOUS_RUN_TOKEN`/, "the job teaches Nous's own API");
  work.stop();
});

test("a paused member isn't woken", () => {
  const { engine, work, co, hire } = setup();
  engine.setPaused(hire.id, true);
  engine.createTask(co.id, { title: "While paused", assigneeId: hire.id }, operator);
  assert.equal(work.live(co.id).length, 0);
  work.stop();
});

test("a lease that runs out puts the job back in the queue; the old job is lost to its holder", async () => {
  const { engine, work, co, hire } = setup();
  engine.createTask(co.id, { title: "Slow", assigneeId: hire.id }, operator);
  const job = await work.next(hire, 0);
  engine.db.prepare("UPDATE runs SET lease_until = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), job!.runId);
  work.sweep();
  assert.throws(() => work.touch(hire, job!.jobId, "heartbeat", {}), /lease ran out/);
  const again = await work.next(hire, 0);
  assert.equal(again?.runId, job!.runId, "the same run, back again");
  assert.notEqual(again?.jobId, job!.jobId, "as a new job");
  work.stop();
});

test("a run's token speaks for its member only while the run runs", async () => {
  const { engine, work, co, hire } = setup();
  engine.createTask(co.id, { title: "Token", assigneeId: hire.id }, operator);
  const job = await work.next(hire, 0);
  const token = job!.env.NOUS_RUN_TOKEN;
  assert.equal(job!.env.PAPERCLIP_API_KEY, token);
  assert.deepEqual(work.whoForToken(token), { kind: "member", memberId: hire.id, companyId: co.id, runId: job!.runId });
  work.touch(hire, job!.jobId, "done", { ok: true });
  assert.equal(work.whoForToken(token), null);
  assert.deepEqual(work.touch(hire, job!.jobId, "done", { ok: true }), { cancel: true, settled: true }, "settled stays settled");
  work.stop();
});

test("closing a job with the claimed task still in progress brings the member back to finish it", async () => {
  const { engine, work, co, hire } = setup();
  const t = engine.createTask(co.id, { title: "Half done", assigneeId: hire.id }, operator);
  const job = await work.next(hire, 0);
  engine.claim(t.id, { kind: "member", memberId: hire.id, companyId: co.id, runId: job!.runId });
  work.touch(hire, job!.jobId, "done", { ok: true, summary: "Stopped early." });
  const repair = await work.next(hire, 0);
  assert.equal(repair?.wakeReason, "issue_disposition_repair");
  assert.equal(repair?.taskId, t.id);
  assert.match(repair!.prompt, /finish it properly/);
  work.stop();
});

test("moving in keeps ids and numbers, wakes nobody, and a second run changes nothing", () => {
  const { engine, work } = setup();
  const at = "2026-09-01T00:00:00.000Z";
  const batch = {
    company: { id: "c0000000-0000-4000-8000-000000000001", name: "Old Co", prefix: "OLD", nextNumber: 8, createdAt: at, updatedAt: at },
    members: [{ id: "m0000000-0000-4000-8000-000000000001", name: "Veteran", role: "general", title: "", capabilities: "", status: "idle" as const, mailboxKey: "an-old-key", createdAt: at, updatedAt: at }],
    rooms: [],
    tasks: [{ id: "t0000000-0000-4000-8000-000000000001", roomId: null, parentId: null, number: 7, title: "Old task", description: "", status: "todo" as const, priority: "high" as const, assigneeId: "m0000000-0000-4000-8000-000000000001", forOperator: false, authorId: null, startedAt: null, finishedAt: null, createdAt: at, updatedAt: at }],
    messages: [{ id: "x0000000-0000-4000-8000-000000000001", taskId: "t0000000-0000-4000-8000-000000000001", authorId: null, body: "From before", requestId: "r1", createdAt: at }],
    docs: [], cards: [], approvals: [],
  };
  const first = engine.importBatch(batch);
  assert.deepEqual(engine.importBatch(batch), first, "idempotent");
  assert.equal(engine.task("t0000000-0000-4000-8000-000000000001").identifier, "OLD-7");
  assert.equal(work.live("c0000000-0000-4000-8000-000000000001").length, 0, "history isn't work: nobody woken");
  assert.equal(engine.memberByMailboxKey("an-old-key")?.id, "m0000000-0000-4000-8000-000000000001", "the old mailbox key still opens its mailbox");
  const next = engine.createTask("c0000000-0000-4000-8000-000000000001", { title: "New" }, operator);
  assert.equal(next.identifier, "OLD-8", "numbering carries on");
  work.stop();
});
