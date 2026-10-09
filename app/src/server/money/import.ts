// Import the previous invoicing system: its invoice export (one row per invoice, no line items)
// and, optionally, the reconciliation tracker built from bank matches (whose paid amounts win over
// the export's payment status). Both files are read where they are; nothing is copied elsewhere.
// Repeatable: every record carries an external ref, so running it again updates in place.
// The summary reports counts only, never names or amounts per client.

import { randomUUID } from "node:crypto";

import { csvRecords } from "./csv.js";
import { addDays, formatNumber, type Money } from "./service.js";

export interface ImportSummary {
  clients: { created: number; updated: number };
  invoices: { created: number; updated: number; drafts: number };
  payments: { created: number; updated: number; fromTracker: number; fromExport: number };
  numbers: { lowest: string | null; highest: string | null; nextNumber: number };
  warnings: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}/;

/** Dollars as written in the exports ("1234.5", "$1,234.50", "A$99") to whole cents. */
export function dollarsToCents(value: string): number {
  const cleaned = value.replace(/[^0-9.-]/g, "");
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`not an amount: ${JSON.stringify(value.slice(0, 20))}`);
  return Math.round(n * 100);
}

/** ISO dates pass through; d/m/yy and d/m/yyyy are read day-first (Australian), flagged by the caller. */
function toIsoDate(value: string): { date: string | null; dayFirstGuess: boolean } {
  const v = value.trim();
  if (!v) return { date: null, dayFirstGuess: false };
  if (ISO.test(v)) return { date: v.slice(0, 10), dayFirstGuess: false };
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(v);
  if (!m) return { date: null, dayFirstGuess: false };
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const date = `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return { date: Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date, dayFirstGuess: true };
}

export function importPreviousSystem(money: Money, files: { invoicesCsv: string; trackerCsv?: string }, actor = "import"): ImportSummary {
  const db = money.db;
  const settings = money.settings();
  const summary: ImportSummary = {
    clients: { created: 0, updated: 0 },
    invoices: { created: 0, updated: 0, drafts: 0 },
    payments: { created: 0, updated: 0, fromTracker: 0, fromExport: 0 },
    numbers: { lowest: null, highest: null, nextNumber: settings.nextNumber },
    warnings: [],
  };
  const now = new Date().toISOString();
  const rows = csvRecords(files.invoicesCsv);
  if (!rows.length || !rows[0].get("Invoice Number")) throw new Error("That doesn't look like the invoicing site's export (no \"Invoice Number\" column).");

  // The tracker, keyed by invoice number: paid amount and how it was matched.
  const tracked = new Map<string, { paidCents: number; method: string; receivedOn: string | null }>();
  if (files.trackerCsv) {
    for (const t of csvRecords(files.trackerCsv)) {
      const number = t.get("invoice no");
      if (!number) continue;
      const method = t.get("match method");
      tracked.set(number, { paidCents: dollarsToCents(t.get("paid AUD")), method, receivedOn: /(\d{4}-\d{2}-\d{2})/.exec(method)?.[1] ?? null });
    }
  }

  // Clients come from the most recently modified invoice for each client number.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = r.get("Client Number");
    const prev = latest.get(key);
    if (!prev || r.get("Modified") > prev.get("Modified")) latest.set(key, r);
  }

  db.exec("BEGIN");
  try {
    const clientIds = new Map<string, string>();
    for (const [clientNumber, r] of latest) {
      const ref = `previous-system:client:${clientNumber}`;
      const business = r.get("Client Business Name");
      const full = r.get("Client Full Name") || [r.get("Client First Name"), r.get("Client Last Name")].filter(Boolean).join(" ");
      const fields = {
        name: business || full || `Client ${clientNumber}`,
        contact_name: business ? full : "",
        email: r.get("Client Email"),
        phone: r.get("Client Phone1") || r.get("Client Phone2"),
        address: r.get("Client Full Address"),
      };
      const existing = db.prepare("SELECT id FROM clients WHERE external_ref = ?").get(ref) as { id: string } | undefined;
      if (existing) {
        db.prepare("UPDATE clients SET name = ?, contact_name = ?, email = ?, phone = ?, address = ?, updated_at = ? WHERE id = ?")
          .run(fields.name, fields.contact_name, fields.email, fields.phone, fields.address, now, existing.id);
        clientIds.set(clientNumber, existing.id);
        summary.clients.updated++;
      } else {
        // Existing clients stay on the personal account they've always paid into.
        const personal = money.accounts().find((a) => a.kind === "personal")?.id ?? null;
        const id = randomUUID();
        db.prepare(`INSERT INTO clients (id, name, contact_name, email, phone, address, pay_to_account_id, source, external_ref, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`)
          .run(id, fields.name, fields.contact_name, fields.email, fields.phone, fields.address, personal, ref, now, now);
        clientIds.set(clientNumber, id);
        summary.clients.created++;
      }
    }

    let highest = 0;
    let lowest = Infinity;
    let dayFirstGuesses = 0;
    for (const r of rows) {
      const ref = `previous-system:invoice:${r.get("Invoice ID")}`;
      const rawNumber = r.get("Invoice Number");
      const numeric = Number(rawNumber.replace(/\D/g, ""));
      // Imported numbers keep exactly the form they were issued with; a prefix set later never rewrites history.
      const number = rawNumber;
      const isDraft = r.get("Is Draft") === "1";
      const issueDate = toIsoDate(r.get("Invoice Date") || r.get("Issue Date")).date;
      const terms = Number(r.get("Payment Terms")) || settings.defaultTermsDays;
      const totalCents = dollarsToCents(r.get("Total"));
      const from = toIsoDate(r.get("From Date"));
      const to = toIsoDate(r.get("To Date"));
      const single = toIsoDate(r.get("Date of service"));
      if (from.dayFirstGuess || to.dayFirstGuess || single.dayFirstGuess) dayFirstGuesses++;
      const serviceFrom = from.date ?? single.date;
      const serviceTo = to.date ?? single.date;
      const participant = r.get("Client") || r.get("Name");
      const ndis = r.get("NDIS number") || r.get("NDIS");
      const status = isDraft ? "draft" : "issued";
      if (isDraft) summary.invoices.drafts++;
      if (!isDraft && !issueDate) {
        summary.warnings.push(`An invoice (row with number ${number}) has no date; it was imported as a draft.`);
      }
      const finalStatus = !isDraft && !issueDate ? "draft" : status;
      const values = {
        client_id: clientIds.get(r.get("Client Number"))!,
        status: finalStatus,
        number: finalStatus === "issued" ? number : null,
        issue_date: finalStatus === "issued" ? issueDate : null,
        due_date: finalStatus === "issued" && issueDate ? addDays(issueDate, terms) : null,
        service_from: serviceFrom,
        service_to: serviceTo,
        terms_days: terms,
        currency: r.get("Currency") || "AUD",
        total_cents: totalCents,
        participant_name: participant,
        ndis_number: ndis,
      };

      let invoiceId: string;
      const existing = db.prepare("SELECT id FROM invoices WHERE external_ref = ?").get(ref) as { id: string } | undefined;
      if (existing) {
        invoiceId = existing.id;
        db.prepare(`UPDATE invoices SET client_id = ?, status = ?, number = ?, issue_date = ?, due_date = ?, service_from = ?, service_to = ?, terms_days = ?,
          currency = ?, total_cents = ?, participant_name = ?, ndis_number = ?, updated_at = ? WHERE id = ?`)
          .run(values.client_id, values.status, values.number, values.issue_date, values.due_date, values.service_from, values.service_to, values.terms_days,
            values.currency, values.total_cents, values.participant_name, values.ndis_number, now, invoiceId);
        summary.invoices.updated++;
      } else {
        invoiceId = randomUUID();
        const payTo = (db.prepare("SELECT pay_to_account_id FROM clients WHERE id = ?").get(values.client_id) as { pay_to_account_id: string | null }).pay_to_account_id;
        db.prepare(`INSERT INTO invoices (id, client_id, status, number, issue_date, due_date, service_from, service_to, terms_days, currency, total_cents,
          participant_name, ndis_number, pay_to_account_id, source, external_ref, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?, ?)`)
          .run(invoiceId, values.client_id, values.status, values.number, values.issue_date, values.due_date, values.service_from, values.service_to, values.terms_days,
            values.currency, values.total_cents, values.participant_name, values.ndis_number, payTo, ref, now, now);
        summary.invoices.created++;
      }
      // The export has no line items: one line carries the total.
      db.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").run(invoiceId);
      db.prepare("INSERT INTO invoice_lines (id, invoice_id, position, description, quantity, unit_cents, line_cents, service_date) VALUES (?, ?, 1, ?, 1, ?, ?, ?)")
        .run(randomUUID(), invoiceId, "Imported from the previous invoicing system", totalCents, totalCents, serviceTo);

      if (finalStatus === "issued") {
        if (numeric > highest) highest = numeric;
        if (numeric < lowest) lowest = numeric;
        // Money received: the tracker's bank-matched figure wins; otherwise the export's "Total Paid".
        const t = tracked.get(rawNumber) ?? tracked.get(number);
        const paidCents = t ? t.paidCents : dollarsToCents(r.get("Total Paid"));
        const payRef = `previous-system:paid:${number}`;
        const existingPay = db.prepare("SELECT id FROM payments WHERE external_ref = ?").get(payRef) as { id: string } | undefined;
        if (paidCents > 0) {
          const evidence = t ? t.method : "previous invoicing system: total paid";
          if (existingPay) {
            db.prepare("UPDATE payments SET amount_cents = ?, received_on = ?, evidence = ? WHERE id = ?").run(paidCents, t?.receivedOn ?? null, evidence, existingPay.id);
            summary.payments.updated++;
          } else {
            db.prepare("INSERT INTO payments (id, invoice_id, amount_cents, received_on, account_id, matched_by, evidence, external_ref, created_at) VALUES (?, ?, ?, ?, NULL, 'import', ?, ?, ?)")
              .run(randomUUID(), invoiceId, paidCents, t?.receivedOn ?? null, evidence, payRef, now);
            summary.payments.created++;
          }
          if (t) summary.payments.fromTracker++;
          else summary.payments.fromExport++;
        } else if (existingPay) {
          db.prepare("DELETE FROM payments WHERE id = ?").run(existingPay.id);
        }
      }
    }
    if (dayFirstGuesses) summary.warnings.push(`${dayFirstGuesses} service date(s) were written like 05/06/24 and were read day-first (5 June). Check them.`);

    if (highest > 0) {
      const next = Math.max(money.settings().nextNumber, highest + 1);
      db.prepare("UPDATE settings SET next_number = ?, updated_at = ? WHERE id = 1").run(next, now);
      summary.numbers = {
        lowest: formatNumber(settings.numberPrefix, settings.numberWidth, lowest),
        highest: formatNumber(settings.numberPrefix, settings.numberWidth, highest),
        nextNumber: next,
      };
    }
    db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, ?, 'imported', NULL, ?)")
      .run(now, actor, `${summary.invoices.created + summary.invoices.updated} invoices, ${summary.clients.created + summary.clients.updated} clients`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return summary;
}
