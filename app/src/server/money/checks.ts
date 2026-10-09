// Checks that run over the books and surface problems before they cost money: double billing (the
// same work invoiced twice) and double payment (one invoice paid twice, as happened when paid
// invoices were re-sent). Findings show on the Money screen, and later in SOPHIA's ranked banner.

import type { InvoiceSummary } from "./service.js";

export interface Finding {
  kind: "overpaid" | "possible_double_bill";
  /** The invoices involved, by id, so the UI can open them. */
  invoiceIds: string[];
  /** One plain sentence for the operator. */
  message: string;
}

/**
 * TODO(operator): this is yours to shape. You know how the old double payments and duplicate invoices
 * actually happened, so you know what the check should catch, and what would just be noise
 * (regular fortnightly support for one client is *meant* to repeat the same amount).
 *
 * The default below flags two things:
 *  1. overpaid: money received is more than the invoice total (one invoice paid twice);
 *  2. possible double bill: two issued invoices to the same client, same total, same supply date.
 *
 * Things to weigh: should "same supply date" be "overlapping service periods"? Should a different
 * NDIS participant on the same client clear it? How close do two dates need to be?
 */
export function doubleBillingFindings(invoices: InvoiceSummary[]): Finding[] {
  const findings: Finding[] = [];
  const issued = invoices.filter((i) => i.status === "issued");

  for (const inv of issued) {
    if (inv.paidCents > inv.totalCents) {
      findings.push({ kind: "overpaid", invoiceIds: [inv.id], message: `Invoice ${inv.number} was paid more than its total. It may have been paid twice; check the bank and refund or credit the difference.` });
    }
  }

  const seen = new Map<string, InvoiceSummary>();
  for (const inv of issued) {
    const supply = inv.serviceTo ?? inv.serviceFrom ?? inv.issueDate;
    const key = `${inv.clientId}|${inv.totalCents}|${supply}`;
    const twin = seen.get(key);
    if (twin) {
      findings.push({ kind: "possible_double_bill", invoiceIds: [twin.id, inv.id], message: `Invoices ${twin.number} and ${inv.number} are for the same client, amount and date. One may be a duplicate.` });
    } else {
      seen.set(key, inv);
    }
  }
  return findings;
}
