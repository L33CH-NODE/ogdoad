// The accountant pack: one Australian financial year (1 July to 30 June) in the shapes an accountant
// asks for. The invoices issued that year and the payments received that year as CSV, and a one-page
// summary: invoiced and received, what was still owed on 30 June, by client and by month, hours worked,
// and where GST stands. Read from the books on this machine; nothing is sent anywhere.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { Work } from "../work/work.js";
import { money as fmt } from "./pdf.js";
import type { Money } from "./service.js";

/** "2025-26" for any day from 1 July 2025 to 30 June 2026. */
export function fyOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 7 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function fyRange(fy: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new Error("A financial year looks like 2025-26.");
  return { from: `${m[1]}-07-01`, to: `${Number(m[1]) + 1}-06-30` };
}

/** Every year the books have something in, newest first (always including this one). */
export function years(money: Money): string[] {
  const first = (money.db.prepare("SELECT MIN(d) AS d FROM (SELECT MIN(issue_date) AS d FROM invoices UNION ALL SELECT MIN(received_on) FROM payments)").get() as { d: string | null }).d;
  const now = fyOf(money.today());
  const out: string[] = [];
  let y = Number(now.slice(0, 4));
  const stop = first ? Number(fyOf(first).slice(0, 4)) : y;
  for (; y >= stop; y--) out.push(`${y}-${String((y + 1) % 100).padStart(2, "0")}`);
  return out;
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const dollars = (cents: number) => (cents / 100).toFixed(2);

export function invoicesCsv(money: Money, fy: string): string {
  const { from, to } = fyRange(fy);
  const rows = money.db.prepare(`SELECT i.number, i.status, c.name AS client, COALESCE(NULLIF(i.participant_name, ''), c.participant_name) AS participant,
      i.issue_date, i.due_date, i.service_from, i.service_to, i.total_cents, i.void_reason,
      COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id AND p.received_on <= ?), 0) AS paid_by_end,
      COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_all
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status IN ('issued', 'void') AND i.issue_date BETWEEN ? AND ? ORDER BY i.issue_date, i.number`).all(to, from, to) as any[];
  return csv(
    ["Number", "Status", "Client", "Participant", "Issued", "Due", "Service from", "Service to", "Total", "Paid by 30 June", "Paid to date", "Owed now", "Void reason"],
    rows.map((r) => [r.number, r.status, r.client, r.participant, r.issue_date, r.due_date, r.service_from, r.service_to, dollars(r.total_cents),
      dollars(r.status === "void" ? 0 : r.paid_by_end), dollars(r.paid_all), dollars(r.status === "void" ? 0 : Math.max(0, r.total_cents - r.paid_all)), r.void_reason ?? ""]),
  );
}

export function paymentsCsv(money: Money, fy: string): string {
  const { from, to } = fyRange(fy);
  const rows = money.db.prepare(`SELECT p.received_on, i.number, c.name AS client, p.amount_cents, p.matched_by, a.label AS account
    FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id LEFT JOIN payment_accounts a ON a.id = p.account_id
    WHERE p.received_on BETWEEN ? AND ? ORDER BY p.received_on, i.number`).all(from, to) as any[];
  return csv(["Received", "Invoice", "Client", "Amount", "Matched by", "Into"], rows.map((r) => [r.received_on, r.number, r.client, dollars(r.amount_cents), r.matched_by, r.account ?? ""]));
}

export interface YearSummary {
  fy: string;
  from: string;
  to: string;
  invoicedCents: number;
  receivedCents: number;
  /** Owed on 30 June for invoices issued that year. */
  owedAtEndCents: number;
  invoices: number;
  voided: number;
  byClient: Array<{ client: string; invoicedCents: number; receivedCents: number }>;
  byMonth: Array<{ month: string; invoicedCents: number; receivedCents: number }>;
  hoursWorked: number;
  shifts: number;
  gstRegistered: boolean;
}

export function summary(money: Money, fy: string): YearSummary {
  const { from, to } = fyRange(fy);
  const db = money.db;
  const inv = db.prepare(`SELECT c.name AS client, substr(i.issue_date, 1, 7) AS month, i.total_cents, i.status,
      COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id AND p.received_on <= ?), 0) AS paid_by_end
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status IN ('issued', 'void') AND i.issue_date BETWEEN ? AND ?`).all(to, from, to) as any[];
  const pay = db.prepare(`SELECT c.name AS client, substr(p.received_on, 1, 7) AS month, p.amount_cents
    FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id WHERE p.received_on BETWEEN ? AND ?`).all(from, to) as any[];
  const issued = inv.filter((r) => r.status === "issued");
  const clients = new Map<string, { client: string; invoicedCents: number; receivedCents: number }>();
  const months = new Map<string, { month: string; invoicedCents: number; receivedCents: number }>();
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(Number(from.slice(0, 4)), 6 + i, 1));
    const k = d.toISOString().slice(0, 7);
    months.set(k, { month: k, invoicedCents: 0, receivedCents: 0 });
  }
  const c = (name: string) => clients.get(name) ?? clients.set(name, { client: name, invoicedCents: 0, receivedCents: 0 }).get(name)!;
  for (const r of issued) {
    c(r.client).invoicedCents += r.total_cents;
    months.get(r.month)!.invoicedCents += r.total_cents;
  }
  for (const r of pay) {
    c(r.client).receivedCents += r.amount_cents;
    months.get(r.month)!.receivedCents += r.amount_cents;
  }
  const shifts = new Work(money).shifts({ from, to }).filter((s) => s.status !== "cancelled" && s.phase === "over");
  return {
    fy, from, to,
    invoicedCents: issued.reduce((a, r) => a + r.total_cents, 0),
    receivedCents: pay.reduce((a, r) => a + r.amount_cents, 0),
    owedAtEndCents: issued.reduce((a, r) => a + Math.max(0, r.total_cents - r.paid_by_end), 0),
    invoices: issued.length,
    voided: inv.length - issued.length,
    byClient: [...clients.values()].sort((a, b) => b.invoicedCents - a.invoicedCents),
    byMonth: [...months.values()],
    hoursWorked: Math.round(shifts.reduce((a, s) => a + s.minutes, 0) / 6) / 10,
    shifts: shifts.length,
    gstRegistered: money.settings().gstRegistered,
  };
}

/** The summary on one A4 page, in the same plain style as the invoices. */
export async function summaryPdf(money: Money, fy: string): Promise<Uint8Array> {
  const s = summary(money, fy);
  const biz = money.settings();
  const doc = await PDFDocument.create();
  doc.setTitle(`Financial year ${fy}`);
  doc.setAuthor(biz.businessName || "Ogdoad");
  doc.setCreator("Ogdoad");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const W = page.getWidth();
  const M = 48;
  let y = page.getHeight() - M;
  const INK = rgb(0.13, 0.13, 0.16);
  const MUTED = rgb(0.42, 0.42, 0.48);
  const ACCENT = rgb(0.3, 0.22, 0.62);
  const clean = (t: string) => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
  const text = (t: string, x: number, size = 10, font = regular, color = INK) => page.drawText(clean(t), { x, y, size, font, color });
  const right = (t: string, xr: number, size = 10, font = regular, color = INK) => page.drawText(clean(t), { x: xr - font.widthOfTextAtSize(clean(t), size), y, size, font, color });
  const long = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  text(`Financial year ${fy}`, M, 22, bold, ACCENT);
  right(biz.businessName, W - M, 12, bold);
  y -= 16;
  text(`${long(s.from)} to ${long(s.to)}`, M, 10, regular, MUTED);
  if (biz.abn) right(`ABN ${biz.abn.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, "$1 $2 $3 $4")}`, W - M, 9, regular, MUTED);

  y -= 34;
  const facts: Array<[string, string]> = [
    ["Invoiced (by issue date)", fmt(s.invoicedCents)],
    ["Received (by date paid)", fmt(s.receivedCents)],
    ["Still owed on 30 June, for that year's invoices", fmt(s.owedAtEndCents)],
    ["Invoices issued", `${s.invoices}${s.voided ? ` (and ${s.voided} voided)` : ""}`],
    ["Shifts worked", s.shifts ? `${s.shifts}, ${s.hoursWorked} hours` : "none recorded in Ogdoad"],
    ["GST", s.gstRegistered ? "Registered" : "Not registered; no GST was charged"],
  ];
  for (const [k, v] of facts) {
    text(k, M, 10, regular, MUTED);
    right(v, W - M, 10, bold);
    y -= 16;
  }

  y -= 16;
  text("By client", M, 11, bold);
  right("Invoiced", W - M - 110, 9, bold, MUTED);
  right("Received", W - M, 9, bold, MUTED);
  y -= 14;
  for (const r of s.byClient.slice(0, 18)) {
    text(r.client.slice(0, 60), M, 10);
    right(fmt(r.invoicedCents), W - M - 110, 10);
    right(fmt(r.receivedCents), W - M, 10);
    y -= 14;
  }
  if (s.byClient.length > 18) (text(`and ${s.byClient.length - 18} more (see the CSVs)`, M, 9, regular, MUTED), (y -= 14));

  y -= 14;
  text("By month", M, 11, bold);
  right("Invoiced", W - M - 110, 9, bold, MUTED);
  right("Received", W - M, 9, bold, MUTED);
  y -= 14;
  for (const r of s.byMonth) {
    text(new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" }), M, 10);
    right(fmt(r.invoicedCents), W - M - 110, 10);
    right(fmt(r.receivedCents), W - M, 10);
    y -= 14;
  }

  y = M + 14;
  text("Made by Ogdoad from the books on this machine. The invoice and payment CSVs for the same year carry every line.", M, 8, regular, MUTED);
  return doc.save();
}
