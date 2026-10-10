// Flow: the operator's work as one stream, ranked, with one thing in focus. Their own tasks sit beside
// the work the rest of Ogdoad raises: a draft to issue, a late invoice to chase, bank lines to
// confirm. Raised work is keyed by what it's about, so it updates in place, and it closes itself
// ("cleared") once that thing is dealt with, wherever it was dealt with.

import { createHash, randomUUID } from "node:crypto";

import { reviewLines } from "../money/bank.js";
import { CHASE_REST_DAYS } from "../money/chase.js";
import { doubleBillingFindings } from "../money/checks.js";
import { MoneyError, todayIn, type Money } from "../money/service.js";
import { scoreTask, type RankContext } from "./rank.js";

export type TaskSource = "you" | "money" | "bank" | "work" | "team";
export type TaskState = "open" | "parked" | "done" | "dropped";

export interface Task {
  id: string;
  key: string | null;
  title: string;
  context: string;
  source: TaskSource;
  ref: string | null;
  cents: number | null;
  dueOn: string | null;
  urgency: 0 | 1 | 2 | 3;
  blocking: boolean;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  skippedAt: string | null;
  focusAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  score?: number;
}

/** Work another part of Ogdoad raises for the operator. */
export interface Raised {
  key: string;
  title: string;
  context: string;
  source: Exclude<TaskSource, "you">;
  ref: string | null;
  cents?: number | null;
  dueOn?: string | null;
  urgency: 0 | 1 | 2 | 3;
  blocking?: boolean;
}

export interface FlowView {
  now: Task | null;
  next: Task[];
  /** Everything open after Next, still in rank order. */
  later: Task[];
  parked: Task[];
  done: Task[];
  doneToday: number;
  /** Days in a row (ending today, or yesterday) with something done. */
  streak: number;
}

/** Raised work that clears itself when it's done where it lives, so Done alone is refused. */
const CLEARED_BY_DOING: Array<[string, string]> = [
  ["team:ask:", "Answer the question: it clears itself once it's answered."],
  ["team:approval:", "Approve it or turn it down: it clears itself once it's decided."],
  ["work:note:", "Write the note: it clears itself once it's finished."],
  ["work:bill:", "Make the draft in Work: it clears itself once the shifts are on it."],
  // Standing conditions: Done would hide them for good, while the thing is still wrong.
  ["work:calendar", "Fix the calendar settings (or turn the sync off): it clears itself once the sync works."],
  ["money:setup", "Finish Money's settings: it clears itself once they're complete."],
  ["money:gst:over", "Once you've registered, tick it in Money's settings: it clears itself."],
];

const iso = () => new Date().toISOString();
const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const aud = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });

function toTask(r: any): Task {
  return {
    id: r.id, key: r.key, title: r.title, context: r.context, source: r.source, ref: r.ref, cents: r.cents, dueOn: r.due_on,
    urgency: r.urgency, blocking: !!r.blocking, state: r.state, createdAt: r.created_at, updatedAt: r.updated_at,
    skippedAt: r.skipped_at, focusAt: r.focus_at, closedAt: r.closed_at, closedBy: r.closed_by,
  };
}

/** What Money and the bank are waiting on the operator for, right now. */
export function raisedFromMoney(money: Money): Raised[] {
  const out: Raised[] = [];
  const s = money.settings();
  if (!s.abn || !s.businessName || !money.accounts().length) {
    out.push({ key: "money:setup", title: "Finish setting up Money", context: "Add your business name, ABN and the account you're paid into, so invoices can be issued.", source: "money", ref: "/settings", urgency: 2, blocking: true });
  }

  const invoices = money.invoices();
  for (const inv of invoices.filter((i) => i.status === "draft")) {
    out.push({ key: `money:draft:${inv.id}`, title: `Issue the draft for ${inv.clientName}`, context: `${aud(inv.totalCents)}. Check the lines, then issue it.`, source: "money", ref: `/money/invoices/${inv.id}`, cents: inv.totalCents, urgency: 1, blocking: true });
  }
  const chased = new Map((money.db.prepare("SELECT subject_id, MAX(at) AS at FROM events WHERE kind = 'chased' GROUP BY subject_id").all() as Array<{ subject_id: string; at: string }>).map((r) => [r.subject_id, r.at]));
  for (const inv of invoices.filter((i) => i.status === "issued" && i.balanceCents > 0 && (i.daysOverdue ?? 0) > 0)) {
    const days = inv.daysOverdue!;
    const last = chased.get(inv.id);
    // A reminder went out lately: give it a week before pressing again.
    const resting = !!last && Date.now() - Date.parse(last) < CHASE_REST_DAYS * 86_400_000;
    out.push({
      key: `money:late:${inv.id}`, title: `Chase ${inv.number} from ${inv.clientName}`,
      context: resting
        ? `${aud(inv.balanceCents)}, ${days} day${days === 1 ? "" : "s"} late. You sent a reminder on ${new Date(last!).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}; give it a week, and check the bank.`
        : `${aud(inv.balanceCents)} is ${days} day${days === 1 ? "" : "s"} late. Check the bank first: it may already be paid.`,
      source: "money", ref: `/money/invoices/${inv.id}/chase`, cents: inv.balanceCents, dueOn: inv.dueDate, urgency: resting ? 0 : days > 60 ? 2 : 1,
    });
  }
  for (const f of doubleBillingFindings(invoices)) {
    out.push({ key: `money:check:${short(`${f.kind}:${[...f.invoiceIds].sort().join(",")}`)}`, title: "Check for double billing", context: f.message, source: "money", ref: `/money/invoices/${f.invoiceIds[0]}`, urgency: 2 });
  }
  const gst = money.gstMeter();
  if (gst.level === "near" || gst.level === "over") {
    out.push({
      key: `money:gst:${gst.level}`, title: gst.level === "over" ? "Register for GST" : "GST turnover is close to the threshold",
      context: gst.level === "over" ? `Turnover is at ${gst.percent}% of $75,000: you must register within 21 days.` : `Turnover is at ${gst.percent}% of $75,000. Talk to your accountant about registering.`,
      source: "money", ref: "/money", urgency: gst.level === "over" ? 3 : 2,
    });
  }

  const lines = reviewLines(money);
  for (const l of lines.filter((x) => x.flag === "paid_twice")) {
    out.push({ key: `bank:twice:${l.id}`, title: "A payment may have arrived twice", context: `${aud(l.amountCents)} on ${l.postedOn} ${l.reason}. Check before chasing anything; it may need refunding.`, source: "bank", ref: "/money/bank", cents: l.amountCents, urgency: 3, blocking: true });
  }
  const toConfirm = lines.filter((x) => x.flag !== "paid_twice");
  if (toConfirm.length) {
    out.push({
      key: `bank:confirm:${short(toConfirm.map((l) => l.id).sort().join(","))}`, title: `Confirm ${toConfirm.length} bank line${toConfirm.length === 1 ? "" : "s"}`,
      context: "Payments in that need your eye before anything is chased.", source: "bank", ref: "/money/bank",
      cents: toConfirm.reduce((a, l) => a + l.amountCents, 0), urgency: 2, blocking: true,
    });
  }
  return out;
}

export class Flow {
  constructor(private readonly money: Money) {}

  private get db() {
    return this.money.db;
  }

  private ctx(): RankContext {
    return { now: new Date(), today: this.money.today() };
  }

  private record(kind: string, task: Task): void {
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', ?, ?, ?)").run(iso(), kind, task.id, task.title);
  }

  /**
   * Bring raised work up to date. Only keys under the given prefixes are closed when they're no longer
   * raised, so a source that couldn't be read never wipes its tasks.
   */
  sync(raised: Raised[], prefixes: string[]): void {
    const now = iso();
    const live = new Set(raised.map((r) => r.key));
    this.db.exec("BEGIN");
    try {
      for (const r of raised) {
        const row = this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(r.key) as any;
        if (!row) {
          this.db.prepare(`INSERT INTO tasks (id, key, title, context, source, ref, cents, due_on, urgency, blocking, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), r.key, r.title, r.context, r.source, r.ref, r.cents ?? null, r.dueOn ?? null, r.urgency, r.blocking ? 1 : 0, now, now);
          continue;
        }
        // Raised again after clearing itself (a payment reversed, say): it's open again. So is work that
        // only clears by doing it, if it was marked done before that rule (it's still raised, so it isn't done).
        const reopen = row.state === "done" && (row.closed_by === "cleared" || CLEARED_BY_DOING.some(([p]) => r.key.startsWith(p)));
        if (row.state === "open" || row.state === "parked" || reopen) {
          this.db.prepare(`UPDATE tasks SET title = ?, context = ?, ref = ?, cents = ?, due_on = ?, urgency = ?, blocking = ?,
            state = CASE WHEN ? THEN 'open' ELSE state END, closed_at = CASE WHEN ? THEN NULL ELSE closed_at END, closed_by = CASE WHEN ? THEN NULL ELSE closed_by END,
            updated_at = CASE WHEN title = ? AND context = ? THEN updated_at ELSE ? END WHERE id = ?`)
            .run(r.title, r.context, r.ref, r.cents ?? null, r.dueOn ?? null, r.urgency, r.blocking ? 1 : 0, reopen ? 1 : 0, reopen ? 1 : 0, reopen ? 1 : 0, r.title, r.context, now, row.id);
        }
      }
      const open = this.db.prepare("SELECT id, key FROM tasks WHERE key IS NOT NULL AND state IN ('open', 'parked')").all() as Array<{ id: string; key: string }>;
      for (const t of open) {
        if (prefixes.some((p) => t.key.startsWith(p)) && !live.has(t.key)) {
          this.db.prepare("UPDATE tasks SET state = 'done', closed_by = 'cleared', closed_at = ?, focus_at = NULL, updated_at = ? WHERE id = ?").run(now, now, t.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  task(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) throw new MoneyError("no_task", "No such task.");
    return toTask(row);
  }

  view(): FlowView {
    const ctx = this.ctx();
    const open = (this.db.prepare("SELECT * FROM tasks WHERE state = 'open'").all() as any[])
      .map((r) => ({ ...toTask(r), score: 0 }))
      .map((t) => ({ ...t, score: scoreTask(t, ctx) }))
      .sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt));
    const parked = (this.db.prepare("SELECT * FROM tasks WHERE state = 'parked' ORDER BY updated_at DESC").all() as any[]).map(toTask);
    const done = (this.db.prepare("SELECT * FROM tasks WHERE state = 'done' AND closed_by = 'you' ORDER BY closed_at DESC LIMIT 400").all() as any[]).map(toTask);
    const tz = this.money.settings().timezone;
    const days = new Set(done.map((t) => todayIn(tz, new Date(t.closedAt!))));
    let streak = 0;
    let day = new Date(`${ctx.today}T12:00:00Z`);
    if (!days.has(ctx.today)) day = new Date(day.getTime() - 86_400_000);
    while (days.has(day.toISOString().slice(0, 10))) {
      streak++;
      day = new Date(day.getTime() - 86_400_000);
    }
    return {
      now: open[0] ?? null,
      next: open.slice(1, 4),
      later: open.slice(4),
      parked,
      done: done.slice(0, 8),
      doneToday: done.filter((t) => todayIn(tz, new Date(t.closedAt!)) === ctx.today).length,
      streak,
    };
  }

  add(input: { title: string; context?: string }): Task {
    const title = String(input.title ?? "").trim();
    if (!title) throw new MoneyError("no_title", "Say what the task is.");
    const id = randomUUID();
    const now = iso();
    this.db.prepare("INSERT INTO tasks (id, title, context, source, created_at, updated_at) VALUES (?, ?, ?, 'you', ?, ?)").run(id, title.slice(0, 200), String(input.context ?? "").slice(0, 2000), now, now);
    const task = this.task(id);
    this.record("task_added", task);
    return task;
  }

  /** done, skip, park, unpark, focus or drop. */
  act(id: string, action: string): Task {
    const t = this.task(id);
    const now = iso();
    const set = (sql: string, ...params: unknown[]) => this.db.prepare(`UPDATE tasks SET ${sql}, updated_at = ? WHERE id = ?`).run(...params, now, id);
    if (action === "done") {
      if (t.state === "done" || t.state === "dropped") throw new MoneyError("closed", "That task is already closed.");
      // Saying it's done would leave the work undone (a hire waiting, a note unwritten); doing it is what clears it.
      const doing = CLEARED_BY_DOING.find(([prefix]) => t.key?.startsWith(prefix));
      if (doing) throw new MoneyError("do_it", doing[1]);
      set("state = 'done', closed_by = 'you', closed_at = ?, focus_at = NULL", now);
    } else if (action === "skip") {
      set("skipped_at = ?, focus_at = NULL", now);
    } else if (action === "park") {
      set("state = 'parked', focus_at = NULL");
    } else if (action === "unpark") {
      set("state = 'open', skipped_at = NULL");
    } else if (action === "focus") {
      this.db.prepare("UPDATE tasks SET focus_at = NULL WHERE focus_at IS NOT NULL").run();
      set("state = 'open', focus_at = ?, skipped_at = NULL", now);
    } else if (action === "drop") {
      if (t.source !== "you") throw new MoneyError("not_yours", "Work Ogdoad raised closes itself once it's dealt with; park it instead.");
      set("state = 'dropped', closed_by = 'you', closed_at = ?, focus_at = NULL", now);
    } else {
      throw new MoneyError("bad_action", "Unknown action.");
    }
    const after = this.task(id);
    this.record(`task_${action === "unpark" ? "unparked" : action === "focus" ? "focused" : action === "skip" ? "skipped" : action === "drop" ? "dropped" : action === "park" ? "parked" : "done"}`, after);
    return after;
  }
}
