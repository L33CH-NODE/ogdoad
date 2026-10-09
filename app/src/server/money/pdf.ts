// The invoice as a PDF: A4, plain and readable. "Invoice", never "Tax Invoice", and no GST line
// while the business isn't registered for GST. Drafts are rendered with a DRAFT mark and never
// saved; issued invoices are saved once, beside the Money database.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { sealFile } from "../vault.js";
import { MONEY_DIR } from "./db.js";
import { MoneyError, type Money } from "./service.js";

export const PDF_DIR = join(MONEY_DIR, "pdfs");

const INK = rgb(0.13, 0.13, 0.16);
const MUTED = rgb(0.42, 0.42, 0.48);
const RULE = rgb(0.86, 0.86, 0.9);
const ACCENT = rgb(0.3, 0.22, 0.62);

/** The standard PDF fonts only carry WinAnsi; swap what they can't draw for plain equivalents. */
function safe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");
}

export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-AU")}.${String(abs % 100).padStart(2, "0")}`;
}

function longDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** "1 Sep to 30 Sep 2026", "28 Dec 2026 to 3 Jan 2027", or one date. Short enough for the facts column. */
export function servicePeriod(from: string | null, to: string | null): string {
  const short = (iso: string, withYear: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
  if (from && to && from !== to) return `${short(from, from.slice(0, 4) !== to.slice(0, 4))} to ${short(to, true)}`;
  const one = to ?? from;
  return one ? short(one, true) : "";
}

/** Word-wrap one paragraph to a width, in a given font and size. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of safe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= width || !line) line = tryLine;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export async function renderInvoicePdf(m: Money, invoiceId: string): Promise<Uint8Array> {
  const inv = m.invoice(invoiceId);
  if (!inv) throw new MoneyError("no_invoice", "No such invoice.");
  const s = m.settings();
  const client = m.client(inv.clientId)!;
  const account = inv.payToAccountId ? m.account(inv.payToAccountId) : null;
  const isDraft = inv.status !== "issued";

  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${inv.number ?? "(draft)"}`);
  doc.setAuthor(s.businessName || "Ogdoad");
  doc.setCreator("Ogdoad");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([595.28, 841.89]);
  const W = page.getWidth();
  const M = 48;
  let y = page.getHeight() - M;

  const text = (t: string, x: number, size = 10, font = regular, color = INK) => page.drawText(safe(t), { x, y, size, font, color });
  const right = (t: string, xRight: number, size = 10, font = regular, color = INK) => page.drawText(safe(t), { x: xRight - font.widthOfTextAtSize(safe(t), size), y, size, font, color });

  // Header: the business, and the word Invoice.
  text("Invoice", M, 26, bold, ACCENT);
  right(s.businessName, W - M, 13, bold);
  y -= 16;
  right(`ABN ${s.abn.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, "$1 $2 $3 $4")}`, W - M, 9, regular, MUTED);
  for (const line of [s.address, s.contactEmail, s.contactPhone].filter(Boolean)) {
    y -= 12;
    right(line, W - M, 9, regular, MUTED);
  }
  if (isDraft) {
    page.drawText("DRAFT", { x: W / 2 - 120, y: page.getHeight() / 2 - 40, size: 96, font: bold, color: rgb(0.9, 0.88, 0.95), rotate: { type: "degrees", angle: 30 } as any });
  }

  // Bill to, and the invoice's facts.
  y -= 34;
  const top = y;
  text("Bill to", M, 9, bold, MUTED);
  y -= 14;
  text(client.name, M, 11, bold);
  for (const line of [client.contactName, ...wrap(client.address, regular, 10, 240), client.email].filter(Boolean)) {
    y -= 13;
    text(line, M, 10);
  }
  const participant = inv.participantName || client.participantName;
  const ndis = inv.ndisNumber || client.ndisNumber;
  if (participant || ndis) {
    y -= 18;
    text("NDIS participant", M, 9, bold, MUTED);
    if (participant) (y -= 13), text(participant, M, 10);
    if (ndis) (y -= 13), text(`NDIS number ${ndis}`, M, 10);
  }
  const left = y;
  y = top;
  const facts: Array<[string, string]> = [
    ["Invoice number", inv.number ?? "Draft"],
    ["Issued", longDate(inv.issueDate)],
    ["Due", longDate(inv.dueDate)],
  ];
  if (inv.serviceFrom || inv.serviceTo) facts.push(["Service", servicePeriod(inv.serviceFrom, inv.serviceTo)]);
  for (const [label, value] of facts) {
    if (!value) continue;
    right(label, W - M - 170, 9, bold, MUTED);
    page.drawText(safe(value), { x: W - M - 160, y, size: 10, font: regular, color: INK });
    y -= 14;
  }
  y = Math.min(left, y) - 28;

  // Lines.
  const cols = { desc: M, qty: W - M - 190, unit: W - M - 90, amount: W - M };
  const header = () => {
    text("Description", cols.desc, 9, bold, MUTED);
    right("Qty", cols.qty + 30, 9, bold, MUTED);
    right("Unit price", cols.unit + 10, 9, bold, MUTED);
    right("Amount", cols.amount, 9, bold, MUTED);
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.7, color: RULE });
    y -= 16;
  };
  header();
  for (const line of inv.lines) {
    const descLines = wrap(line.description + (line.serviceDate ? ` (${longDate(line.serviceDate)})` : ""), regular, 10, cols.qty - cols.desc - 20);
    if (y - descLines.length * 13 < M + 160) {
      page = doc.addPage([595.28, 841.89]);
      y = page.getHeight() - M;
      header();
    }
    right(String(line.quantity), cols.qty + 30);
    right(money(line.unitCents), cols.unit + 10);
    right(money(line.lineCents), cols.amount);
    for (const d of descLines) {
      text(d, cols.desc);
      y -= 13;
    }
    y -= 5;
  }
  page.drawLine({ start: { x: W - M - 220, y: y + 4 }, end: { x: W - M, y: y + 4 }, thickness: 0.7, color: RULE });
  y -= 14;
  right("Total (AUD)", W - M - 100, 11, bold);
  right(money(inv.totalCents), W - M, 13, bold);
  if (!s.gstRegistered) {
    y -= 16;
    right("No GST has been charged.", W - M, 8, regular, MUTED);
  }

  // How to pay.
  y -= 40;
  if (account) {
    text("How to pay", M, 9, bold, MUTED);
    y -= 15;
    text(`Bank transfer to ${account.accountName}${account.bankName ? `, ${account.bankName}` : ""}`, M, 10);
    y -= 13;
    text(`BSB ${account.bsb.replace(/(\d{3})(\d{3})/, "$1-$2")}   Account ${account.accountNumber}`, M, 10, bold);
    y -= 13;
    text(`Reference: ${inv.number ?? "your invoice number"}`, M, 10);
  }
  if (s.footerNote) {
    y -= 30;
    for (const line of wrap(s.footerNote, regular, 9, W - 2 * M)) {
      text(line, M, 9, regular, MUTED);
      y -= 12;
    }
  }
  return doc.save();
}

/**
 * Save an issued invoice's PDF beside the database and remember where. While the vault is unlocked
 * the copy is sealed at rest (it carries client details); the UI always renders a fresh one anyway.
 */
export async function saveIssuedPdf(m: Money, invoiceId: string, dir = PDF_DIR): Promise<string> {
  const inv = m.invoice(invoiceId);
  if (!inv || inv.status !== "issued") throw new MoneyError("not_issued", "Only issued invoices are saved as PDFs.");
  mkdirSync(dir, { recursive: true });
  const bytes = await renderInvoicePdf(m, invoiceId);
  const path = join(dir, `Invoice ${inv.number}.pdf${m.fileKey ? ".sealed" : ""}`);
  if (m.fileKey) sealFile(path, bytes, m.fileKey);
  else writeFileSync(path, bytes);
  m.setPdfPath(invoiceId, path);
  return path;
}
