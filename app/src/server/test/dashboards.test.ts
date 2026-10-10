// Dashboards as recipes, on made-up books: the built-in panels run, a panel can only read the curated
// tables (never a note, never a write), a runaway query is stopped, and a chart has to fit its query.

import { test } from "node:test";
import assert from "node:assert/strict";

import { signals } from "../center.js";
import { schemaText } from "../dash/curated.js";
import { Dashboards } from "../dash/recipes.js";
import { openMoneyDb } from "../money/db.js";
import { addDays, Money } from "../money/service.js";
import { Work } from "../work/work.js";

function setup() {
  const m = new Money(openMoneyDb(":memory:"));
  const business = m.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111111", accountNumber: "87654321" }, "operator");
  m.updateSettings({ businessName: "Sample Co", abn: "51824753556", defaultAccountId: business.id }, "operator");
  const harbour = m.createClient({ name: "Harbour Plan Managers", participantName: "Participant A" }, "operator");
  const today = m.today();
  const inv = m.issue(m.createDraft({ clientId: harbour.id, lines: [{ description: "Support", unitCents: 41460 }] }, "operator").id, { issueDate: today }, "operator");
  m.recordPayment({ invoiceId: inv.id, amountCents: 20000, receivedOn: today, matchedBy: "manual" }, "operator");
  const work = new Work(m);
  const [s] = work.add({ clientId: harbour.id, day: addDays(today, -1), start: "09:00", end: "12:30", rateCents: 6000 });
  work.writeNote(s.id, { body: "A private detail", final: true });
  return { m, dash: new Dashboards(m), today };
}

test("the built-in panels are recipes that run, and show their query", async () => {
  const { dash, today } = setup();
  const panels = await dash.withResults();
  assert.deepEqual(panels.map((p) => p.title), ["Money in and out", "Hours worked, by week"]);
  const [money, hours] = panels;
  assert.ok(money.result.ok);
  if (money.result.ok) {
    assert.deepEqual(money.result.columns, ["month", "invoiced", "received"]);
    assert.equal(money.result.rows.length, 12);
    assert.deepEqual(money.result.rows.at(-1), [today.slice(0, 7), 414.6, 200]);
  }
  assert.match(money.sql, /FROM invoices/);
  assert.ok(hours.result.ok && hours.result.rows.some((r) => r[1] === 3.5));
  assert.equal(money.madeBy, "Ogdoad");
});

test("a panel reads only the curated tables: no notes, no writes, no bank details", async () => {
  const { dash } = setup();
  const notes = await dash.preview({ sql: "SELECT * FROM shift_notes", chart: { type: "table" } });
  assert.ok(!notes.ok && /no such table/.test(notes.error));
  const write = await dash.preview({ sql: "WITH x AS (SELECT 1) DELETE FROM invoices", chart: { type: "table" } });
  assert.ok(!write.ok);
  await assert.rejects(() => dash.preview({ sql: "DROP TABLE invoices", chart: { type: "table" } }), /starts with SELECT/);
  const shifts = await dash.preview({ sql: "SELECT * FROM shifts", chart: { type: "table" } });
  assert.ok(shifts.ok && !JSON.stringify(shifts.rows).includes("private detail"));
  assert.ok(!/bsb|account_number|ndis|email|body/i.test(schemaText()), "the shape a hire sees has none of them");
});

test("a runaway query is stopped, and the app carries on", { timeout: 20_000 }, async () => {
  const { dash } = setup();
  const started = Date.now();
  const r = await dash.preview({ sql: "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) AS n FROM r", chart: { type: "stat", y: ["n"] } });
  assert.ok(!r.ok && /took too long/.test(r.error));
  assert.ok(Date.now() - started < 9000);
  assert.ok((await dash.preview({ sql: "SELECT 1 AS one", chart: { type: "stat", y: ["one"] } })).ok);
});

test("a panel is added only when its chart fits its query; adding and removing is on the trail", async () => {
  const { m, dash } = setup();
  await assert.rejects(() => dash.add({ title: "Owed", sql: "SELECT SUM(total - paid) AS owed FROM invoices", chart: { type: "stat", y: ["due"] } }), /wants due/);
  await assert.rejects(() => dash.add({ title: "Owed", sql: "SELECT 1", chart: { type: "pie" } }), /bar, line, stat, table/);
  const p = await dash.add({ title: "Owed", sql: "SELECT SUM(total - paid) AS owed FROM invoices WHERE status = 'issued';", chart: { type: "stat", y: ["owed"], format: "aud", onClick: "alert(1)" }, madeBy: "SOPHIA" });
  assert.ok(p.result.ok && Math.round((p.result.rows[0][0] as number) * 100) === 21460);
  assert.deepEqual(p.chart, { type: "stat", y: ["owed"], format: "aud" }, "only the known keys are kept");
  assert.equal(p.madeBy, "SOPHIA");
  dash.remove(p.id);
  assert.equal(dash.list().length, 2);
  const s = signals(m).map((x) => x.text);
  assert.ok(s.includes("added a dashboard panel: Owed (by SOPHIA)"));
  assert.ok(s.includes("took down a dashboard panel: Owed"));
});

test("panels are read again only when something they read has moved", async () => {
  const { m, dash } = setup();
  const first = await dash.withResults();
  assert.equal(await dash.withResults(), first, "nothing moved: the same results, no new run");
  m.createClient({ name: "Kestrel Support Co" }, "operator");
  assert.notEqual(await dash.withResults(), first, "the books moved: read again");
});
