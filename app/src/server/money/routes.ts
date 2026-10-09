// Money's HTTP API, under /ogdoad/money. Phase 1: the operator's own UI is the only caller, so
// every change is recorded as the operator's. Agents come later, behind sessions and the director key.

import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpError, readJson, sendJson } from "../http.js";
import { confirmLine, ignoreLine, importStatement, reviewLines } from "./bank.js";
import { doubleBillingFindings, type Finding } from "./checks.js";
import { importPreviousSystem } from "./import.js";
import { renderInvoicePdf, saveIssuedPdf } from "./pdf.js";
import type { Money } from "./service.js";

const ACTOR = "operator";

export async function handleMoney(money: Money, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean).slice(2); // after /ogdoad/money
  const [resource, id, action] = parts;
  const method = req.method ?? "GET";

  if (resource === "overview" && method === "GET") {
    const invoices = money.invoices();
    return sendJson(res, 200, {
      settings: money.settings(),
      accounts: money.accounts(),
      ageing: money.ageing(),
      gst: money.gstMeter(),
      findings: [...doubleBillingFindings(invoices), ...bankFindings(money)],
      bankToReview: reviewLines(money).length,
      counts: {
        drafts: invoices.filter((i) => i.status === "draft").length,
        issued: invoices.filter((i) => i.status === "issued").length,
        owed: invoices.filter((i) => i.balanceCents > 0).length,
        clients: money.clients().length,
      },
      today: money.today(),
    });
  }

  if (resource === "settings") {
    if (method === "GET") return sendJson(res, 200, money.settings());
    if (method === "PUT") return sendJson(res, 200, money.updateSettings(await readJson(req), ACTOR));
  }

  if (resource === "accounts") {
    if (!id && method === "GET") return sendJson(res, 200, money.accounts(url.searchParams.get("archived") === "1"));
    if (!id && method === "POST") return sendJson(res, 201, money.createAccount(await readJson(req), ACTOR));
    if (id && action === "archive" && method === "POST") return money.archiveAccount(id, ACTOR), sendJson(res, 200, { ok: true });
  }

  if (resource === "clients") {
    if (!id && method === "GET") return sendJson(res, 200, money.clients(url.searchParams.get("archived") === "1"));
    if (!id && method === "POST") return sendJson(res, 201, money.createClient(await readJson(req), ACTOR));
    if (id && !action && method === "GET") {
      const client = money.client(id);
      if (!client) throw new HttpError(404, "no_client", "No such client.");
      return sendJson(res, 200, { ...client, invoices: money.invoices({ clientId: id }) });
    }
    if (id && !action && method === "PUT") return sendJson(res, 200, money.updateClient(id, await readJson(req), ACTOR));
  }

  if (resource === "invoices") {
    if (!id && method === "GET") return sendJson(res, 200, money.invoices({ status: url.searchParams.get("status") ?? undefined, clientId: url.searchParams.get("clientId") ?? undefined }));
    if (!id && method === "POST") return sendJson(res, 201, money.createDraft(await readJson(req), ACTOR));
    if (id && !action && method === "GET") {
      const inv = money.invoice(id);
      if (!inv) throw new HttpError(404, "no_invoice", "No such invoice.");
      return sendJson(res, 200, { ...inv, events: money.events(id) });
    }
    if (id && !action && method === "PUT") return sendJson(res, 200, money.updateDraft(id, await readJson(req), ACTOR));
    if (id && action === "issue" && method === "POST") {
      const body = await readJson(req);
      const issued = money.issue(id, { issueDate: body.issueDate }, ACTOR);
      await saveIssuedPdf(money, id);
      return sendJson(res, 200, money.invoice(issued.id));
    }
    if (id && action === "reject" && method === "POST") return sendJson(res, 200, money.rejectDraft(id, String((await readJson(req)).reason ?? ""), ACTOR));
    if (id && action === "void" && method === "POST") return sendJson(res, 200, money.voidInvoice(id, String((await readJson(req)).reason ?? ""), ACTOR));
    if (id && action === "payments" && method === "POST") {
      const body = await readJson(req);
      return sendJson(res, 201, money.recordPayment({ invoiceId: id, amountCents: body.amountCents, receivedOn: body.receivedOn, accountId: body.accountId, matchedBy: "manual", evidence: body.evidence }, ACTOR));
    }
    if (id && action === "pdf" && method === "GET") {
      const bytes = await renderInvoicePdf(money, id);
      const inv = money.invoice(id)!;
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `inline; filename="Invoice ${inv.number ?? "draft"}.pdf"`, "cache-control": "no-store" });
      return void res.end(Buffer.from(bytes));
    }
  }

  // The previous system's files, uploaded from the operator's own disk through the UI.
  if (resource === "import" && method === "POST") {
    const body = await readJson(req, 32 * 1024 * 1024);
    if (typeof body.invoicesCsv !== "string") throw new HttpError(400, "no_file", "Choose the invoicing site's export (the invoices CSV).");
    return sendJson(res, 200, importPreviousSystem(money, { invoicesCsv: body.invoicesCsv, trackerCsv: typeof body.trackerCsv === "string" ? body.trackerCsv : undefined }, ACTOR));
  }

  // Money in: bank statements (the bank's CSV, read on this machine).
  if (resource === "bank") {
    if (id === "import" && method === "POST") {
      const body = await readJson(req, 16 * 1024 * 1024);
      if (typeof body.csv !== "string") throw new HttpError(400, "no_file", "Choose the bank's CSV export.");
      return sendJson(res, 200, importStatement(money, { accountId: String(body.accountId ?? ""), csv: body.csv }, ACTOR));
    }
    if (id === "review" && method === "GET") return sendJson(res, 200, reviewLines(money));
    const lineAction = parts[3];
    if (id === "lines" && action && lineAction === "confirm" && method === "POST") {
      const body = await readJson(req);
      return confirmLine(money, action, Array.isArray(body.invoiceIds) ? body.invoiceIds.map(String) : [], ACTOR), sendJson(res, 200, { ok: true });
    }
    if (id === "lines" && action && lineAction === "ignore" && method === "POST") return ignoreLine(money, action, ACTOR), sendJson(res, 200, { ok: true });
  }

  if (resource === "events" && method === "GET") return sendJson(res, 200, money.events(url.searchParams.get("subject") ?? undefined));

  throw new HttpError(404, "not_found", "No such Money route.");
}

/** Credits that look like a second payment of an invoice that was already paid. */
function bankFindings(money: Money): Finding[] {
  return reviewLines(money)
    .filter((l) => l.flag === "paid_twice")
    .map((l) => ({ kind: "overpaid" as const, invoiceIds: l.groups.flat().map((i) => i.id), message: `A payment of $${(l.amountCents / 100).toFixed(2)} on ${l.postedOn} ${l.reason}. Check before chasing anything; it may need refunding.` }));
}
