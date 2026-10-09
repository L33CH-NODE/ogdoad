// Money's rules on synthetic data: numbering, the ABN gate, accounts, immutability once issued,
// payments, ageing and the GST meter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { openMoneyDb } from "../money/db.js";
import { Money, MoneyError, addDays, isValidAbn } from "../money/service.js";

const ABN = "51 824 753 556"; // the ATO's published example ABN; passes the checksum

function setup(withAbn = true) {
  const money = new Money(openMoneyDb(":memory:"));
  const personal = money.createAccount({ label: "Personal", kind: "personal", bankName: "Sample Bank", accountName: "Sample Person", bsb: "000-000", accountNumber: "12345678" }, "operator");
  const business = money.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111-111", accountNumber: "87654321" }, "operator");
  money.updateSettings({ businessName: "Sample Co", nextNumber: 107, ...(withAbn ? { abn: ABN } : {}) }, "operator");
  const client = money.createClient({ name: "Harbour Studio", email: "accounts@example.invalid" }, "operator");
  return { money, personal, business, client };
}

const oneLine = [{ description: "Support work", quantity: 2, unitCents: 6500 }];

test("ABNs are checked with the ATO's algorithm", () => {
  assert.ok(isValidAbn(ABN));
  assert.ok(!isValidAbn("51 824 753 557"), "one digit off fails");
  assert.ok(!isValidAbn("1234"));
  const { money } = setup();
  assert.throws(() => money.updateSettings({ abn: "11 111 111 111" }, "operator"), (e: MoneyError) => e.code === "bad_abn");
});

test("new clients are paid into the business account by default", () => {
  const { client, business } = setup();
  assert.equal(client.payToAccountId, business.id);
});

test("issuing assigns the next number, the dates and the account, and only then", () => {
  const { money, client, business } = setup();
  const draft = money.createDraft({ clientId: client.id, lines: oneLine }, "operator");
  assert.equal(draft.status, "draft");
  assert.equal(draft.number, null, "drafts have no number, so rejected drafts leave no gaps");
  assert.equal(draft.totalCents, 13000);

  const issued = money.issue(draft.id, { issueDate: "2026-10-01" }, "operator");
  assert.equal(issued.number, "00107", "continues the old sequence");
  assert.equal(issued.issueDate, "2026-10-01");
  assert.equal(issued.dueDate, addDays("2026-10-01", 14));
  assert.equal(issued.payToAccountId, business.id);
  assert.equal(money.settings().nextNumber, 108);

  const second = money.issue(money.createDraft({ clientId: client.id, lines: oneLine }, "operator").id, { issueDate: "2026-10-02" }, "operator");
  assert.equal(second.number, "00108");
});

test("no ABN, no issuing; issued invoices never change; voiding needs a reason and no payments", () => {
  const noAbn = setup(false);
  const d = noAbn.money.createDraft({ clientId: noAbn.client.id, lines: oneLine }, "operator");
  assert.throws(() => noAbn.money.issue(d.id, {}, "operator"), (e: MoneyError) => e.code === "no_abn");

  const { money, client } = setup();
  const inv = money.issue(money.createDraft({ clientId: client.id, lines: oneLine }, "operator").id, {}, "operator");
  assert.throws(() => money.updateDraft(inv.id, { notes: "changed" }, "operator"), (e: MoneyError) => e.code === "not_draft");
  assert.throws(() => money.voidInvoice(inv.id, "  ", "operator"), (e: MoneyError) => e.code === "no_reason");
  money.recordPayment({ invoiceId: inv.id, amountCents: 1000, matchedBy: "manual" }, "operator");
  assert.throws(() => money.voidInvoice(inv.id, "wrong client", "operator"), (e: MoneyError) => e.code === "has_payments");
});

test("payments drive the balance, and ageing buckets follow the due date", () => {
  const { money, client } = setup();
  const issue = (date: string) => money.issue(money.createDraft({ clientId: client.id, lines: oneLine }, "operator").id, { issueDate: date }, "operator");
  const today = money.today();
  const fresh = issue(today);
  const late = issue(addDays(today, -40)); // due 26 days ago
  const veryLate = issue(addDays(today, -120)); // due 106 days ago
  money.recordPayment({ invoiceId: late.id, amountCents: 3000, receivedOn: addDays(today, -1), matchedBy: "bank", evidence: "statement row" }, "operator");

  const byId = new Map(money.invoices().map((i) => [i.id, i]));
  assert.equal(byId.get(fresh.id)!.bucket, "current");
  assert.equal(byId.get(late.id)!.balanceCents, 10000);
  assert.equal(byId.get(late.id)!.bucket, "1-30");
  assert.equal(byId.get(veryLate.id)!.bucket, "90+");

  money.recordPayment({ invoiceId: veryLate.id, amountCents: 13000, matchedBy: "bank" }, "operator");
  assert.equal(money.invoice(veryLate.id)!.bucket, "paid");
  const ageing = money.ageing();
  assert.deepEqual([ageing.current.count, ageing["1-30"].count, ageing["90+"].count], [1, 1, 0]);
  assert.equal(ageing["1-30"].cents, 10000);
});

test("the GST meter sums supplies over the current month and the previous eleven", () => {
  const { money, client } = setup();
  const supply = (serviceTo: string, cents: number) => {
    const d = money.createDraft({ clientId: client.id, lines: [{ description: "Work", unitCents: cents }], serviceTo }, "operator");
    money.issue(d.id, { issueDate: serviceTo }, "operator");
  };
  supply("2026-10-05", 2_000_000); // this month
  supply("2025-11-20", 3_000_000); // eleven months back: inside the window
  supply("2025-10-31", 9_000_000); // twelve months back: outside
  const m = money.gstMeter("2026-10-09");
  assert.equal(m.windowStart, "2025-11-01");
  assert.equal(m.turnoverCents, 5_000_000);
  assert.equal(m.percent, 66.7);
  assert.equal(m.level, "ok");
  supply("2026-09-15", 2_500_000);
  assert.equal(money.gstMeter("2026-10-09").level, "over", "7.5M = the threshold");
});

test("every change leaves an event", () => {
  const { money, client } = setup();
  const d = money.createDraft({ clientId: client.id, lines: oneLine }, "operator");
  money.issue(d.id, {}, "operator");
  assert.deepEqual(money.events(d.id).map((e) => e.kind), ["invoice_issued", "draft_created"]);
});
