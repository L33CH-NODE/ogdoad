// What a dashboard panel may read: a few curated tables, copied fresh into a sealed in-memory database
// for each run. Shift notes, bank lines, account numbers, contact details and NDIS numbers are never
// in them. That's what makes it safe for a hire (even a cloud one) to write a panel: it gets the
// shape below and writes the query; the rows stay on this machine, and only the operator sees them.

import type { Money } from "../money/service.js";
import { Work } from "../work/work.js";

export interface CuratedTable {
  name: string;
  columns: string[];
  rows: unknown[][];
}

interface Spec {
  name: string;
  about: string;
  columns: Array<[string, string]>;
  read: (money: Money) => unknown[][];
}

const rowsOf = (money: Money, sql: string) => money.db.prepare(sql).raw().all() as unknown[][];

const SPECS: Spec[] = [
  {
    name: "invoices",
    about: "every invoice (drafts too); amounts in dollars",
    columns: [["id", "text"], ["number", "text, null on drafts"], ["status", "draft | rejected | issued | void"], ["client", "the client's name"], ["issue_date", "YYYY-MM-DD"], ["due_date", "YYYY-MM-DD"], ["service_from", "YYYY-MM-DD"], ["service_to", "YYYY-MM-DD"], ["total", "dollars"], ["paid", "dollars received so far"]],
    read: (money) => rowsOf(money, `SELECT i.id, i.number, i.status, c.name, i.issue_date, i.due_date, i.service_from, i.service_to, i.total_cents / 100.0,
      COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0) / 100.0
      FROM invoices i JOIN clients c ON c.id = i.client_id`),
  },
  {
    name: "payments",
    about: "money received against invoices",
    columns: [["invoice", "the invoice's number"], ["client", "the client's name"], ["amount", "dollars"], ["received_on", "YYYY-MM-DD"], ["matched_by", "bank | import | manual"]],
    read: (money) => rowsOf(money, `SELECT i.number, c.name, p.amount_cents / 100.0, p.received_on, p.matched_by
      FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN clients c ON c.id = i.client_id`),
  },
  {
    name: "clients",
    about: "who the business invoices",
    columns: [["id", "text"], ["name", "text"], ["archived", "0 or 1"]],
    read: (money) => rowsOf(money, "SELECT id, name, archived FROM clients"),
  },
  {
    name: "shifts",
    about: "rostered shifts (never their notes); hours and amount worked out",
    columns: [["id", "text"], ["client", "the client's name"], ["participant", "who the support was for"], ["day", "YYYY-MM-DD"], ["start", "HH:MM"], ["end", "HH:MM"], ["hours", "number"], ["support", "the kind of support"], ["status", "planned | done | cancelled"], ["noted", "1 when its note is finished"], ["billed", "1 when it's on a draft or invoice"], ["amount", "dollars, hours at the rate plus travel"]],
    read: (money) => new Work(money).shifts({}).map((s) => [s.id, s.clientName, s.participantName, s.day, s.start, s.end, Math.round((s.minutes / 60) * 100) / 100, s.support, s.status, s.note === "final" ? 1 : 0, s.billed ? 1 : 0, s.cents / 100]),
  },
  {
    name: "tasks",
    about: "the operator's Flow, past and present",
    columns: [["source", "you | money | bank | work | team"], ["title", "text"], ["state", "open | parked | done | dropped"], ["urgency", "0 calm to 3 alarm"], ["created_at", "ISO timestamp"], ["closed_at", "ISO timestamp"], ["closed_by", "you | cleared"]],
    read: (money) => rowsOf(money, "SELECT source, title, state, urgency, created_at, closed_at, closed_by FROM tasks"),
  },
];

/** The curated tables, read fresh from the books. */
export function curatedTables(money: Money): CuratedTable[] {
  return SPECS.map((s) => ({ name: s.name, columns: s.columns.map(([c]) => c), rows: s.read(money) }));
}

/** The shape of the curated tables, in words: all a hire needs to write a panel. No rows, ever. */
export function schemaText(): string {
  return SPECS.map((s) => `${s.name} (${s.about}): ${s.columns.map(([c, t]) => `${c} ${t}`).join("; ")}`).join("\n");
}
