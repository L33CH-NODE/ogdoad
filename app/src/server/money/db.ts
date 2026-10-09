// The Money database: one SQLite file on the operator's machine, migrated forward on open.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const OGDOAD_HOME = process.env.OGDOAD_HOME ?? join(homedir(), ".ogdoad");
/** The practice copy points this at its own folder, so it can never touch the real books. */
export const MONEY_DIR = process.env.OGDOAD_MONEY_DIR ?? join(OGDOAD_HOME, "money");
export const MONEY_DB = join(MONEY_DIR, "money.db");

const MIGRATIONS = fileURLToPath(new URL("./migrations/", import.meta.url));

export function openMoneyDb(file = MONEY_DB): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((r) => r.name));
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(MIGRATIONS, name), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`money migration ${name} failed: ${(err as Error).message}`);
    }
  }
}
