// Money in, on synthetic statements: what's matched on its own, what waits for the operator, and what
// never gets stored.

import { test } from "node:test";
import assert from "node:assert/strict";

import { confirmLine, ignoreLine, importStatement, matchCredit, nameTokens, parseBankCsv, reviewLines } from "../money/bank.js";
import { openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";

function setup() {
  const m = new Money(openMoneyDb(":memory:"));
  const personal = m.createAccount({ label: "Personal", kind: "personal", bankName: "Sample Bank", accountName: "Sample Person", bsb: "000000", accountNumber: "12345678" }, "op");
  const business = m.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111111", accountNumber: "87654321" }, "op");
  m.updateSettings({ businessName: "Sample Co", abn: "51824753556", nextNumber: 101 }, "op");
  const harbour = m.createClient({ name: "Harbour Plan Managers Pty Ltd", payToAccountId: personal.id }, "op");
  const kestrel = m.createClient({ name: "Kestrel Support Co", payToAccountId: personal.id }, "op");
  const issue = (clientId: string, cents: number, date: string) =>
    m.issue(m.createDraft({ clientId, lines: [{ description: "Support work", unitCents: cents }] }, "op").id, { issueDate: date }, "op");
  return { m, personal, business, harbour, kestrel, issue };
}

const csv = (rows: Array<[string, string, string, string]>) => rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\r\n");

test("the bank's headerless CSV is read: day-first dates, signed amounts, balance", () => {
  const { rows, unreadable } = parseBankCsv(csv([["05/09/2026", "+414.60", "Transfer from HARBOUR PLAN", "+12500.00"], ["06/09/2026", "-42.10", "Groceries", "+12457.90"]]) + '\r\n"Date","Amount","Description","Balance"');
  assert.equal(unreadable, 1, "a header or total line is skipped");
  assert.deepEqual(rows[0], { postedOn: "2026-09-05", amountCents: 41460, description: "Transfer from HARBOUR PLAN", balanceCents: 1250000 });
  assert.equal(rows[1].amountCents, -4210);
});

test("payer names ignore the words every company has", () => {
  assert.deepEqual(nameTokens("Harbour Plan Managers Pty Ltd"), ["HARBOUR"]);
});

test("matching: number named, amount and payer, amount alone, a batch, paid twice, already recorded", () => {
  const inv = (id: string, number: string, client: string, cents: number, balance = cents) => ({ id, number, clientId: client, clientName: client, issueDate: "2026-08-01", totalCents: cents, balanceCents: balance });
  const open = [inv("a", "00101", "Harbour Plan Managers", 41460), inv("b", "00102", "Kestrel Support Co", 35408), inv("c", "00103", "Kestrel Support Co", 28762), inv("d", "00104", "Mill Lane Care", 35408)];
  const paid = [inv("e", "00090", "Harbour Plan Managers", 50000, 0)];
  const row = (amountCents: number, description: string) => ({ postedOn: "2026-09-05", amountCents, description, balanceCents: null });

  assert.deepEqual(matchCredit(row(10000, "PAYMENT INV 103 KESTREL"), open, paid, []), { kind: "certain", invoiceIds: ["c"], reason: "the description names invoice 00103" });
  assert.equal(matchCredit(row(41460, "HARBOUR PLAN MGRS"), open, paid, []).kind, "certain");
  const alone = matchCredit(row(41460, "TRANSFER 88213"), open, paid, []);
  assert.equal(alone.kind, "suggested", "an amount alone is never enough to record a payment");
  const two = matchCredit(row(35408, "TRANSFER 55102"), open, paid, []);
  assert.equal(two.kind, "suggested");
  assert.equal(two.kind === "suggested" && two.groups.length, 2, "two invoices for that amount: both offered");
  const batch = matchCredit(row(35408 + 28762, "KESTREL SUPPORT PAYMENT"), open, paid, []);
  assert.ok(batch.kind === "suggested" && batch.groups.some((g) => g.length === 2 && g.includes("b") && g.includes("c")), "one payment for two invoices");
  assert.equal(matchCredit(row(50000, "HARBOUR PLAN"), open, paid, []).kind, "paid_twice");
  assert.equal(matchCredit(row(41460, "HARBOUR PLAN"), open, paid, [{ id: "p1", invoiceId: "a", amountCents: 41460, receivedOn: "2026-09-04" }]).kind, "recorded");
});

test("importing a personal statement records sure matches, keeps suggestions, and drops everything else", () => {
  const { m, personal, harbour, kestrel, issue } = setup();
  const a = issue(harbour.id, 41460, "2026-08-01");
  issue(kestrel.id, 35408, "2026-08-02");
  const statement = csv([
    ["05/09/2026", "+414.60", "TRANSFER FROM HARBOUR PLAN", "+5000.00"],
    ["06/09/2026", "+354.08", "TRANSFER 55102", "+5354.08"],
    ["07/09/2026", "+1200.00", "SALARY FROM SOMEWHERE ELSE", "+6554.08"],
    ["08/09/2026", "-80.00", "Fuel", "+6474.08"],
  ]);
  const s = importStatement(m, { accountId: personal.id, csv: statement }, "op");
  assert.deepEqual([s.credits, s.matched, s.suggested, s.personalDropped, s.debitsSkipped], [3, 1, 1, 1, 1]);
  assert.equal(m.invoice(a.id)!.bucket, "paid");
  assert.equal(m.invoice(a.id)!.payments[0].receivedOn, "2026-09-05");
  const stored = m.db.prepare("SELECT description FROM bank_lines").all().map((r: any) => r.description);
  assert.ok(!stored.some((d: string) => /SALARY|Fuel/.test(d)), "personal lines that pay no invoice are never stored");

  const again = importStatement(m, { accountId: personal.id, csv: statement }, "op");
  assert.equal(again.alreadyImported, 2, "the same statement again changes nothing");
  assert.equal(again.matched + again.suggested, 0);
});

test("the operator confirms a suggestion or ignores it; a business account keeps unexplained income", () => {
  const { m, personal, business, kestrel, issue } = setup();
  const b = issue(kestrel.id, 35408, "2026-08-02");
  importStatement(m, { accountId: personal.id, csv: csv([["06/09/2026", "+354.08", "TRANSFER 55102", "+1.00"]]) }, "op");
  const [line] = reviewLines(m);
  assert.equal(line.groups[0][0].number, b.number);
  confirmLine(m, line.id, [b.id], "op");
  assert.equal(m.invoice(b.id)!.bucket, "paid");
  assert.equal(reviewLines(m).length, 0);

  const s = importStatement(m, { accountId: business.id, csv: csv([["07/09/2026", "+999.00", "UNKNOWN DEPOSIT", "+999.00"]]) }, "op");
  assert.equal(s.unmatched, 1, "business income nothing explains stays for review");
  const [unknown] = reviewLines(m);
  ignoreLine(m, unknown.id, "op");
  assert.equal(reviewLines(m).length, 0);
});
