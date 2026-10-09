// The control center's own reads and actions: Flow (the operator's work), Signals (what happened, in
// words), Artifacts (what got made, with where it came from) and the month-by-month money that the
// built-in dashboard draws. Everything here reads the one encrypted database.

import type { IncomingMessage, ServerResponse } from "node:http";

import { Flow, raisedFromMoney } from "./flow/flow.js";
import { HttpError, readJson, sendJson } from "./http.js";
import { addDays, type Money } from "./money/service.js";

const aud = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });

export interface Signal {
  id: number;
  at: string;
  who: string;
  text: string;
  tone: "good" | "c1" | "warn" | "bad" | "muted" | "primary";
  kind: string;
}

/** Money's trail, read out as sentences. */
export function signals(money: Money, limit = 40): Signal[] {
  const rows = money.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit) as Array<{ id: number; at: string; actor: string; kind: string; subject_id: string | null; detail: string }>;
  const inv = money.db.prepare("SELECT i.number, c.name FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?");
  const client = money.db.prepare("SELECT name FROM clients WHERE id = ?");
  return rows.map((e) => {
    const who = e.actor === "operator" ? "you" : e.actor === "practice" ? "practice" : e.actor === "import" ? "import" : e.actor;
    const i = e.subject_id ? (inv.get(e.subject_id) as { number: string | null; name: string } | undefined) : undefined;
    const base = { id: e.id, at: e.at, who, kind: e.kind };
    switch (e.kind) {
      case "invoice_issued":
        return { ...base, who: "Money", text: `invoice ${e.detail} issued to ${i?.name ?? "a client"}`, tone: "good" as const };
      case "payment_recorded": {
        const [cents, how] = e.detail.split(" ");
        return { ...base, who: how === "bank" ? "Bank" : "Money", text: `payment in: ${aud(Number(cents))} on ${i?.number ?? "an invoice"} (${i?.name ?? ""})`.replace(" ()", ""), tone: "good" as const };
      }
      case "draft_created":
        return { ...base, text: `started a draft for ${i?.name ?? "a client"}`, tone: "c1" as const };
      case "draft_updated":
        return { ...base, text: `edited the draft for ${i?.name ?? "a client"}`, tone: "muted" as const };
      case "draft_rejected":
        return { ...base, text: `set aside the draft for ${i?.name ?? "a client"}${e.detail ? `: ${e.detail}` : ""}`, tone: "muted" as const };
      case "invoice_voided":
        return { ...base, text: `voided ${i?.number ?? "an invoice"}: ${e.detail}`, tone: "warn" as const };
      case "client_created":
      case "client_updated": {
        const c = e.subject_id ? (client.get(e.subject_id) as { name: string } | undefined) : undefined;
        return { ...base, text: `${e.kind === "client_created" ? "new client" : "updated client"}: ${c?.name ?? ""}`, tone: "muted" as const };
      }
      case "bank_imported":
        return { ...base, who: "Bank", text: `statement brought in: ${e.detail}`, tone: "good" as const };
      case "bank_line_ignored":
        return { ...base, who: "Bank", text: "a bank line was set aside", tone: "muted" as const };
      case "imported":
        return { ...base, who: "import", text: `brought in from the old invoicing site: ${e.detail}`, tone: "c1" as const };
      case "settings_updated":
        return { ...base, text: "changed Money's settings", tone: "muted" as const };
      case "account_created":
        return { ...base, text: `added a ${e.detail} account`, tone: "muted" as const };
      default:
        if (e.kind.startsWith("task_")) return { ...base, text: `${e.kind.slice(5)}: ${e.detail}`, tone: "primary" as const };
        return { ...base, text: e.kind.replaceAll("_", " "), tone: "muted" as const };
    }
  });
}

export interface Artifact {
  id: string;
  kind: "invoice";
  title: string;
  by: string;
  via: string;
  at: string;
  tier: "local only";
  cloudSaw: string;
  sealed: boolean;
  open: string;
  ref: string;
}

/** What got made. Invoices first; shift notes and the hires' work join as they arrive. */
export function artifacts(money: Money, limit = 60): Artifact[] {
  const rows = money.db.prepare(`SELECT i.id, i.number, i.issue_date, i.source, i.pdf_path, i.status, c.name,
      (SELECT e.at FROM events e WHERE e.subject_id = i.id AND e.kind = 'invoice_issued' ORDER BY e.id DESC LIMIT 1) AS issued_at,
      (SELECT e.actor FROM events e WHERE e.subject_id = i.id AND e.kind = 'invoice_issued' ORDER BY e.id DESC LIMIT 1) AS issued_by
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status IN ('issued', 'void')
    ORDER BY i.issue_date DESC, i.number DESC LIMIT ?`).all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    kind: "invoice",
    title: `Invoice ${r.number}${r.status === "void" ? " (void)" : ""} · ${r.name}`,
    by: r.source === "import" ? "your old invoicing site" : r.issued_by === "operator" ? "you" : (r.issued_by ?? "you"),
    via: r.source === "import" ? "imported" : "Money",
    at: r.issued_at ?? `${r.issue_date}T00:00:00.000Z`,
    tier: "local only",
    cloudSaw: "nothing",
    sealed: typeof r.pdf_path === "string" && r.pdf_path.endsWith(".sealed"),
    open: `/ogdoad/money/invoices/${r.id}/pdf`,
    ref: `/money/invoices/${r.id}`,
  }));
}

/** Invoiced (by issue date) and received (by date paid), month by month, for the last N months. */
export function monthly(money: Money, months = 12): Array<{ month: string; invoicedCents: number; receivedCents: number }> {
  const today = money.today();
  const first = `${today.slice(0, 7)}-01`;
  const list: string[] = [];
  let d = first;
  for (let i = 0; i < months; i++) {
    list.unshift(d.slice(0, 7));
    d = `${addDays(d, -1).slice(0, 7)}-01`;
  }
  const from = `${list[0]}-01`;
  const invoiced = new Map((money.db.prepare("SELECT substr(issue_date, 1, 7) AS m, SUM(total_cents) AS c FROM invoices WHERE status = 'issued' AND issue_date >= ? GROUP BY m").all(from) as any[]).map((r) => [r.m, r.c]));
  const received = new Map((money.db.prepare("SELECT substr(received_on, 1, 7) AS m, SUM(amount_cents) AS c FROM payments WHERE received_on >= ? GROUP BY m").all(from) as any[]).map((r) => [r.m, r.c]));
  return list.map((m) => ({ month: m, invoicedCents: invoiced.get(m) ?? 0, receivedCents: received.get(m) ?? 0 }));
}

/** /ogdoad/flow, /ogdoad/signals, /ogdoad/artifacts, /ogdoad/monthly. Returns false when it isn't ours. */
export async function handleCenter(money: Money, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after /ogdoad
  const method = req.method ?? "GET";
  const flow = new Flow(money);

  if (parts[0] === "flow") {
    if (parts.length === 1 && method === "GET") {
      flow.sync(raisedFromMoney(money), ["money:", "bank:"]);
      return sendJson(res, 200, flow.view()), true;
    }
    if (parts.length === 1 && method === "POST") return sendJson(res, 201, flow.add(await readJson(req))), true;
    if (parts.length === 3 && method === "POST") return sendJson(res, 200, flow.act(parts[1], parts[2])), true;
    throw new HttpError(404, "not_found", "No such Flow route.");
  }
  if (parts[0] === "signals" && method === "GET") return sendJson(res, 200, signals(money, Math.min(200, Number(url.searchParams.get("limit") ?? 40) || 40))), true;
  if (parts[0] === "artifacts" && method === "GET") return sendJson(res, 200, artifacts(money)), true;
  if (parts[0] === "monthly" && method === "GET") return sendJson(res, 200, monthly(money)), true;
  return false;
}
