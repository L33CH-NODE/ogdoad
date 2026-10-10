// Flow and the control center's reads, on made-up books: raised work appears and clears itself, the
// ranking puts first things first, the operator's own tasks count, and Signals reads like sentences.

import { test } from "node:test";
import assert from "node:assert/strict";

import { artifacts, monthly, signals, syncFlow } from "../center.js";
import { Flow, raisedFromMoney, type Raised } from "../flow/flow.js";
import { raisedFromAttention } from "../flow/team.js";
import { scoreTask } from "../flow/rank.js";
import { importStatement } from "../money/bank.js";
import { openMoneyDb } from "../money/db.js";
import { addDays, Money } from "../money/service.js";

function setup() {
  const m = new Money(openMoneyDb(":memory:"));
  const business = m.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111111", accountNumber: "87654321" }, "op");
  m.updateSettings({ businessName: "Sample Co", abn: "51824753556", nextNumber: 101, defaultAccountId: business.id }, "operator");
  const harbour = m.createClient({ name: "Harbour Plan Managers", payToAccountId: business.id }, "operator");
  const flow = new Flow(m);
  const sync = () => flow.sync(raisedFromMoney(m), ["money:", "bank:"]);
  return { m, business, harbour, flow, sync, today: m.today() };
}

test("raised work appears, updates in place, and clears itself once it's dealt with", () => {
  const { m, harbour, flow, sync, today } = setup();
  const draft = m.createDraft({ clientId: harbour.id, lines: [{ description: "Support work", unitCents: 41460 }] }, "operator");
  sync();
  assert.equal(flow.view().now?.title, "Issue the draft for Harbour Plan Managers");

  const issued = m.issue(draft.id, { issueDate: addDays(today, -60) }, "operator");
  sync();
  const v = flow.view();
  assert.match(v.now!.title, /^Chase 00101 from Harbour/, "the draft task cleared; the late invoice raised a chase");
  assert.match(v.now!.context, /days late. Check the bank first/);

  m.recordPayment({ invoiceId: issued.id, amountCents: issued.totalCents, receivedOn: today, matchedBy: "manual" }, "operator");
  sync();
  assert.equal(flow.view().now, null, "paid: nothing left to chase");
  assert.equal(flow.view().doneToday, 0, "work that cleared itself isn't counted as the operator's");
});

test("bank lines to confirm come before chasing, because chasing waits on them", () => {
  const { m, harbour, business, flow, sync, today } = setup();
  for (const cents of [30000, 30000]) m.issue(m.createDraft({ clientId: harbour.id, lines: [{ description: "Support work", unitCents: cents }] }, "operator").id, { issueDate: addDays(today, -40) }, "operator");
  const day = today.split("-").reverse().join("/");
  importStatement(m, { accountId: business.id, csv: `"${day}","+300.00","DIRECT CREDIT 551020","+1000.00"` }, "operator");
  sync();
  const v = flow.view();
  assert.equal(v.now?.title, "Confirm 1 bank line");
  assert.equal(v.now?.blocking, true);
  assert.equal(v.next.filter((t) => t.title.startsWith("Chase")).length, 2, "both chases wait behind it");
  assert.ok(v.next.some((t) => t.title === "Check for double billing"), "two identical invoices get a second look too");
});

test("focus pulls a task to Now, skip sends it back, park puts it away", () => {
  const { flow } = setup();
  const a = flow.add({ title: "Ring Harbour about the roster" });
  const b = flow.add({ title: "Renew the first-aid certificate" });
  flow.act(b.id, "focus");
  assert.equal(flow.view().now?.id, b.id);
  flow.act(b.id, "skip");
  assert.equal(flow.view().now?.id, a.id, "skipped: the next one comes in");
  assert.equal(flow.view().next[0].id, b.id, "and the skipped one waits behind it");
  flow.act(a.id, "park");
  assert.deepEqual(flow.view().parked.map((t) => t.id), [a.id]);
  flow.act(a.id, "unpark");
  assert.equal(flow.view().parked.length, 0);
});

test("done counts toward today and the streak; raised work can be parked but not dropped", () => {
  const { m, harbour, flow, sync } = setup();
  const t = flow.add({ title: "Send the roster" });
  flow.act(t.id, "done");
  const v = flow.view();
  assert.equal(v.doneToday, 1);
  assert.equal(v.streak, 1);
  assert.throws(() => flow.act(t.id, "done"), /already closed/);

  m.createDraft({ clientId: harbour.id, lines: [{ description: "Support work", unitCents: 100 }] }, "operator");
  sync();
  const raised = flow.view().now!;
  assert.throws(() => flow.act(raised.id, "drop"), /park it instead/);
  flow.act(raised.id, "park");
  sync();
  assert.equal(flow.view().parked[0].id, raised.id, "a parked task stays parked when it's raised again");
});

test("the default ranking: alarms over pressing work over calm, focus over everything", () => {
  const ctx = { now: new Date("2026-10-10T00:00:00Z"), today: "2026-10-10" };
  const base = { id: "x", key: null, context: "", source: "you" as const, ref: null, cents: null, dueOn: null, blocking: false, state: "open" as const,
    createdAt: "2026-10-10T00:00:00Z", updatedAt: "", skippedAt: null, focusAt: null, closedAt: null, closedBy: null };
  const calm = scoreTask({ ...base, title: "calm", urgency: 0 }, ctx);
  const pressing = scoreTask({ ...base, title: "pressing", urgency: 2 }, ctx);
  const alarm = scoreTask({ ...base, title: "alarm", urgency: 3, blocking: true }, ctx);
  const focused = scoreTask({ ...base, title: "focused", urgency: 0, focusAt: "2026-10-10T00:00:00Z" }, ctx);
  assert.ok(focused > alarm && alarm > pressing && pressing > calm);
});

test("Signals reads like sentences; Artifacts carry where they came from; months add up", async () => {
  const { m, harbour, flow, today } = setup();
  const inv = m.issue(m.createDraft({ clientId: harbour.id, lines: [{ description: "Support work", unitCents: 41460 }] }, "operator").id, { issueDate: today }, "operator");
  m.recordPayment({ invoiceId: inv.id, amountCents: 41460, receivedOn: today, matchedBy: "bank" }, "operator");
  flow.add({ title: "Ring Harbour" });
  const s = signals(m);
  assert.equal(s[0].text, "added: Ring Harbour");
  assert.ok(s.some((x) => x.who === "Bank" && x.text === "payment in: $414.60 on 00101 (Harbour Plan Managers)"));
  assert.ok(s.some((x) => x.who === "Money" && x.text === "invoice 00101 issued to Harbour Plan Managers"));

  const [a] = artifacts(m);
  assert.equal(a.title, "Invoice 00101 · Harbour Plan Managers");
  assert.equal(a.by, "you");
  assert.equal(a.cloudSaw, "nothing");
  assert.equal(a.open, `/ogdoad/money/invoices/${inv.id}/pdf`);

  const months = monthly(m);
  assert.equal(months.length, 12);
  assert.deepEqual(months.at(-1), { month: today.slice(0, 7), invoicedCents: 41460, receivedCents: 41460 });
});

test("the team's questions and tasks land in Flow; a question clears once answered, and an unreadable server wipes nothing", async () => {
  const { m, flow } = setup();
  const subject = (id: string, title: string | null) => ({ kind: "interaction", id, title, identifier: null, status: "pending", href: `/OGD/issues/OGD-1#interaction-${id}` });
  const ask = {
    sourceKind: "issue_thread_interaction", subject: subject("q1", "Your team (2 of 4)"), whyNow: "Waiting on your answer", severity: "medium" as const,
    relatedIssue: { kind: "issue", id: "issue-1", title: "Set up", identifier: "OGD-1", status: "in_progress", href: "/OGD/issues/OGD-1" },
    originAgentName: null, dismissal: null, snoozedUntil: null,
    detail: { kind: "questions", firstQuestionText: "Who should be on the team first?", questionCount: 3, createdByAgentName: "SOPHIA - Sample Co" },
  };
  const failed = { ...ask, sourceKind: "failed_run", subject: { ...subject("run-9", "Nightly bank check"), kind: "run" }, severity: "high" as const, relatedIssue: null, detail: null, whyNow: "The run stopped with an error" };
  const assigned = [
    { id: "i-2", identifier: "OGD-2", title: "Sign the lease", status: "todo", priority: "high" },
    { id: "i-3", identifier: "OGD-3", title: "Old thing", status: "done", priority: "low" },
  ];
  const raised = raisedFromAttention([ask, failed], assigned, "http://127.0.0.1:3100");
  assert.deepEqual(raised.map((r) => r.key), ["team:ask:q1", "team:failed_run:run-9", "team:issue:i-2"], "done tasks stay out");
  assert.equal(raised[0].title, "SOPHIA asks: Your team (2 of 4)");
  assert.equal(raised[0].context, "Who should be on the team first? (3 questions)");
  assert.equal(raised[0].ref, "/flow/ask/issue-1/q1", "answered in place");
  assert.equal(raised[1].ref, "http://127.0.0.1:3100/OGD/issues/OGD-1#interaction-run-9", "the rest opens where it lives");
  assert.equal(raised[2].ref, "http://127.0.0.1:3100/OGD/issues/OGD-2");

  const sync = (team: Raised[] | null) => syncFlow(m, { team: async () => team });
  await sync(raised);
  const ids = () => [flow.view().now, ...flow.view().next].filter(Boolean).map((t) => t!.key);
  assert.deepEqual(ids().sort(), ["team:ask:q1", "team:failed_run:run-9", "team:issue:i-2"].sort());
  const q = flow.view().now!.key === "team:ask:q1" ? flow.view().now! : flow.view().next.find((t) => t.key === "team:ask:q1")!;
  assert.throws(() => flow.act(q.id, "done"), /Answer the question/, "done would leave the hire waiting");

  await sync(null);
  assert.equal(ids().length, 3, "the server didn't answer: nothing is cleared");
  await sync(raised.slice(1));
  assert.ok(!ids().includes("team:ask:q1"), "answered: the question cleared itself");
  assert.equal(flow.task(q.id).closedBy, "cleared");
});

test("a crossing names who got it, through what, and whether it's a cloud model; never more than a summary", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { recordCrossing, crossings, recipientFor } = await import("../crossings.js");
  const home = mkdtempSync(join(tmpdir(), "ogdoad-crossing-"));
  mkdirSync(join(home, "horos"));
  writeFileSync(join(home, "sophia.json"), JSON.stringify({ taskId: "task-1", hireId: "h1" }));
  writeFileSync(join(home, "horos", "roster.json"), JSON.stringify([{ id: "h1", harness: "claude" }, { id: "h2", harness: "ollama", label: "Ledger - local model", seat: { agentId: "agent-ledger" } }]));
  // A stand-in Ogdoad server that knows who each task is assigned to.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => res.end(JSON.stringify(req.url === "/api/issues/task-2" ? { assigneeAgentId: "agent-ledger" } : {})));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { m } = setup();
  const send = async (issue: string, kind: "message" | "answer", body: unknown) => recordCrossing(m, issue, kind, Buffer.from(JSON.stringify(body)), await recipientFor(issue, base, home));
  await send("task-1", "message", { body: "Ring the plan manager\nabout the roster" });
  await send("task-1", "answer", { answers: [{}, {}] });
  await send("task-9", "message", { body: 'Dashboard request from the operator: "hours by week"\n\nschema...' });
  await send("task-2", "message", { body: "Match last week's bank lines" });
  server.close();
  const ledger = crossings(m)[0];
  assert.deepEqual([ledger.who, ledger.via, ledger.where], ["Ledger", "Ollama", "local"], "another task's assignee, matched to its hire's seat");
  const [, panel, answer, message] = crossings(m);
  assert.deepEqual([message.who, message.via, message.where, message.what], ["SOPHIA", "Claude Code", "cloud", "Ring the plan manager about the roster"]);
  assert.equal(answer.what, "answered a question card (2 answers)");
  assert.deepEqual([panel.who, panel.where], ["the team", "unknown"]);
  assert.match(panel.what, /asked for a panel \(the tables' shape went too, no rows\): hours by week/);
  assert.ok(signals(m).some((s) => s.who === "crossing" && s.text.startsWith("to SOPHIA (Claude Code, a cloud model): Ring")));
});

test("an approval lands in Flow to be decided there, and can't just be marked done", async () => {
  const { m, flow } = setup();
  const approval = {
    sourceKind: "approval", subject: { kind: "approval", id: "ap-1", title: "Hire Ledger, a local bookkeeper", identifier: null, status: "pending", href: "/OGD/approvals/ap-1" },
    whyNow: "SOPHIA asked to hire", severity: "high" as const, relatedIssue: null, originAgentName: "SOPHIA", dismissal: null, snoozedUntil: null, detail: null,
  };
  const [r] = raisedFromAttention([approval], [], "http://127.0.0.1:3100");
  assert.deepEqual([r.key, r.ref, r.title, r.blocking], ["team:approval:ap-1", "/flow/approve/ap-1", "Approve or turn down: Hire Ledger, a local bookkeeper", true]);
  await syncFlow(m, { team: async () => [r] });
  const t = flow.view().now!;
  assert.throws(() => flow.act(t.id, "done"), /Approve it or turn it down/);
});

test("a reminder is drafted for the operator to send, its tone follows how late it is, and Flow rests a week after", async () => {
  const { chaseDraft, recordChased } = await import("../money/chase.js");
  const { m, harbour, flow, sync, today } = setup();
  m.updateClient(harbour.id, { contactName: "Pat Example", email: "accounts@example.invalid" }, "operator");
  const late = (days: number) => m.issue(m.createDraft({ clientId: harbour.id, lines: [{ description: "Support work", unitCents: 41460 }] }, "operator").id, { issueDate: addDays(today, -14 - days) }, "operator");
  const gentle = chaseDraft(m, late(5).id);
  assert.equal(gentle.tone, "gentle");
  assert.equal(gentle.to, "accounts@example.invalid");
  assert.match(gentle.body, /^Hi Pat Example,/);
  assert.match(gentle.body, /BSB 111111 {3}Account 87654321\nReference: 00101/);
  assert.equal(chaseDraft(m, late(30).id).tone, "firm");
  const old = late(70);
  const final = chaseDraft(m, old.id);
  assert.equal(final.tone, "final");
  assert.match(final.subject, /^Final reminder: invoice 00103 from Sample Co$/);

  sync();
  const before = [flow.view().now, ...flow.view().next, ...flow.view().later].find((t) => t!.key === `money:late:${old.id}`)!;
  assert.equal(before.ref, `/money/invoices/${old.id}/chase`);
  assert.equal(before.urgency, 2);
  recordChased(m, old.id, "email");
  sync();
  const after = flow.task(before.id);
  assert.equal(after.urgency, 0, "resting for a week");
  assert.match(after.context, /You sent a reminder on/);
  assert.equal(chaseDraft(m, old.id).lastChasedAt !== null, true);
});

test("what's typed straight into a hire's terminal is a crossing too, named by the hire's harness", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { recordDirectCrossing, recipientOfHire, crossings } = await import("../crossings.js");
  const home = mkdtempSync(join(tmpdir(), "ogdoad-direct-"));
  mkdirSync(join(home, "horos"));
  writeFileSync(join(home, "horos", "roster.json"), JSON.stringify([{ id: "h7", harness: "grok", label: "Scout - grok CLI" }]));
  const { m } = setup();
  recordDirectCrossing(m, "h7", "Find three   local plan managers", recipientOfHire("h7", home));
  recordDirectCrossing(m, "h8", "hello", recipientOfHire("h8", home, { label: "Ledger - Ollama", harness: "ollama" }));
  const [ledger, scout] = crossings(m);
  assert.deepEqual([scout.who, scout.via, scout.where, scout.what, scout.issueId], ["Scout", "grok CLI", "cloud", "Find three local plan managers", "hire:h7"]);
  assert.deepEqual([ledger.who, ledger.where], ["Ledger", "local"]);
});
