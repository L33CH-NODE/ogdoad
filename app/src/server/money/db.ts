// The Money database: one SQLite file on the operator's machine, encrypted at rest with a key from the
// vault (SQLCipher format), and migrated forward on open. Without the key the file is unreadable:
// no SQLite header, no plaintext.

import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, unlinkSync } from "node:fs";
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

/** Rows in every table: what an encrypted copy has to match. */
function tableCounts(db: MoneyDb): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, (db.prepare(`SELECT COUNT(*) AS c FROM "${n}"`).get() as { c: number }).c]));
}

/**
 * Finish a first encryption that was interrupted (the plaintext safety copy is still on disk). The
 * encrypted file is kept when it opens with the key and has every row the copy has; otherwise the copy
 * goes back (with any stale journal cleared, so SQLite can't replay it over the copy) and is encrypted
 * again. Either way, no plaintext copy is left behind.
 */
export function settleFirstEncryption(file: string, key: Buffer): void {
  const safety = `${file}.before-key`;
  if (!existsSync(safety)) return;
  let good = false;
  try {
    const plain = new Database(safety, { readonly: true });
    const want = tableCounts(plain);
    plain.close();
    if (!isPlaintextDb(file)) {
      const enc = new Database(file, { readonly: true });
      applyKey(enc, key, "key");
      const got = tableCounts(enc);
      enc.close();
      good = Object.keys(want).length > 0 && Object.keys(want).every((t) => want[t] === got[t]);
    }
  } catch {
    good = false;
  }
  if (!good) {
    for (const ext of ["-journal", "-wal", "-shm"]) if (existsSync(`${file}${ext}`)) unlinkSync(`${file}${ext}`);
    copyFileSync(safety, file);
    unlinkSync(safety);
    encryptExistingDb(file, key);
    return;
  }
  unlinkSync(safety);
}

/**
 * Encrypt an existing plaintext database in place (when the vault is first made). A safety copy is
 * kept until the encrypted file is proven: no plaintext header, it opens with the key, and every
 * table has the same rows. If anything doesn't check out, the books are put back as they were.
 */
export function encryptExistingDb(file: string, key: Buffer): void {
  const db = new Database(file);
  // Fold the write-ahead log in first; rekeying works on a rollback journal, not WAL.
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  const before = tableCounts(db);
  db.close();
  const safety = `${file}.before-key`;
  copyFileSync(file, safety);
  try {
    const plain = new Database(file);
    applyKey(plain, key, "rekey");
    plain.close();
    if (isPlaintextDb(file)) throw new Error("the file is still readable without the key");
    const check = new Database(file, { readonly: true });
    applyKey(check, key, "key");
    const after = tableCounts(check);
    check.close();
    const lost = Object.keys(before).filter((t) => before[t] !== after[t]);
    if (lost.length) throw new Error(`rows differ in ${lost.join(", ")}`);
  } catch (err) {
    copyFileSync(safety, file);
    unlinkSync(safety);
    throw new Error(`Encrypting the books didn't check out (${(err as Error).message}), so they were put back exactly as they were.`);
  }
  unlinkSync(safety);
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
