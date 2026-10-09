// Importing the previous system, on synthetic files shaped like the real export and tracker.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCsv } from "../money/csv.js";
import { openMoneyDb } from "../money/db.js";
import { dollarsToCents, importPreviousSystem } from "../money/import.js";
import { Money } from "../money/service.js";

// The export's real column labels (53 columns, one row per invoice, no line items).
const HEADER = ["Invoice ID", "Invoice Number", "Client Number", "Invoice Date", "Issue Date", "Payment Status", "Currency", "Client Business Name", "Client First Name",
  "Client Last Name", "Client Full Name", "Client Email", "Client Phone1", "Client Phone2", "Client Line Address1", "Client Line Address2", "Client Postal Code",
  "Client City", "Client State", "Client Full Address", "Client Country Code", "Client Shipping Name", "Client Full Shipping Address", "Client Shipping Country Code",
  "Client Shipping Address1", "Client Shipping Address2", "Client Shipping City", "Client Shipping State", "Client Shipping Postal Code", "Staff Member ID",
  "Staff Member Name", "Is Draft", "Discount Precentage", "DepositDeposit", "Payment Terms", "Subtotal", "Discount", "Discount Amount", "Shipping Fees", "Total",
  "Total Paid", "Balance Due", "From Date", "To Date", "Created", "Modified", "Address", "NDIS number", "Client", "Address", "Name", "Date of service", "NDIS"];

function exportRow(v: Record<string, string>): string {
  return HEADER.map((h) => {
    const s = v[h] ?? "";
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
}

const EXPORT = [
  HEADER.join(","),
  exportRow({ "Invoice ID": "1", "Invoice Number": "00001", "Client Number": "1", "Invoice Date": "2025-03-01", "Issue Date": "2025-03-01", "Payment Status": "Unpaid", Currency: "AUD", "Client Business Name": "Sample Plan Managers", "Client Full Name": "Pat Example", "Client Email": "accounts@example.invalid", "Client Full Address": "1 Sample St, Exampleton", Total: "650", "Total Paid": "0", Modified: "2025-03-01 10:00:00", Client: "Participant A", "NDIS number": "430000000" }),
  exportRow({ "Invoice ID": "2", "Invoice Number": "00002", "Client Number": "1", "Invoice Date": "2025-03-15", "Issue Date": "2025-03-15", "Payment Status": "Paid", Currency: "AUD", "Client Business Name": "Sample Plan Managers, Pty Ltd", "Client Full Name": "Pat Example", Total: "1300.50", "Total Paid": "1300.50", Modified: "2025-04-01 09:00:00", "Date of service": "05/03/25" }),
  exportRow({ "Invoice ID": "3", "Invoice Number": "00003", "Client Number": "2", "Invoice Date": "2025-04-01", "Issue Date": "2025-04-01", "Payment Status": "Unpaid", Currency: "AUD", "Client Full Name": "Sam Sample", Total: "975", "Total Paid": "0", Modified: "2025-04-01 09:00:00" }),
].join("\r\n");

const TRACKER = [
  "client,invoice no,issue date,\"due date (issue+14d, payment terms in email)\",amount AUD,paid AUD,balance AUD,days past due,ageing bucket,match method,email evidence (Gmail),next chase step,chase history",
  "Sample Plan Managers,00001,2025-03-01,2025-03-15,650.00,650.00,0.00,n/a - paid,n/a - paid,statement: matched by amount and date (2025-03-20 A$650.00),,,",
  "Sam Sample,00003,2025-04-01,2025-04-15,975.00,0.00,975.00,100,90+,,,first reminder,",
].join("\n");

function setup() {
  const money = new Money(openMoneyDb(":memory:"));
  money.createAccount({ label: "Personal", kind: "personal", bankName: "Sample Bank", accountName: "Sample Person", bsb: "000000", accountNumber: "12345678" }, "operator");
  return money;
}

test("the CSV reader handles quotes, doubled quotes, commas and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n'), [["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
  assert.equal(dollarsToCents("1,300.50"), 130050);
  assert.equal(dollarsToCents("A$99"), 9900);
});

test("importing builds clients, issued invoices and payments, with the tracker winning", () => {
  const money = setup();
  const s = importPreviousSystem(money, { invoicesCsv: EXPORT, trackerCsv: TRACKER });
  assert.deepEqual(s.clients, { created: 2, updated: 0 });
  assert.deepEqual(s.invoices, { created: 3, updated: 0, drafts: 0 });
  assert.equal(s.numbers.highest, "00003");
  assert.equal(s.numbers.nextNumber, 4, "numbering continues after the highest imported");
  assert.equal(money.settings().nextNumber, 4);
  assert.match(s.warnings.join(" "), /read day-first/);

  const byNumber = new Map(money.invoices().map((i) => [i.number, i]));
  // 00001: the export says unpaid, the tracker found the bank payment.
  assert.equal(byNumber.get("00001")!.bucket, "paid");
  const first = money.invoice(byNumber.get("00001")!.id)!;
  assert.equal(first.payments[0].receivedOn, "2025-03-20", "the bank match's date becomes the payment date");
  assert.equal(first.participantName, "Participant A");
  assert.equal(first.dueDate, "2025-03-15", "issue + 14 days");
  // 00002: not in the tracker, so the export's total paid is used.
  assert.equal(byNumber.get("00002")!.paidCents, 130050);
  assert.equal(money.invoice(byNumber.get("00002")!.id)!.serviceFrom, "2025-03-05");
  // 00003: unpaid and overdue.
  assert.equal(byNumber.get("00003")!.balanceCents, 97500);

  const client = money.clients().find((c) => c.name.startsWith("Sample Plan Managers"))!;
  assert.equal(client.name, "Sample Plan Managers, Pty Ltd", "client details come from the latest invoice");
  assert.equal(client.contactName, "Pat Example");
  assert.equal(client.payToAccountId, money.accounts()[0].id, "existing clients stay on the personal account");
});

test("importing again updates in place instead of duplicating", () => {
  const money = setup();
  importPreviousSystem(money, { invoicesCsv: EXPORT, trackerCsv: TRACKER });
  const again = importPreviousSystem(money, { invoicesCsv: EXPORT, trackerCsv: TRACKER });
  assert.deepEqual(again.clients, { created: 0, updated: 2 });
  assert.deepEqual(again.invoices, { created: 0, updated: 3, drafts: 0 });
  assert.equal(money.invoices().length, 3);
  assert.equal(money.db.prepare("SELECT COUNT(*) AS n FROM payments").get()!.n, 2);
});

test("a file that isn't the export is refused", () => {
  assert.throws(() => importPreviousSystem(setup(), { invoicesCsv: "date,amount\n2025-01-01,5\n" }), /Invoice Number/);
});
