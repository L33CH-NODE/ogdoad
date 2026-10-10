// Runs panel queries in a process of its own, on a sealed in-memory database of the curated tables,
// so a runaway query can be killed without touching the app. It reads one message, answers, and exits.

import Database from "better-sqlite3-multiple-ciphers";

import type { CuratedTable } from "./curated.js";

interface Job { tables: CuratedTable[]; queries: string[]; limit: number }
export type RunResult = { ok: true; columns: string[]; rows: unknown[][] } | { ok: false; error: string };

process.once("message", (job: Job) => {
  const db = new Database(":memory:");
  for (const t of job.tables) {
    db.exec(`CREATE TABLE ${t.name} (${t.columns.map((c) => `"${c}"`).join(", ")})`);
    const insert = db.prepare(`INSERT INTO ${t.name} VALUES (${t.columns.map(() => "?").join(", ")})`);
    db.transaction(() => {
      for (const r of t.rows) insert.run(...(r as unknown[]));
    })();
  }
  db.pragma("query_only = ON");
  const results: RunResult[] = job.queries.map((sql) => {
    try {
      const stmt = db.prepare(sql);
      if (!stmt.reader) return { ok: false, error: "A panel's query has to be a SELECT." };
      const columns = stmt.columns().map((c) => c.name);
      const rows: unknown[][] = [];
      for (const r of stmt.raw().iterate() as Iterable<unknown[]>) {
        rows.push(r.map((v) => (typeof v === "bigint" ? Number(v) : v)));
        if (rows.length >= job.limit) break;
      }
      return { ok: true, columns, rows };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  process.send!(results, () => process.exit(0));
});
