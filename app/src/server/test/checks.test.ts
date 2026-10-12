// The double-billing checks, on synthetic invoices.

import { test } from "node:test";
import assert from "node:assert/strict";

import { doubleBillingFindings } from "../money/checks.js";
import type { InvoiceSummary } from "../money/service.js";

function inv(over: Partial<InvoiceSummary>): InvoiceSummary {
  return {
    id: Math.random().toString(36).slice(2), number: "00001", status: "issued", clientId: "c1", clientName: "Sample", issueDate: "2026-09-01", dueDate: "2026-09-15",
    serviceFrom: null, serviceTo: "2026-09-01", totalCents: 13000, paidCents: 0, balanceCents: 13000, daysOverdue: null, bucket: "current", source: "manual", participant: "", ...over,
  };
}

test("the same client and amount over overlapping service periods is flagged: a re-sent invoice", () => {
  const a = inv({ number: "00030", serviceFrom: "2026-09-01", serviceTo: "2026-09-14" });
  const resent = inv({ number: "00031", serviceFrom: "2026-09-08", serviceTo: "2026-09-21" });
  const f = doubleBillingFindings([a, resent]);
  assert.deepEqual(f.map((x) => x.kind), ["possible_double_bill"]);
  assert.deepEqual(f[0].invoiceIds, [a.id, resent.id]);
  assert.match(f[0].message, /00030.*00031/);
});

test("regular fortnightly support for one client, the same amount each time, never flags", () => {
  const fortnights = [["2026-08-04", "2026-08-17"], ["2026-08-18", "2026-08-31"], ["2026-09-01", "2026-09-14"], ["2026-09-15", "2026-09-28"]];
  assert.deepEqual(doubleBillingFindings(fortnights.map(([from, to], i) => inv({ number: `0004${i}`, serviceFrom: from, serviceTo: to }))), []);
});

test("a different NDIS participant on the same client and period isn't a duplicate", () => {
  const a = inv({ number: "00050", serviceFrom: "2026-09-01", serviceTo: "2026-09-14", participant: "Participant A" });
  const b = inv({ number: "00051", serviceFrom: "2026-09-01", serviceTo: "2026-09-14", participant: "Participant B" });
  assert.deepEqual(doubleBillingFindings([a, b]), []);
  const twin = inv({ number: "00052", serviceFrom: "2026-09-10", serviceTo: "2026-09-10", participant: "participant a" });
  assert.equal(doubleBillingFindings([a, b, twin]).length, 1, "the same participant, however it's written");
});

test("an invoice paid more than its total is flagged", () => {
  const f = doubleBillingFindings([inv({ number: "00010", paidCents: 26000 })]);
  assert.deepEqual(f.map((x) => x.kind), ["overpaid"]);
  assert.match(f[0].message, /00010/);
});

test("the same client, amount and supply date twice is flagged; different dates aren't", () => {
  const a = inv({ number: "00020" });
  const b = inv({ number: "00021" });
  const c = inv({ number: "00022", serviceTo: "2026-09-15" });
  const f = doubleBillingFindings([a, b, c]);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].invoiceIds, [a.id, b.id]);
});

test("voided invoices and drafts never count", () => {
  assert.deepEqual(doubleBillingFindings([inv({}), inv({ status: "void" }), inv({ status: "draft" })]), []);
});
