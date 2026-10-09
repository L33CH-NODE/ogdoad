// The double-billing checks, on synthetic invoices.

import { test } from "node:test";
import assert from "node:assert/strict";

import { doubleBillingFindings } from "../money/checks.js";
import type { InvoiceSummary } from "../money/service.js";

function inv(over: Partial<InvoiceSummary>): InvoiceSummary {
  return {
    id: Math.random().toString(36).slice(2), number: "00001", status: "issued", clientId: "c1", clientName: "Sample", issueDate: "2026-09-01", dueDate: "2026-09-15",
    serviceFrom: null, serviceTo: "2026-09-01", totalCents: 13000, paidCents: 0, balanceCents: 13000, daysOverdue: null, bucket: "current", source: "manual", ...over,
  };
}

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
