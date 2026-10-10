// The control center's own reads and actions: Flow (the operator's work), Signals (what happened, in
// words), Artifacts (what got made, with where it came from) and the month-by-month money that the
// built-in dashboard draws. Everything here reads the one encrypted database.

import type { IncomingMessage, ServerResponse } from "node:http";

import { Flow, raisedFromMoney, type Raised } from "./flow/flow.js";
import { HttpError, readJson, sendJson } from "./http.js";
import { addDays, type Money } from "./money/service.js";
import { raisedFromCalendar } from "./work/calendar.js";
import { raisedFromWork, Work } from "./work/work.js";

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
      // Work's trail names the shift, never what its note says.
      case "shift_added":
        return { ...base, text: `rostered a shift: ${e.detail}`, tone: "c1" as const };
      case "shift_updated":
        return { ...base, text: `moved or changed a shift: ${e.detail}`, tone: "muted" as const };
      case "shift_cancelled":
        return { ...base, text: `cancelled a shift: ${e.detail}`, tone: "muted" as const };
      case "shift_restored":
        return { ...base, text: `brought back a shift: ${e.detail}`, tone: "muted" as const };
      case "note_saved":
        return { ...base, text: `saved a draft note: ${e.detail}`, tone: "muted" as const };
      case "note_finished":
        return { ...base, text: `finished a shift note: ${e.detail}`, tone: e.detail.includes("incident") ? ("warn" as const) : ("good" as const) };
      case "incident_reported":
        return { ...base, text: `marked an incident reported: ${e.detail}`, tone: "good" as const };
      case "panel_added":
        return { ...base, text: `added a dashboard panel: ${e.detail}`, tone: "c1" as const };
      case "panel_removed":
        return { ...base, text: `took down a dashboard panel: ${e.detail}`, tone: "muted" as const };
      case "calendar_set":
        return { ...base, text: e.detail === "off" ? "turned the calendar sync off" : `set the calendar sync to ${e.detail}`, tone: "muted" as const };
      case "shifts_billed":
        return { ...base, who: "Work", text: `drafted an invoice from ${e.detail}`, tone: "c1" as const };
      default:
        if (e.kind.startsWith("task_")) return { ...base, text: `${e.kind.slice(5)}: ${e.detail}`, tone: "primary" as const };
        return { ...base, text: e.kind.replaceAll("_", " "), tone: "muted" as const };
    }
  });
}

export interface Artifact {
  id: string;
  kind: "invoice" | "note";
  title: string;
  by: string;
  via: string;
  at: string;
  tier: "local only";
  cloudSaw: string;
  sealed: boolean;
  /** A file to open (an invoice's PDF); null when it opens in place. */
  open: string | null;
  ref: string;
}

/** What got made: issued invoices and finished shift notes, newest first. The hires' work joins later. */
export function artifacts(money: Money, limit = 60): Artifact[] {
  const notes = (money.db.prepare(`SELECT s.id, s.day, s.participant_name, c.name, c.participant_name AS client_participant, n.updated_at, n.written_by
    FROM shift_notes n JOIN shifts s ON s.id = n.shift_id JOIN clients c ON c.id = s.client_id
    WHERE n.final = 1 ORDER BY n.updated_at DESC LIMIT ?`).all(limit) as any[]).map((r): Artifact => ({
    id: r.id,
    kind: "note",
    title: `Shift note · ${r.participant_name || r.client_participant || r.name} · ${r.day}`,
    by: r.written_by === "you" ? "you" : r.written_by,
    via: "Work",
    at: r.updated_at,
    tier: "local only",
    cloudSaw: "nothing",
    sealed: false,
    open: null,
    ref: `/work/shift/${r.id}`,
  }));
  return [...invoiceArtifacts(money, limit), ...notes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

function invoiceArtifacts(money: Money, limit: number): Artifact[] {
  const rows = money.db.prepare(`SELECT i.id, i.number, i.issue_date, i.source, i.pdf_path, i.status, c.name,
      (SELECT e.at FROM events e WHERE e.subject_id = i.id AND e.kind = 'invoice_issued' ORDER BY e.id DESC LIMIT 1) AS issued_at,
      (SELECT e.actor FROM events e WHERE e.subject_id = i.id AND e.kind = 'invoice_issued' ORDER BY e.id DESC LIMIT 1) AS issued_by
    FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.status IN ('issued', 'void')
    ORDER BY i.issue_date DESC, i.number DESC LIMIT ?`).all(limit) as any[];
  return rows.map((r): Artifact => ({
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

export interface CenterContext {
  /** What the team is waiting on the operator for; null when it couldn't be read (or isn't wanted here). */
  team?: () => Promise<Raised[] | null>;
}

/** Bring Flow up to date with everything that raises work: Money and the bank, and the team when it answers. */
export async function syncFlow(money: Money, ctx: CenterContext): Promise<Flow> {
  const flow = new Flow(money);
  const team = (await ctx.team?.()) ?? null;
  const local = [...raisedFromMoney(money), ...raisedFromWork(new Work(money), money.today()), ...raisedFromCalendar(money)];
  flow.sync([...local, ...(team ?? [])], team ? ["money:", "bank:", "work:", "team:"] : ["money:", "bank:", "work:"]);
  return flow;
}

/** Done, skip, park... on a Flow task, with what that means where the work lives. */
export function actOnTask(money: Money, id: string, action: string) {
  const flow = new Flow(money);
  const key = flow.task(id).key;
  // "Report the incident", done: that's the operator saying it was reported.
  if (action === "done" && key?.startsWith("work:incident:")) new Work(money).incidentReported(key.slice("work:incident:".length));
  return flow.act(id, action);
}

/** /ogdoad/flow, /ogdoad/signals, /ogdoad/artifacts, /ogdoad/monthly. Returns false when it isn't ours. */
export async function handleCenter(money: Money, req: IncomingMessage, res: ServerResponse, url: URL, ctx: CenterContext = {}): Promise<boolean> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after /ogdoad
  const method = req.method ?? "GET";
  const flow = new Flow(money);

  if (parts[0] === "flow") {
    if (parts.length === 1 && method === "GET") return sendJson(res, 200, (await syncFlow(money, ctx)).view()), true;
    if (parts.length === 1 && method === "POST") return sendJson(res, 201, flow.add(await readJson(req))), true;
    if (parts.length === 3 && method === "POST") return sendJson(res, 200, actOnTask(money, parts[1], parts[2])), true;
    throw new HttpError(404, "not_found", "No such Flow route.");
  }
  if (parts[0] === "signals" && method === "GET") return sendJson(res, 200, signals(money, Math.min(200, Number(url.searchParams.get("limit") ?? 40) || 40))), true;
  if (parts[0] === "artifacts" && method === "GET") return sendJson(res, 200, artifacts(money)), true;
  if (parts[0] === "monthly" && method === "GET") return sendJson(res, 200, monthly(money)), true;
  return false;
}
