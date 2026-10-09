// The practice copy: a second Money with its own database, full of made-up clients and invoices, for
// trying everything (issuing, voiding, payments, bank statements) without touching the real books.
// Nothing here is real: every name, number and amount is invented.

import { Flow } from "../flow/flow.js";
import { addDays, type Money } from "./service.js";

const CLIENTS = [
  { name: "Harbour Plan Managers", contactName: "Pat Example", participantName: "Participant A", ndisNumber: "430000001" },
  { name: "Kestrel Support Co", contactName: "Sam Sample", participantName: "Participant B", ndisNumber: "430000002" },
  { name: "Mill Lane Care", contactName: "Alex Placeholder", participantName: "Participant C", ndisNumber: "430000003" },
  { name: "Northside Plan Partners", contactName: "Jo Demo", participantName: "Participant D", ndisNumber: "430000004" },
];

/** Wipe the practice books and fill them again. Only ever called on the practice copy. */
export function resetPractice(money: Money): void {
  const db = money.db;
  db.exec("BEGIN");
  try {
    for (const table of ["tasks", "bank_line_payments", "bank_lines", "payments", "invoice_lines", "invoices", "clients", "events"]) db.exec(`DELETE FROM ${table}`);
    db.exec("UPDATE settings SET default_account_id = NULL");
    db.exec("DELETE FROM payment_accounts");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  seedPractice(money);
}

export function seedPractice(money: Money): void {
  const actor = "practice";
  const personal = money.createAccount({ label: "Personal", kind: "personal", bankName: "Practice Bank", accountName: "Practice Person", bsb: "000000", accountNumber: "11112222" }, actor);
  const business = money.createAccount({ label: "Business", kind: "business", bankName: "Practice Bank", accountName: "Practice Co", bsb: "000001", accountNumber: "33334444" }, actor);
  money.updateSettings({
    businessName: "Practice Co", abn: "51824753556", address: "1 Practice St, Exampleton QLD 4000", contactEmail: "practice@example.invalid",
    nextNumber: 501, defaultAccountId: business.id, footerNote: "This is a practice invoice. Nothing about it is real.",
  }, actor);
  const clients = CLIENTS.map((c, i) => money.createClient({ ...c, email: `accounts${i + 1}@example.invalid`, payToAccountId: i < 2 ? personal.id : business.id }, actor));

  const today = money.today();
  let n = 0;
  for (let back = 280; back >= 0; back -= 14) {
    const client = clients[n++ % clients.length];
    const d = money.createDraft({
      clientId: client.id, serviceFrom: addDays(today, -back - 13), serviceTo: addDays(today, -back),
      lines: [
        { description: "Support work: community access", quantity: 4 + (n % 3), unitCents: 6547 },
        { description: "Travel (km)", quantity: 20 + (n % 15), unitCents: 99 },
      ],
    }, actor);
    const inv = money.issue(d.id, { issueDate: addDays(today, -back) }, actor);
    // Most get paid about two weeks later; the recent ones, and every seventh, are still owed.
    if (back > 45 && n % 7 !== 3) {
      money.recordPayment({ invoiceId: inv.id, amountCents: inv.totalCents, receivedOn: addDays(today, -back + 12), matchedBy: "bank", evidence: "practice statement" }, actor);
    }
  }
  money.createDraft({ clientId: clients[1].id, lines: [{ description: "Support work: daily living", quantity: 3, unitCents: 6547 }] }, actor);
  // A couple of the operator's own tasks, so Flow has more than Money's work in it.
  const flow = new Flow(money);
  flow.add({ title: "Ring Harbour about next month's roster", context: "Pat Example asked for the November shifts by Friday." });
  flow.add({ title: "Renew the first-aid certificate", context: "It runs out at the end of the month. Book a course." });
}

/**
 * A made-up bank statement in the bank's own CSV shape (no header; date, amount, description,
 * balance) that pays some of the practice invoices, so the Bank page can be tried end to end.
 */
export function practiceStatement(money: Money): string {
  const owed = money.invoices({ status: "issued" }).filter((i) => i.balanceCents > 0);
  const lines: Array<[string, number, string]> = [];
  const today = money.today();
  owed.slice(0, 4).forEach((inv, i) => {
    const description = [
      `TRANSFER FROM ${inv.clientName.toUpperCase().split(" ")[0]} REF ${inv.number}`, // names the invoice: recorded
      `${inv.clientName.toUpperCase()} PAYMENT`, // amount and payer: recorded
      `DIRECT CREDIT ${551020 + i}`, // amount only: a suggestion
      `TRANSFER ${881200 + i}`,
    ][i];
    // Paid a few days after it was issued (never before, and never after today).
    const paidOn = [addDays(inv.issueDate!, 3 + i), today].sort()[0];
    lines.push([paidOn, inv.balanceCents, description]);
  });
  lines.push([addDays(today, -1), 120000, "SALARY FROM SOMEWHERE ELSE"]); // personal: dropped
  lines.push([today, -4210, "GROCERIES"]); // money out: skipped
  let balance = 900000;
  return lines
    .map(([date, cents, desc]) => {
      balance += cents;
      const ddmmyyyy = date.split("-").reverse().join("/");
      const amount = `${cents >= 0 ? "+" : "-"}${(Math.abs(cents) / 100).toFixed(2)}`;
      return [ddmmyyyy, amount, desc, `+${(balance / 100).toFixed(2)}`].map((c) => `"${c}"`).join(",");
    })
    .join("\r\n");
}
