// Dashboards as recipes: a panel is a saved query plus a declarative chart, never pasted numbers, and
// every panel can show its query. Queries run in a separate process over the curated tables only (see
// curated.ts), with a time limit, so a panel can read the business but never change it or see a note.

import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { MoneyError, type Money } from "../money/service.js";
import { curatedTables } from "./curated.js";
import type { RunResult } from "./runner.js";

export const CHART_TYPES = ["bar", "line", "stat", "table"] as const;
export const FORMATS = ["aud", "number", "hours", "percent"] as const;

export interface ChartSpec {
  type: (typeof CHART_TYPES)[number];
  /** The column along the bottom (bar, line) or the label (stat). */
  x?: string;
  /** The numeric columns to draw. */
  y?: string[];
  format?: (typeof FORMATS)[number];
}

export interface Panel {
  id: string;
  title: string;
  sql: string;
  chart: ChartSpec;
  /** Who made it: "Ogdoad" (built in), "you", or a hire's name. */
  madeBy: string;
  position: number;
  createdAt: string;
}

export type PanelWithResult = Panel & { result: RunResult };

const RUNNER = fileURLToPath(new URL("./runner.js", import.meta.url));
const ROW_LIMIT = 500;
const TIME_LIMIT_MS = 5000;

/** The last results per open set of books, with the data version they were read at. */
const cache = new WeakMap<Money, { version: string; panels: PanelWithResult[] }>();

const toPanel = (r: any): Panel => ({ id: r.id, title: r.title, sql: r.sql, chart: JSON.parse(r.chart), madeBy: r.made_by, position: r.position, createdAt: r.created_at });

/** Check a recipe's shape. The query itself is checked by running it. */
export function checkRecipe(input: { title?: unknown; sql?: unknown; chart?: unknown }): { title: string; sql: string; chart: ChartSpec } {
  const title = String(input.title ?? "").trim().slice(0, 120);
  if (!title) throw new MoneyError("no_title", "Give the panel a title.");
  const sql = String(input.sql ?? "").trim().replace(/;\s*$/, "");
  if (!sql) throw new MoneyError("no_sql", "A panel needs its query.");
  if (sql.length > 6000) throw new MoneyError("long_sql", "That query is too long for a panel.");
  if (!/^(select|with)\b/i.test(sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, ""))) throw new MoneyError("not_select", "A panel's query starts with SELECT (or WITH).");
  const c = (input.chart ?? {}) as Record<string, unknown>;
  if (!(CHART_TYPES as readonly unknown[]).includes(c.type)) throw new MoneyError("bad_chart", `The chart is one of: ${CHART_TYPES.join(", ")}.`);
  if (c.format !== undefined && !(FORMATS as readonly unknown[]).includes(c.format)) throw new MoneyError("bad_chart", `The format is one of: ${FORMATS.join(", ")}.`);
  const y = c.y === undefined ? undefined : Array.isArray(c.y) ? c.y.map(String).slice(0, 6) : [String(c.y)];
  // Only these keys are kept: a chart is data, never code.
  const chart: ChartSpec = { type: c.type as ChartSpec["type"], ...(c.x !== undefined ? { x: String(c.x) } : {}), ...(y ? { y } : {}), ...(c.format ? { format: c.format as ChartSpec["format"] } : {}) };
  return { title, sql, chart };
}

/** Run queries over the curated tables in a separate process; each gets its rows or its error. */
export function runQueries(money: Money, queries: string[]): Promise<RunResult[]> {
  if (!queries.length) return Promise.resolve([]);
  const tables = curatedTables(money);
  return new Promise((resolve) => {
    const child = fork(RUNNER, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", execArgv: [] });
    let done = false;
    const finish = (r: RunResult[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(queries.map(() => ({ ok: false, error: "That took too long, so it was stopped. Try a simpler query." })));
    }, TIME_LIMIT_MS);
    child.once("message", (r) => finish(r as RunResult[]));
    child.once("error", (err) => finish(queries.map(() => ({ ok: false, error: err.message }))));
    child.once("exit", () => finish(queries.map(() => ({ ok: false, error: "The query runner stopped." }))));
    child.send({ tables, queries, limit: ROW_LIMIT });
  });
}

/** A chart that names columns the query doesn't return can't be drawn. */
function chartFits(chart: ChartSpec, r: RunResult): RunResult {
  if (!r.ok) return r;
  const missing = [chart.x, ...(chart.y ?? [])].filter((c): c is string => !!c && !r.columns.includes(c));
  return missing.length ? { ok: false, error: `The chart wants ${missing.join(", ")}, which the query doesn't return (it returns ${r.columns.join(", ")}).` } : r;
}

export class Dashboards {
  constructor(private readonly money: Money) {}

  private get db() {
    return this.money.db;
  }

  list(): Panel[] {
    return (this.db.prepare("SELECT * FROM dashboards ORDER BY position, created_at").all() as any[]).map(toPanel);
  }

  /** What the curated tables were read from: when none of it has moved, the last results still stand. */
  private version(): string {
    const r = this.db.prepare(`SELECT (SELECT MAX(id) FROM events) AS e, (SELECT MAX(updated_at) FROM tasks) AS t, (SELECT COUNT(*) FROM tasks) AS tc,
      (SELECT MAX(updated_at) FROM shifts) AS s, (SELECT MAX(updated_at) FROM invoices) AS i, (SELECT COUNT(*) FROM payments) AS p, (SELECT MAX(updated_at) FROM dashboards) AS d, (SELECT COUNT(*) FROM dashboards) AS dc,
      (SELECT MAX(at) FROM market_quotes) AS mq, (SELECT COUNT(*) FROM market_daily) AS md, (SELECT group_concat(id) FROM market_watchlist) AS mw`).get() as Record<string, unknown>;
    // The day matters too: a panel can ask for "this month".
    return `${Object.values(r).join("|")}|${this.money.today()}`;
  }

  async withResults(): Promise<PanelWithResult[]> {
    const version = this.version();
    const hit = cache.get(this.money);
    if (hit && hit.version === version) return hit.panels;
    const panels = this.list();
    const results = await runQueries(this.money, panels.map((p) => p.sql));
    const out = panels.map((p, i) => ({ ...p, result: chartFits(p.chart, results[i]) }));
    cache.set(this.money, { version, panels: out });
    return out;
  }

  async preview(input: { sql?: unknown; chart?: unknown; title?: unknown }): Promise<RunResult> {
    const r = checkRecipe({ title: "preview", ...input });
    const [result] = await runQueries(this.money, [r.sql]);
    return chartFits(r.chart, result);
  }

  /** Add a panel, once its query runs and its chart fits. */
  async add(input: { title?: unknown; sql?: unknown; chart?: unknown; madeBy?: unknown }): Promise<PanelWithResult> {
    const r = checkRecipe(input);
    const [result] = await runQueries(this.money, [r.sql]);
    const fits = chartFits(r.chart, result);
    if (!fits.ok) throw new MoneyError("bad_query", fits.error);
    const id = randomUUID();
    const now = new Date().toISOString();
    const madeBy = String(input.madeBy ?? "you").slice(0, 80) || "you";
    const position = ((this.db.prepare("SELECT MAX(position) AS p FROM dashboards").get() as { p: number | null }).p ?? 0) + 1;
    this.db.prepare("INSERT INTO dashboards (id, title, sql, chart, made_by, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, r.title, r.sql, JSON.stringify(r.chart), madeBy, position, now, now);
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'panel_added', ?, ?)").run(now, id, `${r.title}${madeBy === "you" ? "" : ` (by ${madeBy})`}`);
    return { ...toPanel(this.db.prepare("SELECT * FROM dashboards WHERE id = ?").get(id)), result: fits };
  }

  remove(id: string): void {
    const p = this.db.prepare("SELECT title FROM dashboards WHERE id = ?").get(id) as { title: string } | undefined;
    if (!p) throw new MoneyError("no_panel", "No such panel.");
    this.db.prepare("DELETE FROM dashboards WHERE id = ?").run(id);
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'panel_removed', ?, ?)").run(new Date().toISOString(), id, p.title);
  }
}
