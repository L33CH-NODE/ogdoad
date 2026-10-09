// Money's rules, in one place: settings, payment accounts, clients, invoices from draft to issued
// (or void), payments, ageing and the GST threshold meter. Every change leaves an event.
// Integer cents throughout; dates are ISO 'YYYY-MM-DD' in the business's timezone.

import { randomUUID } from "node:crypto";
import type { MoneyDb } from "./db.js";

export class MoneyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface Settings {
  businessName: string;
  abn: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  gstRegistered: boolean;
  numberPrefix: string;
  numberWidth: number;
  nextNumber: number;
  defaultTermsDays: number;
  defaultAccountId: string | null;
  timezone: string;
  footerNote: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  label: string;
  kind: "personal" | "business";
  bankName: string;
  accountName: string;
  bsb: string;
  accountNumber: string;
  archived: boolean;
}

export interface Client {
  id: string;
  name: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  participantName: string;
  ndisNumber: string;
  termsDays: number | null;
  payToAccountId: string | null;
  notes: string;
  source: "manual" | "agent" | "import";
  externalRef: string | null;
  archived: boolean;
}

export interface LineInput {
  description: string;
  quantity?: number;
  unitCents: number;
  serviceDate?: string | null;
}

export interface InvoiceLine extends Required<Omit<LineInput, "serviceDate">> {
  id: string;
  position: number;
  lineCents: number;
  serviceDate: string | null;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amountCents: number;
  receivedOn: string | null;
  accountId: string | null;
  matchedBy: "bank" | "import" | "manual";
  evidence: string;
}

export type Bucket = "draft" | "void" | "paid" | "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface InvoiceSummary {
  id: string;
  number: string | null;
  status: "draft" | "rejected" | "issued" | "void";
  clientId: string;
  clientName: string;
  issueDate: string | null;
  dueDate: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  daysOverdue: number | null;
  bucket: Bucket;
  source: "manual" | "agent" | "import";
}

export interface Invoice extends InvoiceSummary {
  termsDays: number;
  currency: string;
  notes: string;
  /** NDIS participant for this invoice; empty means the client's. */
  participantName: string;
  ndisNumber: string;
  payToAccountId: string | null;
  pdfPath: string | null;
  voidReason: string | null;
  lines: InvoiceLine[];
  payments: Payment[];
}

export interface DraftInput {
  clientId: string;
  lines: LineInput[];
  serviceFrom?: string | null;
  serviceTo?: string | null;
  notes?: string;
  termsDays?: number;
  payToAccountId?: string | null;
  participantName?: string;
  ndisNumber?: string;
}

export interface GstMeter {
  thresholdCents: number;
  windowStart: string;
  windowEnd: string;
  turnoverCents: number;
  percent: number;
  projectedCents: number;
  level: "ok" | "watch" | "near" | "over";
}

const GST_THRESHOLD_CENTS = 7_500_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// --- small helpers ---------------------------------------------------------------------------

export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** The ATO's ABN check: 11 digits; subtract 1 from the first, weight, and the sum divides by 89. */
export function isValidAbn(abn: string): boolean {
  const digits = abn.replace(/\s+/g, "");
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = [...digits].reduce((acc, ch, i) => acc + (Number(ch) - (i === 0 ? 1 : 0)) * weights[i], 0);
  return sum % 89 === 0;
}

export function formatNumber(prefix: string, width: number, n: number): string {
  return `${prefix}${String(n).padStart(width, "0")}`;
}

function bucketFor(status: InvoiceSummary["status"], balance: number, daysOverdue: number | null): Bucket {
  if (status === "draft" || status === "rejected") return "draft";
  if (status === "void") return "void";
  if (balance <= 0) return "paid";
  if (daysOverdue === null || daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

function requireDate(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new MoneyError("bad_date", `${field} must be a date like 2026-10-09.`);
  return value;
}

function requireLines(lines: LineInput[]): Array<Required<LineInput>> {
  if (!Array.isArray(lines) || !lines.length) throw new MoneyError("no_lines", "An invoice needs at least one line.");
  return lines.map((l, i) => {
    const description = String(l.description ?? "").trim();
    const quantity = l.quantity ?? 1;
    if (!description) throw new MoneyError("bad_line", `Line ${i + 1} needs a description.`);
    if (!(quantity > 0)) throw new MoneyError("bad_line", `Line ${i + 1} needs a quantity above zero.`);
    if (!Number.isInteger(l.unitCents) || l.unitCents < 0) throw new MoneyError("bad_line", `Line ${i + 1} needs a price in whole cents.`);
    return { description, quantity, unitCents: l.unitCents, serviceDate: requireDate(l.serviceDate, `Line ${i + 1}'s service date`) };
  });
}

const now = () => new Date().toISOString();

// --- the service -------------------------------------------------------------------------------

export class Money {
  /** Set while the vault is unlocked: seals issued PDFs at rest. */
  fileKey: Buffer | null = null;

  constructor(readonly db: MoneyDb) {}

  /** Run several statements as one: all of them happen, or none do. */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private event(actor: string, kind: string, subjectId: string | null, detail = ""): void {
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, ?, ?, ?, ?)").run(now(), actor, kind, subjectId, detail);
  }

  today(): string {
    return todayIn(this.settings().timezone);
  }

  // Settings -------------------------------------------------------------------------------------

  settings(): Settings {
    const r = this.db.prepare("SELECT * FROM settings WHERE id = 1").get() as any;
    return {
      businessName: r.business_name, abn: r.abn, contactEmail: r.contact_email, contactPhone: r.contact_phone, address: r.address,
      gstRegistered: !!r.gst_registered, numberPrefix: r.number_prefix, numberWidth: r.number_width, nextNumber: r.next_number,
      defaultTermsDays: r.default_terms_days, defaultAccountId: r.default_account_id, timezone: r.timezone, footerNote: r.footer_note, updatedAt: r.updated_at,
    };
  }

  updateSettings(patch: Partial<Omit<Settings, "updatedAt">>, actor: string): Settings {
    const cur = this.settings();
    const next = { ...cur, ...patch };
    if (patch.abn !== undefined && patch.abn.trim() && !isValidAbn(patch.abn)) throw new MoneyError("bad_abn", "That ABN doesn't pass the ATO check. Check the 11 digits.");
    if (!Number.isInteger(next.nextNumber) || next.nextNumber < 1) throw new MoneyError("bad_number", "The next invoice number must be a whole number above zero.");
    if (next.defaultAccountId && !this.account(next.defaultAccountId)) throw new MoneyError("no_account", "That default account doesn't exist.");
    try {
      todayIn(next.timezone);
    } catch {
      throw new MoneyError("bad_timezone", `"${next.timezone}" isn't a timezone.`);
    }
    this.db.prepare(`UPDATE settings SET business_name = ?, abn = ?, contact_email = ?, contact_phone = ?, address = ?, gst_registered = ?,
      number_prefix = ?, number_width = ?, next_number = ?, default_terms_days = ?, default_account_id = ?, timezone = ?, footer_note = ?, updated_at = ? WHERE id = 1`)
      .run(next.businessName.trim(), next.abn.replace(/\s+/g, ""), next.contactEmail.trim(), next.contactPhone.trim(), next.address.trim(), next.gstRegistered ? 1 : 0,
        next.numberPrefix, next.numberWidth, next.nextNumber, next.defaultTermsDays, next.defaultAccountId, next.timezone, next.footerNote, now());
    this.event(actor, "settings_updated", null, Object.keys(patch).sort().join(","));
    return this.settings();
  }

  // Payment accounts -----------------------------------------------------------------------------

  private toAccount(r: any): Account {
    return { id: r.id, label: r.label, kind: r.kind, bankName: r.bank_name, accountName: r.account_name, bsb: r.bsb, accountNumber: r.account_number, archived: !!r.archived };
  }

  accounts(includeArchived = false): Account[] {
    const rows = this.db.prepare(`SELECT * FROM payment_accounts ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY kind, label`).all();
    return rows.map((r) => this.toAccount(r));
  }

  account(id: string): Account | null {
    const r = this.db.prepare("SELECT * FROM payment_accounts WHERE id = ?").get(id);
    return r ? this.toAccount(r) : null;
  }

  createAccount(input: Omit<Account, "id" | "archived">, actor: string): Account {
    const bsb = input.bsb.replace(/[\s-]/g, "");
    const number = input.accountNumber.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(bsb)) throw new MoneyError("bad_bsb", "A BSB is 6 digits.");
    if (!/^\d{4,10}$/.test(number)) throw new MoneyError("bad_account_number", "An account number is 4 to 10 digits.");
    if (!input.label.trim() || !input.accountName.trim()) throw new MoneyError("bad_account", "An account needs a label and an account name.");
    if (input.kind !== "personal" && input.kind !== "business") throw new MoneyError("bad_account", "An account is personal or business.");
    const id = randomUUID();
    this.db.prepare("INSERT INTO payment_accounts (id, label, kind, bank_name, account_name, bsb, account_number, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .run(id, input.label.trim(), input.kind, input.bankName.trim(), input.accountName.trim(), bsb, number, now(), now());
    this.event(actor, "account_created", id, input.kind);
    return this.account(id)!;
  }

  archiveAccount(id: string, actor: string): void {
    if (!this.account(id)) throw new MoneyError("no_account", "No such account.");
    this.db.prepare("UPDATE payment_accounts SET archived = 1, updated_at = ? WHERE id = ?").run(now(), id);
    this.event(actor, "account_archived", id);
  }

  // Clients --------------------------------------------------------------------------------------

  private toClient(r: any): Client {
    return {
      id: r.id, name: r.name, contactName: r.contact_name, email: r.email, phone: r.phone, address: r.address,
      participantName: r.participant_name, ndisNumber: r.ndis_number, termsDays: r.terms_days, payToAccountId: r.pay_to_account_id,
      notes: r.notes, source: r.source, externalRef: r.external_ref, archived: !!r.archived,
    };
  }

  clients(includeArchived = false): Client[] {
    return this.db.prepare(`SELECT * FROM clients ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name COLLATE NOCASE`).all().map((r) => this.toClient(r));
  }

  client(id: string): Client | null {
    const r = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
    return r ? this.toClient(r) : null;
  }

  createClient(input: Partial<Client> & { name: string }, actor: string): Client {
    if (!input.name?.trim()) throw new MoneyError("bad_client", "A client needs a name.");
    // New clients are paid into the business account unless told otherwise.
    const payTo = input.payToAccountId ?? this.accounts().find((a) => a.kind === "business")?.id ?? null;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO clients (id, name, contact_name, email, phone, address, participant_name, ndis_number, terms_days, pay_to_account_id, notes, source, external_ref, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(id, input.name.trim(), input.contactName ?? "", input.email ?? "", input.phone ?? "", input.address ?? "", input.participantName ?? "", input.ndisNumber ?? "",
        input.termsDays ?? null, payTo, input.notes ?? "", input.source ?? "manual", input.externalRef ?? null, now(), now());
    this.event(actor, "client_created", id, input.source ?? "manual");
    return this.client(id)!;
  }

  updateClient(id: string, patch: Partial<Omit<Client, "id" | "source" | "externalRef">>, actor: string): Client {
    const cur = this.client(id);
    if (!cur) throw new MoneyError("no_client", "No such client.");
    const n = { ...cur, ...patch };
    if (!n.name.trim()) throw new MoneyError("bad_client", "A client needs a name.");
    if (n.payToAccountId && !this.account(n.payToAccountId)) throw new MoneyError("no_account", "That pay-to account doesn't exist.");
    this.db.prepare(`UPDATE clients SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, participant_name = ?, ndis_number = ?, terms_days = ?,
      pay_to_account_id = ?, notes = ?, archived = ?, updated_at = ? WHERE id = ?`)
      .run(n.name.trim(), n.contactName, n.email, n.phone, n.address, n.participantName, n.ndisNumber, n.termsDays, n.payToAccountId, n.notes, n.archived ? 1 : 0, now(), id);
    this.event(actor, "client_updated", id, Object.keys(patch).sort().join(","));
    return this.client(id)!;
  }

  // Invoices -------------------------------------------------------------------------------------

  private summaries(where = "", params: Array<string | number> = [], today = this.today()): InvoiceSummary[] {
    const rows = this.db.prepare(`
      SELECT i.*, c.name AS client_name, COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_cents
      FROM invoices i JOIN clients c ON c.id = i.client_id ${where}
      ORDER BY COALESCE(i.issue_date, i.created_at) DESC, i.number DESC`).all(...params) as any[];
    return rows.map((r) => {
      const balance = r.status === "issued" ? Math.max(0, r.total_cents - r.paid_cents) : 0;
      const daysOverdue = r.status === "issued" && r.due_date && balance > 0 ? daysBetween(r.due_date, today) : null;
      return {
        id: r.id, number: r.number, status: r.status, clientId: r.client_id, clientName: r.client_name, issueDate: r.issue_date, dueDate: r.due_date,
        serviceFrom: r.service_from, serviceTo: r.service_to, totalCents: r.total_cents, paidCents: r.paid_cents, balanceCents: balance,
        daysOverdue, bucket: bucketFor(r.status, balance, daysOverdue), source: r.source,
      };
    });
  }

  invoices(filter: { status?: string; clientId?: string } = {}): InvoiceSummary[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) clauses.push("i.status = ?"), params.push(filter.status);
    if (filter.clientId) clauses.push("i.client_id = ?"), params.push(filter.clientId);
    return this.summaries(clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params);
  }

  invoice(id: string): Invoice | null {
    const [summary] = this.summaries("WHERE i.id = ?", [id]);
    if (!summary) return null;
    const r = this.db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as any;
    const lines = (this.db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position").all(id) as any[]).map((l) => ({
      id: l.id, position: l.position, description: l.description, quantity: l.quantity, unitCents: l.unit_cents, lineCents: l.line_cents, serviceDate: l.service_date,
    }));
    const payments = (this.db.prepare("SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_on, created_at").all(id) as any[]).map((p) => ({
      id: p.id, invoiceId: p.invoice_id, amountCents: p.amount_cents, receivedOn: p.received_on, accountId: p.account_id, matchedBy: p.matched_by, evidence: p.evidence,
    }));
    return { ...summary, termsDays: r.terms_days, currency: r.currency, notes: r.notes, participantName: r.participant_name, ndisNumber: r.ndis_number, payToAccountId: r.pay_to_account_id, pdfPath: r.pdf_path, voidReason: r.void_reason, lines, payments };
  }

  private writeLines(invoiceId: string, lines: Array<Required<LineInput>>): number {
    this.db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").run(invoiceId);
    const insert = this.db.prepare("INSERT INTO invoice_lines (id, invoice_id, position, description, quantity, unit_cents, line_cents, service_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    let total = 0;
    lines.forEach((l, i) => {
      const lineCents = Math.round(l.quantity * l.unitCents);
      total += lineCents;
      insert.run(randomUUID(), invoiceId, i + 1, l.description, l.quantity, l.unitCents, lineCents, l.serviceDate);
    });
    return total;
  }

  createDraft(input: DraftInput, actor: string, opts: { source?: "manual" | "agent" | "import"; externalRef?: string } = {}): Invoice {
    const client = this.client(input.clientId);
    if (!client) throw new MoneyError("no_client", "No such client.");
    const lines = requireLines(input.lines);
    const terms = input.termsDays ?? client.termsDays ?? this.settings().defaultTermsDays;
    const id = randomUUID();
    this.tx(() => {
      this.db.prepare(`INSERT INTO invoices (id, client_id, status, terms_days, service_from, service_to, notes, participant_name, ndis_number, pay_to_account_id, source, external_ref, created_at, updated_at)
        VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, client.id, terms, requireDate(input.serviceFrom, "Service from"), requireDate(input.serviceTo, "Service to"), input.notes ?? "",
          input.participantName ?? "", input.ndisNumber ?? "", input.payToAccountId ?? null, opts.source ?? "manual", opts.externalRef ?? null, now(), now());
      const total = this.writeLines(id, lines);
      this.db.prepare("UPDATE invoices SET total_cents = ? WHERE id = ?").run(total, id);
      this.event(actor, "draft_created", id);
    });
    return this.invoice(id)!;
  }

  updateDraft(id: string, input: Partial<DraftInput>, actor: string): Invoice {
    const cur = this.invoice(id);
    if (!cur) throw new MoneyError("no_invoice", "No such invoice.");
    if (cur.status !== "draft") throw new MoneyError("not_draft", "Only drafts can be edited. Void an issued invoice and reissue it instead.");
    if (input.clientId && !this.client(input.clientId)) throw new MoneyError("no_client", "No such client.");
    this.tx(() => {
      this.db.prepare(`UPDATE invoices SET client_id = ?, terms_days = ?, service_from = ?, service_to = ?, notes = ?, pay_to_account_id = ?, participant_name = ?, ndis_number = ?, updated_at = ? WHERE id = ?`)
        .run(input.clientId ?? cur.clientId, input.termsDays ?? cur.termsDays,
          input.serviceFrom !== undefined ? requireDate(input.serviceFrom, "Service from") : cur.serviceFrom,
          input.serviceTo !== undefined ? requireDate(input.serviceTo, "Service to") : cur.serviceTo,
          input.notes ?? cur.notes, input.payToAccountId !== undefined ? input.payToAccountId : cur.payToAccountId,
          input.participantName ?? cur.participantName, input.ndisNumber ?? cur.ndisNumber, now(), id);
      if (input.lines) this.db.prepare("UPDATE invoices SET total_cents = ? WHERE id = ?").run(this.writeLines(id, requireLines(input.lines)), id);
      this.event(actor, "draft_updated", id);
    });
    return this.invoice(id)!;
  }

  rejectDraft(id: string, reason: string, actor: string): Invoice {
    const cur = this.invoice(id);
    if (!cur) throw new MoneyError("no_invoice", "No such invoice.");
    if (cur.status !== "draft") throw new MoneyError("not_draft", "Only a draft can be rejected.");
    this.db.prepare("UPDATE invoices SET status = 'rejected', notes = ?, updated_at = ? WHERE id = ?").run(reason ? `${cur.notes}\nRejected: ${reason}`.trim() : cur.notes, now(), id);
    this.event(actor, "draft_rejected", id, reason);
    return this.invoice(id)!;
  }

  /**
   * Issue a draft: it gets the next number, its dates and the account it's paid into, and from then
   * on it never changes. Requires a valid ABN (payers withhold 47% from invoices without one).
   */
  issue(id: string, opts: { issueDate?: string }, actor: string): Invoice {
    const s = this.settings();
    if (!isValidAbn(s.abn)) throw new MoneyError("no_abn", "Add a valid ABN in Money settings before issuing. Without one, payers withhold 47%.");
    if (!s.businessName.trim()) throw new MoneyError("no_business_name", "Add the business name in Money settings before issuing.");
    const cur = this.invoice(id);
    if (!cur) throw new MoneyError("no_invoice", "No such invoice.");
    if (cur.status !== "draft") throw new MoneyError("not_draft", "Only a draft can be issued.");
    if (cur.totalCents <= 0) throw new MoneyError("zero_total", "An invoice for nothing can't be issued.");
    const client = this.client(cur.clientId)!;
    const accountId = cur.payToAccountId ?? client.payToAccountId ?? s.defaultAccountId;
    const account = accountId ? this.account(accountId) : null;
    if (!account || account.archived) throw new MoneyError("no_account", "Choose the account this invoice is paid into (on the client, or a default in settings).");
    const issueDate = requireDate(opts.issueDate, "Issue date") ?? todayIn(s.timezone);
    return this.tx(() => {
      const fresh = this.settings();
      const number = formatNumber(fresh.numberPrefix, fresh.numberWidth, fresh.nextNumber);
      if (this.db.prepare("SELECT 1 FROM invoices WHERE number = ?").get(number)) throw new MoneyError("number_taken", `Invoice number ${number} is already used. Raise the next number in settings.`);
      this.db.prepare("UPDATE invoices SET status = 'issued', number = ?, issue_date = ?, due_date = ?, pay_to_account_id = ?, updated_at = ? WHERE id = ?")
        .run(number, issueDate, addDays(issueDate, cur.termsDays), account.id, now(), id);
      this.db.prepare("UPDATE settings SET next_number = next_number + 1, updated_at = ? WHERE id = 1").run(now());
      this.event(actor, "invoice_issued", id, number);
      return this.invoice(id)!;
    });
  }

  voidInvoice(id: string, reason: string, actor: string): Invoice {
    const cur = this.invoice(id);
    if (!cur) throw new MoneyError("no_invoice", "No such invoice.");
    if (cur.status !== "issued") throw new MoneyError("not_issued", "Only an issued invoice can be voided.");
    if (cur.paidCents > 0) throw new MoneyError("has_payments", "This invoice has payments against it. Sort those out first (refund, or move them), then void it.");
    if (!reason.trim()) throw new MoneyError("no_reason", "Say why it's being voided; it stays on the record.");
    this.db.prepare("UPDATE invoices SET status = 'void', void_reason = ?, updated_at = ? WHERE id = ?").run(reason.trim(), now(), id);
    this.event(actor, "invoice_voided", id, reason.trim());
    return this.invoice(id)!;
  }

  setPdfPath(id: string, path: string): void {
    this.db.prepare("UPDATE invoices SET pdf_path = ?, updated_at = ? WHERE id = ?").run(path, now(), id);
  }

  // Payments -------------------------------------------------------------------------------------

  recordPayment(input: { invoiceId: string; amountCents: number; receivedOn?: string | null; accountId?: string | null; matchedBy: Payment["matchedBy"]; evidence?: string; externalRef?: string }, actor: string): Payment {
    const inv = this.invoice(input.invoiceId);
    if (!inv) throw new MoneyError("no_invoice", "No such invoice.");
    if (inv.status !== "issued") throw new MoneyError("not_issued", "Payments go against issued invoices.");
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new MoneyError("bad_amount", "A payment is a whole number of cents above zero.");
    const id = randomUUID();
    this.db.prepare("INSERT INTO payments (id, invoice_id, amount_cents, received_on, account_id, matched_by, evidence, external_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, inv.id, input.amountCents, requireDate(input.receivedOn, "Received on"), input.accountId ?? inv.payToAccountId, input.matchedBy, input.evidence ?? "", input.externalRef ?? null, now());
    this.event(actor, "payment_recorded", inv.id, `${input.amountCents} ${input.matchedBy}`);
    return this.invoice(inv.id)!.payments.find((p) => p.id === id)!;
  }

  // Overview -------------------------------------------------------------------------------------

  /** What's owed, by how late it is. */
  ageing(): Record<Exclude<Bucket, "draft" | "void" | "paid">, { count: number; cents: number }> {
    const out = { current: { count: 0, cents: 0 }, "1-30": { count: 0, cents: 0 }, "31-60": { count: 0, cents: 0 }, "61-90": { count: 0, cents: 0 }, "90+": { count: 0, cents: 0 } };
    for (const inv of this.invoices({ status: "issued" })) {
      if (inv.bucket === "paid" || inv.bucket === "draft" || inv.bucket === "void") continue;
      out[inv.bucket].count += 1;
      out[inv.bucket].cents += inv.balanceCents;
    }
    return out;
  }

  /**
   * GST turnover: supplies made in the current month and the previous 11 (GST-free NDIS income
   * counts), dated by service (falling back to issue). Projected: the last three full months' pace
   * over a year. Check the ATO's definition before relying on it.
   */
  gstMeter(today = this.today()): GstMeter {
    const [y, m] = today.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1 - 11, 1)).toISOString().slice(0, 10);
    const sumBetween = (from: string, to: string) =>
      (this.db.prepare(`SELECT COALESCE(SUM(total_cents), 0) AS cents FROM invoices
        WHERE status = 'issued' AND COALESCE(service_to, service_from, issue_date) BETWEEN ? AND ?`).get(from, to) as { cents: number }).cents;
    const turnover = sumBetween(start, today);
    const threeMonthsStart = new Date(Date.UTC(y, m - 1 - 3, 1)).toISOString().slice(0, 10);
    const lastMonthEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const projected = Math.round((sumBetween(threeMonthsStart, lastMonthEnd) / 3) * 12);
    const percent = Math.round((turnover / GST_THRESHOLD_CENTS) * 1000) / 10;
    const worst = Math.max(turnover, projected) / GST_THRESHOLD_CENTS;
    const level = worst >= 1 ? "over" : worst >= 0.9 ? "near" : worst >= 0.75 ? "watch" : "ok";
    return { thresholdCents: GST_THRESHOLD_CENTS, windowStart: start, windowEnd: today, turnoverCents: turnover, percent, projectedCents: projected, level };
  }

  events(subjectId?: string, limit = 100): Array<{ at: string; actor: string; kind: string; subjectId: string | null; detail: string }> {
    const rows = subjectId
      ? this.db.prepare("SELECT * FROM events WHERE subject_id = ? ORDER BY id DESC LIMIT ?").all(subjectId, limit)
      : this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as any[]).map((r) => ({ at: r.at, actor: r.actor, kind: r.kind, subjectId: r.subject_id, detail: r.detail }));
  }
}
