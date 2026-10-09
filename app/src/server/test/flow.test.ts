// Flow and the control center's reads, on made-up books: raised work appears and clears itself, the
// ranking puts first things first, the operator's own tasks count, and Signals reads like sentences.

import { test } from "node:test";
import assert from "node:assert/strict";

import { artifacts, monthly, signals } from "../center.js";
import { Flow, raisedFromMoney } from "../flow/flow.js";
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
