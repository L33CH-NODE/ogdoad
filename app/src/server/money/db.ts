// The Money database: one SQLite file on the operator's machine, encrypted at rest with a key from the
// vault (SQLCipher format), and migrated forward on open. Without the key the file is unreadable:
// no SQLite header, no plaintext.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3-multiple-ciphers";

export type MoneyDb = Database.Database;

export const OGDOAD_HOME = process.env.OGDOAD_HOME ?? join(homedir(), ".ogdoad");
/** The practice copy points this at its own folder, so it can never touch the real books. */
export const MONEY_DIR = process.env.OGDOAD_MONEY_DIR ?? join(OGDOAD_HOME, "money");
export const MONEY_DB = join(MONEY_DIR, "money.db");

const MIGRATIONS = fileURLToPath(new URL("./migrations/", import.meta.url));

function applyKey(db: MoneyDb, key: Buffer, pragma: "key" | "rekey"): void {
  db.pragma("cipher = 'sqlcipher'");
  db.pragma("legacy = 4");
  db.pragma(`${pragma} = "x'${key.toString("hex")}'"`);
}

/** Open (and migrate) the Money database; with a key, it's the encrypted file. */
export function openMoneyDb(file = MONEY_DB, key?: Buffer): MoneyDb {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (key) applyKey(db, key, "key");
  try {
    db.pragma("foreign_keys = ON");
    if (file !== ":memory:") db.pragma("journal_mode = WAL");
    migrate(db);
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === "SQLITE_NOTADB") throw new Error("The Money database didn't open with this key.");
    throw err;
  }
  return db;
}

/** Whether a database file on disk is plaintext SQLite (an encrypted one has no readable header). */
export function isPlaintextDb(file = MONEY_DB): boolean {
  if (!existsSync(file)) return false;
  const fd = openSync(file, "r");
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  closeSync(fd);
  return head.toString("latin1", 0, 15) === "SQLite format 3";
}

/** Encrypt an existing plaintext database in place (when the vault is first made). */
export function encryptExistingDb(file: string, key: Buffer): void {
  const db = new Database(file);
  // Fold the write-ahead log in first; rekeying works on a rollback journal, not WAL.
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  applyKey(db, key, "rekey");
  db.close();
}

function migrate(db: MoneyDb): void {
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
