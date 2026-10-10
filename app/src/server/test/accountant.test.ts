// The accountant pack, on made-up books: years run 1 July to 30 June, an invoice belongs to the year it
// was issued and a payment to the year it arrived, and "owed on 30 June" counts only what came by then.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fyOf, fyRange, invoicesCsv, paymentsCsv, summary, summaryPdf, years } from "../money/accountant.js";
import { openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";

function books() {
  const m = new Money(openMoneyDb(":memory:"));
  const business = m.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111111", accountNumber: "87654321" }, "operator");
  m.updateSettings({ businessName: "Sample Co", abn: "51824753556", defaultAccountId: business.id, nextNumber: 101 }, "operator");
  const harbour = m.createClient({ name: "Harbour Plan Managers", participantName: "Participant A" }, "operator");
  const kestrel = m.createClient({ name: "Kestrel, \"Support\" Co" }, "operator");
  const issue = (clientId: string, cents: number, day: string) => m.issue(m.createDraft({ clientId, lines: [{ description: "Support", unitCents: cents }] }, "operator").id, { issueDate: day }, "operator");
  const a = issue(harbour.id, 50000, "2025-06-20"); // the year before
  const b = issue(harbour.id, 40000, "2025-08-01");
  const c = issue(kestrel.id, 30000, "2026-06-15");
  m.recordPayment({ invoiceId: a.id, amountCents: 50000, receivedOn: "2025-07-03", matchedBy: "bank" }, "operator"); // paid in the new year
  m.recordPayment({ invoiceId: b.id, amountCents: 40000, receivedOn: "2025-08-20", matchedBy: "bank" }, "operator");
  m.recordPayment({ invoiceId: c.id, amountCents: 30000, receivedOn: "2026-07-02", matchedBy: "manual" }, "operator"); // after 30 June
  return { m };
}

test("financial years run from 1 July to 30 June", () => {
  assert.equal(fyOf("2025-07-01"), "2025-26");
  assert.equal(fyOf("2026-06-30"), "2025-26");
  assert.equal(fyOf("2026-07-01"), "2026-27");
  assert.deepEqual(fyRange("2025-26"), { from: "2025-07-01", to: "2026-06-30" });
  assert.throws(() => fyRange("2025-27"), /looks like 2025-26/);
});

test("the year's invoices, payments and summary add up the way an accountant reads them", async () => {
  const { m } = books();
  assert.ok(years(m).includes("2024-25") && years(m).includes("2025-26"));
  const s = summary(m, "2025-26");
  assert.equal(s.invoicedCents, 70000, "issued in the year: B and C");
  assert.equal(s.receivedCents, 90000, "arrived in the year: A's (from last year) and B's");
  assert.equal(s.owedAtEndCents, 30000, "C was still owed on 30 June");
  assert.equal(s.byMonth.length, 12);
  assert.equal(s.byMonth[0].month, "2025-07");
  assert.equal(s.byClient[0].client, "Harbour Plan Managers");

  const inv = invoicesCsv(m, "2025-26").trim().split("\r\n");
  assert.equal(inv.length, 3, "a header and two invoices");
  assert.match(inv[0], /^Number,Status,Client,Participant,Issued/);
  assert.ok(inv.some((l) => l.includes('"Kestrel, ""Support"" Co"')), "commas and quotes are escaped");
  assert.ok(inv.some((l) => l.includes("300.00,0.00,300.00,0.00")), "C: total 300, nothing by 30 June, paid since, owed nothing now");
  const pay = paymentsCsv(m, "2025-26").trim().split("\r\n");
  assert.equal(pay.length, 3);
  assert.ok(pay[1].startsWith("2025-07-03,00101,Harbour Plan Managers,500.00,bank,Business"));

  const pdf = await summaryPdf(m, "2025-26");
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString("latin1"), "%PDF-");
});
