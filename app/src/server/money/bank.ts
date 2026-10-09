// Money in: read a bank statement, match each credit to the invoice it pays, and record the payment.
// Paid status comes from money actually received. Only sure matches are recorded on their own;
// anything less is a suggestion for the operator to confirm. From the personal account, lines that
// pay no invoice are dropped and never stored.

import { createHash, randomUUID } from "node:crypto";

import { parseCsv } from "./csv.js";
import { daysBetween, MoneyError, type Money } from "./service.js";

export interface BankRow {
  postedOn: string;
  amountCents: number;
  description: string;
  balanceCents: number | null;
}

/** The bank's CSV: no header row; date (dd/mm/yyyy), signed amount, description, running balance. */
export function parseBankCsv(text: string): { rows: BankRow[]; unreadable: number } {
  const rows: BankRow[] = [];
  let unreadable = 0;
  for (const r of parseCsv(text)) {
    const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((r[0] ?? "").trim());
    const amount = Number((r[1] ?? "").replace(/[^0-9.+-]/g, ""));
    if (!date || !Number.isFinite(amount) || (r[1] ?? "").trim() === "") {
      unreadable++; // a header row, a total line, or something else that isn't a transaction
      continue;
    }
    const balance = Number((r[3] ?? "").replace(/[^0-9.+-]/g, ""));
    rows.push({
      postedOn: `${date[3]}-${date[2].padStart(2, "0")}-${date[1].padStart(2, "0")}`,
      amountCents: Math.round(amount * 100),
      description: (r[2] ?? "").trim(),
      balanceCents: (r[3] ?? "").trim() && Number.isFinite(balance) ? Math.round(balance * 100) : null,
    });
  }
  return { rows, unreadable };
}

export interface OpenInvoice {
  id: string;
  number: string;
  clientId: string;
  clientName: string;
  issueDate: string;
  totalCents: number;
  balanceCents: number;
}

export interface KnownPayment {
  id: string;
  invoiceId: string;
  amountCents: number;
  receivedOn: string | null;
}

export type Match =
  | { kind: "certain"; invoiceIds: string[]; reason: string }
  | { kind: "suggested"; groups: string[][]; reason: string }
  | { kind: "recorded"; paymentIds: string[]; reason: string }
  | { kind: "paid_twice"; invoiceIds: string[]; reason: string }
  | { kind: "none" };

// Words in client names that say nothing about who paid.
const GENERIC = new Set(["PTY", "LTD", "LIMITED", "GROUP", "SERVICES", "SERVICE", "SUPPORT", "SUPPORTS", "THE", "AND", "PLAN", "PLANS", "MANAGEMENT", "MANAGERS", "MANAGER", "PARTNERS", "CARE", "AUSTRALIA", "TRUST", "TRUSTEE", "FOR", "INC"]);

export function nameTokens(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !GENERIC.has(w));
}

function mentionsNumber(description: string, number: string): boolean {
  const digits = number.replace(/\D/g, "");
  if (!digits) return false;
  const bare = String(Number(digits));
  const d = description.toUpperCase();
  return new RegExp(`(^|[^0-9])${digits}([^0-9]|$)`).test(d) || new RegExp(`(INV|INVOICE|#)\\s*0*${bare}([^0-9]|$)`).test(d);
}

/** Sets of 2 to 6 of one client's open invoices whose balances add up to exactly the amount. */
function subsetsSumming(invoices: OpenInvoice[], target: number, limit = 3): string[][] {
  const out: string[][] = [];
  const list = invoices.slice(0, 14);
  const walk = (start: number, sum: number, picked: OpenInvoice[]) => {
    if (out.length >= limit) return;
    if (sum === target && picked.length >= 2) return void out.push(picked.map((i) => i.id));
    if (sum >= target || picked.length >= 6) return;
    for (let i = start; i < list.length; i++) walk(i + 1, sum + list[i].balanceCents, [...picked, list[i]]);
  };
  walk(0, 0, []);
  return out;
}

/**
 * Decide what one credit is. In order: already recorded (the same amount was recorded within a few
 * days, e.g. by the import), an invoice number in the description, a unique invoice for exactly that
 * amount (sure only when the payer's name agrees), several invoices from one payer that add up, or a
 * second payment of an invoice that's already paid.
 */
export function matchCredit(row: BankRow, open: OpenInvoice[], paid: OpenInvoice[], unlinked: KnownPayment[]): Match {
  const near = unlinked.filter((p) => p.amountCents === row.amountCents && p.receivedOn && Math.abs(daysBetween(p.receivedOn, row.postedOn)) <= 3);
  if (near.length === 1) return { kind: "recorded", paymentIds: [near[0].id], reason: "already recorded as a payment" };

  const eligible = open.filter((i) => i.issueDate <= row.postedOn && daysBetween(i.issueDate, row.postedOn) <= 365);
  const desc = row.description.toUpperCase();
  const payerHit = (clientName: string) => nameTokens(clientName).some((t) => desc.includes(t));

  const byNumber = eligible.filter((i) => mentionsNumber(row.description, i.number));
  if (byNumber.length === 1) {
    const inv = byNumber[0];
    if (row.amountCents <= inv.balanceCents) return { kind: "certain", invoiceIds: [inv.id], reason: `the description names invoice ${inv.number}` };
    return { kind: "suggested", groups: [[inv.id]], reason: `names invoice ${inv.number}, but pays more than it owes` };
  }

  const exact = eligible.filter((i) => i.balanceCents === row.amountCents);
  const exactNamed = exact.filter((i) => payerHit(i.clientName));
  if (exactNamed.length === 1) return { kind: "certain", invoiceIds: [exactNamed[0].id], reason: `amount and payer match invoice ${exactNamed[0].number}` };

  const groups: string[][] = [...exactNamed, ...exact.filter((i) => !exactNamed.includes(i))].map((i) => [i.id]);
  const clients = new Map<string, OpenInvoice[]>();
  for (const i of eligible) clients.set(i.clientId, [...(clients.get(i.clientId) ?? []), i]);
  for (const list of clients.values()) {
    if (!payerHit(list[0].clientName) && exactNamed.length) continue;
    for (const g of subsetsSumming(list.sort((a, b) => a.issueDate.localeCompare(b.issueDate)), row.amountCents)) groups.push(g);
  }
  if (groups.length) {
    const reason = exact.length === 1 && groups.length === 1 ? "the amount matches one invoice, but the payer's name doesn't show" : `${groups.length} possible matches`;
    return { kind: "suggested", groups: groups.slice(0, 6), reason };
  }

  const twice = paid.filter((i) => i.totalCents === row.amountCents && payerHit(i.clientName) && i.issueDate <= row.postedOn);
  if (twice.length) return { kind: "paid_twice", invoiceIds: twice.map((i) => i.id), reason: `looks like a second payment of invoice ${twice.map((i) => i.number).join(" or ")}` };
  return { kind: "none" };
}

export interface BankImportSummary {
  account: string;
  lines: number;
  credits: number;
  debitsSkipped: number;
  unreadable: number;
  alreadyImported: number;
  matched: number;
  alreadyRecorded: number;
  suggested: number;
  paidTwice: number;
  unmatched: number;
  personalDropped: number;
}

export function importStatement(money: Money, input: { accountId: string; csv: string }, actor: string): BankImportSummary {
  const account = money.account(input.accountId);
  if (!account) throw new MoneyError("no_account", "Choose which account the statement is from.");
  const { rows, unreadable } = parseBankCsv(input.csv);
  if (!rows.length) throw new MoneyError("no_rows", "No transactions found. Is that the bank's CSV export?");
  const db = money.db;
  const s: BankImportSummary = { account: account.label, lines: rows.length, credits: 0, debitsSkipped: 0, unreadable, alreadyImported: 0, matched: 0, alreadyRecorded: 0, suggested: 0, paidTwice: 0, unmatched: 0, personalDropped: 0 };
  const now = new Date().toISOString();

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      if (row.amountCents <= 0) {
        s.debitsSkipped++; // money out isn't matched to invoices (the accountant pack reads expenses later)
        continue;
      }
      s.credits++;
      const fingerprint = createHash("sha256").update([account.id, row.postedOn, row.amountCents, row.description, row.balanceCents ?? ""].join("|")).digest("hex");
      if (db.prepare("SELECT 1 FROM bank_lines WHERE fingerprint = ?").get(fingerprint)) {
        s.alreadyImported++;
        continue;
      }
      // Fresh state for every line: an earlier line in this statement may have paid something.
      const all = money.invoices({ status: "issued" });
      const asOpen = (i: (typeof all)[number]): OpenInvoice => ({ id: i.id, number: i.number ?? "", clientId: i.clientId, clientName: i.clientName, issueDate: i.issueDate ?? "", totalCents: i.totalCents, balanceCents: i.balanceCents });
      const open = all.filter((i) => i.balanceCents > 0).map(asOpen);
      const paid = all.filter((i) => i.balanceCents === 0).map(asOpen);
      const unlinked = db.prepare(`SELECT id, invoice_id, amount_cents, received_on FROM payments p
        WHERE NOT EXISTS (SELECT 1 FROM bank_line_payments b WHERE b.payment_id = p.id)`).all().map((p: any) => ({ id: p.id, invoiceId: p.invoice_id, amountCents: p.amount_cents, receivedOn: p.received_on }));
      const m = matchCredit(row, open, paid, unlinked);

      if (m.kind === "none" && account.kind === "personal") {
        s.personalDropped++; // personal money that pays no invoice is none of the books' business
        continue;
      }
      const lineId = randomUUID();
      const status = m.kind === "certain" || m.kind === "recorded" ? "matched" : m.kind === "suggested" ? "suggested" : "unmatched";
      const candidates = m.kind === "suggested" ? m.groups : m.kind === "paid_twice" ? [m.invoiceIds] : [];
      db.prepare("INSERT INTO bank_lines (id, account_id, posted_on, amount_cents, description, fingerprint, status, candidates, reason, flag, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(lineId, account.id, row.postedOn, row.amountCents, row.description, fingerprint, status, JSON.stringify(candidates), m.kind === "none" ? "" : m.reason, m.kind === "paid_twice" ? "paid_twice" : "", now);

      if (m.kind === "certain") {
        payAcross(money, lineId, m.invoiceIds, row, account.id, actor);
        s.matched++;
      } else if (m.kind === "recorded") {
        for (const pid of m.paymentIds) db.prepare("INSERT INTO bank_line_payments (bank_line_id, payment_id) VALUES (?, ?)").run(lineId, pid);
        s.alreadyRecorded++;
      } else if (m.kind === "suggested") s.suggested++;
      else if (m.kind === "paid_twice") s.paidTwice++;
      else s.unmatched++;
    }
    db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, ?, 'bank_imported', ?, ?)").run(now, actor, account.id, `${s.credits} credits, ${s.matched} matched, ${s.suggested} to review`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return s;
}

/** Spread one credit over invoices, oldest first, each up to what it owes; record each as a bank payment. */
function payAcross(money: Money, lineId: string, invoiceIds: string[], row: BankRow, accountId: string, actor: string): void {
  let left = row.amountCents;
  const invoices = invoiceIds.map((id) => money.invoice(id)!).sort((a, b) => (a.issueDate ?? "").localeCompare(b.issueDate ?? ""));
  invoices.forEach((inv, i) => {
    const last = i === invoices.length - 1;
    const part = last ? left : Math.min(left, inv.balanceCents);
    if (part <= 0) return;
    left -= part;
    const p = money.recordPayment({ invoiceId: inv.id, amountCents: part, receivedOn: row.postedOn, accountId, matchedBy: "bank", evidence: `bank ${row.postedOn}: ${row.description.slice(0, 60)}` }, actor);
    money.db.prepare("INSERT INTO bank_line_payments (bank_line_id, payment_id) VALUES (?, ?)").run(lineId, p.id);
  });
}

export interface ReviewLine {
  id: string;
  accountLabel: string;
  postedOn: string;
  amountCents: number;
  description: string;
  status: "suggested" | "unmatched";
  reason: string;
  flag: string;
  groups: Array<Array<{ id: string; number: string | null; clientName: string; balanceCents: number; totalCents: number }>>;
}

/** Lines waiting on the operator: suggestions to confirm, and business income nothing explains. */
export function reviewLines(money: Money): ReviewLine[] {
  const rows = money.db.prepare(`SELECT l.*, a.label AS account_label FROM bank_lines l JOIN payment_accounts a ON a.id = l.account_id
    WHERE l.status IN ('suggested', 'unmatched') ORDER BY l.posted_on DESC`).all() as any[];
  return rows.map((r) => ({
    id: r.id, accountLabel: r.account_label, postedOn: r.posted_on, amountCents: r.amount_cents, description: r.description, status: r.status, reason: r.reason, flag: r.flag,
    groups: (JSON.parse(r.candidates) as string[][]).map((g) => g.map((id) => {
      const inv = money.invoice(id)!;
      return { id, number: inv.number, clientName: inv.clientName, balanceCents: inv.balanceCents, totalCents: inv.totalCents };
    })),
  }));
}

/** The operator confirms which invoice(s) a line pays. */
export function confirmLine(money: Money, lineId: string, invoiceIds: string[], actor: string): void {
  const line = money.db.prepare("SELECT * FROM bank_lines WHERE id = ?").get(lineId) as any;
  if (!line) throw new MoneyError("no_line", "No such bank line.");
  if (line.status === "matched") throw new MoneyError("already_matched", "That line is already matched.");
  if (!invoiceIds.length) throw new MoneyError("no_invoices", "Choose the invoice(s) this payment is for.");
  const owing = invoiceIds.reduce((sum, id) => {
    const inv = money.invoice(id);
    if (!inv || inv.status !== "issued") throw new MoneyError("no_invoice", "One of those invoices isn't an issued invoice.");
    return sum + inv.balanceCents;
  }, 0);
  if (invoiceIds.length > 1 && owing !== line.amount_cents) throw new MoneyError("doesnt_add_up", `Those invoices owe ${owing / 100} but the payment is ${line.amount_cents / 100}.`);
  money.db.exec("BEGIN");
  try {
    payAcross(money, lineId, invoiceIds, { postedOn: line.posted_on, amountCents: line.amount_cents, description: line.description, balanceCents: null }, line.account_id, actor);
    money.db.prepare("UPDATE bank_lines SET status = 'matched', reason = 'confirmed by the operator' WHERE id = ?").run(lineId);
    money.db.exec("COMMIT");
  } catch (err) {
    money.db.exec("ROLLBACK");
    throw err;
  }
}

export function ignoreLine(money: Money, lineId: string, actor: string): void {
  const r = money.db.prepare("UPDATE bank_lines SET status = 'ignored' WHERE id = ? AND status != 'matched'").run(lineId);
  if (!r.changes) throw new MoneyError("no_line", "No such unmatched line.");
  money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, ?, 'bank_line_ignored', ?, '')").run(new Date().toISOString(), actor, lineId);
}
