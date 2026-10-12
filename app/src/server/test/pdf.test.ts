// The invoice PDF, on synthetic data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

import { openMoneyDb } from "../money/db.js";
import { money as fmt, renderInvoicePdf, saveIssuedPdf } from "../money/pdf.js";
import { Money } from "../money/service.js";

function setup() {
  const m = new Money(openMoneyDb(":memory:"));
  const acct = m.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111111", accountNumber: "87654321" }, "operator");
  m.updateSettings({ businessName: "Sample Co", abn: "51824753556", address: "1 Sample St, Exampleton", footerNote: "Thank you — payment within 14 days please.", nextNumber: 107 }, "operator");
  const client = m.createClient({ name: "Sample Plan Managers", participantName: "Participant A", ndisNumber: "430000000", payToAccountId: acct.id }, "operator");
  const lines = Array.from({ length: 40 }, (_, i) => ({ description: `Support session ${i + 1} – community access`, quantity: 1.5, unitCents: 6547 }));
  return { m, draft: m.createDraft({ clientId: client.id, lines, serviceFrom: "2026-09-01", serviceTo: "2026-09-30" }, "operator") };
}

test("amounts print as Australian dollars", () => {
  assert.equal(fmt(130050), "$1,300.50");
  assert.equal(fmt(5), "$0.05");
});

test("a draft renders (long invoices run onto more pages) but isn't saved", async () => {
  const { m, draft } = setup();
  const bytes = await renderInvoicePdf(m, draft.id);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getTitle(), "Invoice (draft)");
  assert.ok(doc.getPageCount() >= 2, "40 lines need a second page");
  await assert.rejects(() => saveIssuedPdf(m, draft.id, mkdtempSync(join(tmpdir(), "money-pdf-"))), /Only issued/);
});

test("line breaks anywhere (a two-line address, a pasted name) render instead of failing the PDF", async () => {
  const { m, draft } = setup();
  m.updateSettings({ address: "Unit 2, 1 Sample St\r\nExampleton QLD 4000", contactEmail: "accounts@example.com" }, "operator");
  const client = m.createClient({ name: "Sample\nPlan Managers", contactName: "Accounts\r\nTeam", address: "PO Box 1\nExampleton" }, "operator");
  const other = m.createDraft({ clientId: client.id, lines: [{ description: "Support session\nwith a note", quantity: 1, unitCents: 6547 }] }, "operator");
  for (const id of [draft.id, other.id]) assert.ok((await PDFDocument.load(await renderInvoicePdf(m, id))).getPageCount() >= 1);
});

/** The words drawn on a PDF's pages: the standard fonts write each run as a hex string before Tj. */
function drawnText(doc: PDFDocument): string {
  const runs: string[] = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const flate = String(s.dict.get(PDFName.of("Filter")) ?? "").includes("FlateDecode");
      const body = Buffer.from(flate ? inflateSync(s.contents) : s.contents).toString("latin1");
      for (const m of body.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) runs.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
  }
  return runs.join("\n");
}

test("a draft's PDF shows what the issued one will: the account it's paid into, the terms, and the notes", async () => {
  const { m, draft } = setup();
  m.updateDraft(draft.id, { notes: "Support work for September:\nshopping and appointments." }, "operator");
  const text = drawnText(await PDFDocument.load(await renderInvoicePdf(m, draft.id)));
  assert.match(text, /BSB 111-111\s+Account 87654321/, "the client's account, before issuing");
  assert.match(text, /Terms\n14 days/);
  assert.match(text, /Support work for September:\nshopping and appointments\./, "notes, line by line");
  assert.doesNotMatch(text, /\nDue\n/, "no due date until it's issued");

  m.issue(draft.id, { issueDate: "2026-10-01" }, "operator");
  const issued = drawnText(await PDFDocument.load(await renderInvoicePdf(m, draft.id)));
  assert.match(issued, /Due\n15 October 2026/);
  assert.match(issued, /BSB 111-111\s+Account 87654321/);
});

test("with no account anywhere, a draft's PDF says where to set one instead of leaving it out", async () => {
  const m = new Money(openMoneyDb(":memory:"));
  m.updateSettings({ businessName: "Sample Co", abn: "51824753556" }, "operator");
  const client = m.createClient({ name: "Sample Client", termsDays: 0 }, "operator");
  const draft = m.createDraft({ clientId: client.id, lines: [{ description: "Support session", quantity: 1, unitCents: 6547 }] }, "operator");
  const text = drawnText(await PDFDocument.load(await renderInvoicePdf(m, draft.id)));
  assert.match(text, /Terms\nDue on receipt/);
  assert.match(text, /No account to pay into yet/);
});

test("an issued invoice is saved once, under its number", async () => {
  const { m, draft } = setup();
  m.issue(draft.id, { issueDate: "2026-10-01" }, "operator");
  const dir = mkdtempSync(join(tmpdir(), "money-pdf-"));
  const path = await saveIssuedPdf(m, draft.id, dir);
  assert.ok(existsSync(path));
  assert.match(path, /Invoice 00107\.pdf$/);
  assert.equal(m.invoice(draft.id)!.pdfPath, path);
  assert.equal((await PDFDocument.load(await renderInvoicePdf(m, draft.id))).getTitle(), "Invoice 00107");
});
