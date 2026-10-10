// Work on made-up books: shifts are rostered (and repeated), a note is needed before a shift can be
// billed, billing makes a draft with a line per shift and its travel, and a rejected draft frees its
// shifts again. Flow hears about notes due, incidents and shifts ready to bill.

import { test } from "node:test";
import assert from "node:assert/strict";

import { actOnTask, artifacts, signals, syncFlow } from "../center.js";
import { Flow } from "../flow/flow.js";
import { openMoneyDb } from "../money/db.js";
import { addDays, Money } from "../money/service.js";
import { raisedFromWork, shiftMinutes, Work } from "../work/work.js";

function setup() {
  const m = new Money(openMoneyDb(":memory:"));
  const business = m.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111111", accountNumber: "87654321" }, "op");
  m.updateSettings({ businessName: "Sample Co", abn: "51824753556", nextNumber: 101, defaultAccountId: business.id }, "operator");
  const harbour = m.createClient({ name: "Harbour Plan Managers", participantName: "Participant A", payToAccountId: business.id }, "operator");
  const kestrel = m.createClient({ name: "Kestrel Support Co", participantName: "Participant B" }, "operator");
  return { m, work: new Work(m), harbour, kestrel, today: m.today() };
}

test("shift length: an end at or before the start runs past midnight", () => {
  assert.equal(shiftMinutes("09:00", "12:30"), 210);
  assert.equal(shiftMinutes("22:00", "07:00"), 540);
});

test("shifts are rostered, repeat weekly, and start from the client's last rate", () => {
  const { work, harbour, today } = setup();
  const [first] = work.add({ clientId: harbour.id, day: addDays(today, 3), start: "09:00", end: "12:30", support: "Community access", rateCents: 6547, km: 10, kmRateCents: 99 });
  assert.equal(first.minutes, 210);
  assert.equal(first.cents, Math.round(3.5 * 6547) + 990);
  assert.equal(first.phase, "ahead");
  assert.equal(first.participantName, "Participant A", "the client's participant when the shift names none");

  const series = work.add({ clientId: harbour.id, day: addDays(today, 4), start: "13:00", end: "15:00", repeatWeeks: 3 });
  assert.equal(series.length, 4);
  assert.deepEqual(series.map((s) => s.day), [4, 11, 18, 25].map((d) => addDays(today, d)));
  assert.ok(series.every((s) => s.seriesId && s.seriesId === series[0].seriesId));
  assert.equal(series[0].rateCents, 6547, "rate carried from the last shift");
  assert.equal(series[0].support, "Community access");

  assert.throws(() => work.add({ clientId: harbour.id, day: today, start: "9am", end: "12:00" }), /time like 09:30/);
  assert.throws(() => work.add({ clientId: "nobody", day: today, start: "09:00", end: "12:00" }), /Pick the client/);
});

test("a note comes before billing; billing makes one draft with a line per shift and its travel", () => {
  const { m, work, harbour, kestrel, today } = setup();
  const [a] = work.add({ clientId: harbour.id, day: addDays(today, -4), start: "09:00", end: "12:00", support: "Community access", rateCents: 6000, km: 20, kmRateCents: 99 });
  const [b] = work.add({ clientId: harbour.id, day: addDays(today, -2), start: "13:00", end: "14:30", support: "Community access" });
  const [ahead] = work.add({ clientId: harbour.id, day: addDays(today, 5), start: "09:00", end: "10:00" });
  work.add({ clientId: kestrel.id, day: addDays(today, -1), start: "10:00", end: "11:00", rateCents: 5000 });

  assert.throws(() => work.writeNote(ahead.id, { body: "Not yet", final: true }), /hasn't started yet/);
  assert.throws(() => work.writeNote(a.id, { body: " ", final: true }), /Say what happened/);
  assert.throws(() => work.bill(harbour.id), /No finished shifts with notes/);

  work.writeNote(a.id, { body: "Shops and lunch.", goals: "Money handling", final: true });
  assert.equal(work.shift(a.id).status, "done");
  work.writeNote(b.id, { body: "Half done" });
  assert.equal(work.shift(b.id).note, "draft");

  const [bill] = work.billable();
  assert.equal(bill.clientName, "Harbour Plan Managers");
  assert.equal(bill.shifts, 1);
  assert.equal(bill.waitingOnNotes, 1, "the draft note still holds one back");

  const draft = work.bill(harbour.id);
  assert.equal(draft.status, "draft");
  assert.equal(draft.lines.length, 2);
  assert.match(draft.lines[0].description, /^Community access · \w{3} \d+ \w{3}, 09:00–12:00$/);
  assert.equal(draft.lines[0].quantity, 3);
  assert.equal(draft.lines[0].unitCents, 6000);
  assert.equal(draft.lines[1].quantity, 20);
  assert.equal(draft.totalCents, 18000 + 1980);
  assert.equal(draft.serviceFrom, addDays(today, -4));
  assert.equal(work.shift(a.id).billed?.invoiceId, draft.id);
  assert.throws(() => work.update(a.id, { end: "13:00" }), /on a draft already/);

  m.rejectDraft(draft.id, "wrong rate", "operator");
  assert.equal(work.shift(a.id).billed, null, "a rejected draft frees its shifts");
  assert.ok(work.update(a.id, { rateCents: 6547 }));
});

test("Flow hears notes due, incidents and shifts ready to bill, and they clear themselves", () => {
  const { work, harbour, today } = setup();
  const [old] = work.add({ clientId: harbour.id, day: addDays(today, -5), start: "09:00", end: "12:00", rateCents: 6000 });
  const [recent] = work.add({ clientId: harbour.id, day: addDays(today, -1), start: "09:00", end: "12:00" });
  work.add({ clientId: harbour.id, day: addDays(today, 2), start: "09:00", end: "12:00" });

  let raised = raisedFromWork(work, today);
  assert.deepEqual(raised.map((r) => r.key), [`work:note:${old.id}`, `work:note:${recent.id}`], "only shifts that are over need notes");
  assert.equal(raised[0].title, "Write the note for Participant A's shift");
  assert.equal(raised[0].urgency, 2, "an old note presses");
  assert.equal(raised[1].urgency, 1);

  work.writeNote(old.id, { body: "Pool.", incident: true, incidentDetail: "Slipped; no injury.", final: true });
  raised = raisedFromWork(work, today);
  assert.ok(raised.some((r) => r.key === `work:incident:${old.id}` && r.urgency === 3));
  assert.ok(raised.some((r) => r.key === `work:bill:${harbour.id}` && r.cents === 18000));
  assert.match(raised.find((r) => r.key.startsWith("work:incident"))!.context, /NDIS Commission's current rules/);

  work.incidentReported(old.id);
  work.bill(harbour.id);
  raised = raisedFromWork(work, today);
  assert.deepEqual(raised.map((r) => r.key), [`work:note:${recent.id}`]);
});

test("the trail and the shelf name a note, never what it says", () => {
  const { m, work, harbour, today } = setup();
  const [s] = work.add({ clientId: harbour.id, day: addDays(today, -1), start: "09:00", end: "12:00" });
  work.writeNote(s.id, { body: "A private detail about the day", final: true });
  const text = JSON.stringify([signals(m), artifacts(m)]);
  assert.ok(!text.includes("private detail"));
  const note = artifacts(m).find((a) => a.kind === "note")!;
  assert.equal(note.title, `Shift note · Participant A · ${addDays(today, -1)}`);
  assert.equal(note.open, null);
  assert.equal(note.ref, `/work/shift/${s.id}`);
  assert.ok(signals(m).some((x) => x.text.startsWith("finished a shift note: Harbour Plan Managers")));
});

test("in Flow, a note can't just be marked done, and an incident's Done marks it reported", async () => {
  const { m, work, harbour, today } = setup();
  const [s] = work.add({ clientId: harbour.id, day: addDays(today, -1), start: "09:00", end: "12:00" });
  const flow = (await syncFlow(m, {}));
  const noteTask = flow.view().now!;
  assert.equal(noteTask.key, `work:note:${s.id}`);
  assert.throws(() => actOnTask(m, noteTask.id, "done"), /Write the note/);

  work.writeNote(s.id, { body: "Pool.", incident: true, incidentDetail: "Slipped; no injury.", final: true });
  await syncFlow(m, {});
  const incident = new Flow(m).view().now!;
  assert.equal(incident.key, `work:incident:${s.id}`, "an incident leads");
  actOnTask(m, incident.id, "done");
  assert.ok(work.shift(s.id).incidentReported);
  assert.equal(new Flow(m).view().doneToday, 1, "reporting it counts as the operator's");
});
