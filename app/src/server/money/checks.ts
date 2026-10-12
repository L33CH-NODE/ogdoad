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
 * The operator's rule (2026-10-13). It flags two things:
 *  1. overpaid: money received is more than the invoice total (one invoice paid twice);
 *  2. possible double bill: two issued invoices to the same client and participant, for the same
 *     total, whose service periods overlap. That's the shape a re-sent invoice takes. Regular
 *     fortnightly support repeats the amount over periods that follow on, and never overlaps.
 */
export function doubleBillingFindings(invoices: InvoiceSummary[]): Finding[] {
  const findings: Finding[] = [];
  const issued = invoices.filter((i) => i.status === "issued");

  for (const inv of issued) {
    if (inv.paidCents > inv.totalCents) {
      findings.push({ kind: "overpaid", invoiceIds: [inv.id], message: `Invoice ${inv.number} was paid more than its total. It may have been paid twice; check the bank and refund or credit the difference.` });
    }
  }

  // The period an invoice covers: its service dates, else the one it has, else its issue date.
  const period = (i: InvoiceSummary) => {
    const from = i.serviceFrom ?? i.serviceTo ?? i.issueDate ?? "";
    const to = i.serviceTo ?? i.serviceFrom ?? i.issueDate ?? "";
    return from <= to ? [from, to] : [to, from];
  };
  const groups = new Map<string, InvoiceSummary[]>();
  for (const inv of issued) {
    const key = `${inv.clientId}|${inv.participant.trim().toLowerCase()}|${inv.totalCents}`;
    groups.set(key, [...(groups.get(key) ?? []), inv]);
  }
  for (const group of groups.values()) {
    const flagged = new Set<string>();
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = [group[i], group[j]];
        if (flagged.has(b.id)) continue;
        const [aFrom, aTo] = period(a);
        const [bFrom, bTo] = period(b);
        if (!aFrom || !bFrom || aFrom > bTo || bFrom > aTo) continue;
        flagged.add(b.id);
        findings.push({ kind: "possible_double_bill", invoiceIds: [a.id, b.id], message: `Invoices ${a.number} and ${b.number} are for the same client and amount, over service periods that overlap. One may be a duplicate.` });
      }
    }
  }
  return findings;
}
