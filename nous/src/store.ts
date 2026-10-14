// Nous's store: one SQLCipher file, opened only with the key the app hands over on unlock. Plain
// tables, plain rows; the rules live in engine.ts.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";

export type Db = Database.Database;

/** Each step runs once, in order, and is recorded; a step is never edited once it has shipped. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'working', 'paused', 'let_go')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX members_company ON members(company_id);
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT NOT NULL,
    brief TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    lead_id TEXT REFERENCES members(id),
    color TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX rooms_company ON rooms(company_id);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    room_id TEXT REFERENCES rooms(id),
    parent_id TEXT REFERENCES tasks(id),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    assignee_id TEXT REFERENCES members(id),
    for_operator INTEGER NOT NULL DEFAULT 0,
    author_id TEXT REFERENCES members(id),
    held_by_run TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (company_id, number)
  );
  CREATE INDEX tasks_company ON tasks(company_id, updated_at);
  CREATE INDEX tasks_room ON tasks(room_id);
  CREATE INDEX tasks_assignee ON tasks(assignee_id);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    author_id TEXT REFERENCES members(id),
    run_id TEXT,
    body TEXT NOT NULL,
    request_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, request_id)
  );
  CREATE INDEX messages_task ON messages(task_id, created_at);
  CREATE TABLE docs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    key TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'markdown',
    body TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    author_id TEXT REFERENCES members(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, key)
  );
  `,
  // Cards, approvals, and runs: the work loop.
  `
  ALTER TABLE members ADD COLUMN mailbox_key_hash TEXT;
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL,
    title TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'withdrawn')),
    author_id TEXT REFERENCES members(id),
    run_id TEXT,
    answer TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX cards_task ON cards(task_id, status);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    note TEXT,
    requested_by TEXT REFERENCES members(id),
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX approvals_company ON approvals(company_id, status);
  CREATE TABLE approval_tasks (
    approval_id TEXT NOT NULL REFERENCES approvals(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (approval_id, task_id)
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    task_id TEXT REFERENCES tasks(id),
    reason TEXT NOT NULL,
    wake TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    job_id TEXT,
    token_hash TEXT,
    lease_until TEXT,
    claims INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    error TEXT,
    log TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX runs_member ON runs(member_id, status, created_at);
  CREATE INDEX runs_company ON runs(company_id, status);
  CREATE UNIQUE INDEX runs_token ON runs(token_hash) WHERE token_hash IS NOT NULL;
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    created_at TEXT NOT NULL
  );
  `,
];

function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS migrations (step INTEGER PRIMARY KEY, at TEXT NOT NULL)");
  const done = new Set((db.prepare("SELECT step FROM migrations").all() as Array<{ step: number }>).map((r) => r.step));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i + 1)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (step, at) VALUES (?, ?)").run(i + 1, new Date().toISOString());
    })();
  });
}

/** Open (creating if new) and migrate the store. With ":memory:" and no key it's a plain test store. */
export function openStore(file: string, key?: Buffer): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  if (key) {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("legacy = 4");
    db.pragma(`key = "x'${key.toString("hex")}'"`);
  }
  try {
    db.pragma("foreign_keys = ON");
    if (file !== ":memory:") db.pragma("journal_mode = WAL");
    migrate(db);
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === "SQLITE_NOTADB") throw new Error("Nous's store didn't open with this key.");
    throw err;
  }
  return db;
}
