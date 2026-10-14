// Nous's backups: the encrypted store copied as it stands (VACUUM INTO keeps it encrypted under the
// same key), each copy checked to be encrypted, or it's removed. Hourly while Nous is unlocked; the
// last day's copies are all kept, then one a day for a month. A copy opens only with the key the
// vault derives for Nous, so the operator's recovery phrase is what ultimately opens it.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "./store.js";

const HOURLY_KEEP_MS = 24 * 3_600_000;
const DAILY_KEEP_DAYS = 30;

const pad = (n: number) => String(n).padStart(2, "0");
const stampOf = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const dateOf = (stamp: string) => new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);

function plaintext(file: string): boolean {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(16);
  readSync(fd, head, 0, 16, 0);
  closeSync(fd);
  return head.toString("latin1", 0, 15) === "SQLite format 3";
}

/** Copy the store now. Refuses (and removes the copy) if it somehow came out readable. */
export function backupNow(db: Db, dir: string, now = new Date()): { file: string; bytes: number } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `nous-${stampOf(now)}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  if (plaintext(file)) {
    unlinkSync(file);
    throw new Error("A backup came out unencrypted, so it was removed. Nothing readable was left on disk.");
  }
  return { file, bytes: statSync(file).size };
}

/** Keep every copy from the last day, then the newest copy of each day for a month. */
export function prune(dir: string, now = new Date()): number {
  if (!existsSync(dir)) return 0;
  const copies = readdirSync(dir).map((f) => /^nous-(\d{8}-\d{6})\.db$/.exec(f)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ file: m[0], at: dateOf(m[1]) })).sort((a, b) => b.at.getTime() - a.at.getTime());
  const keptDays = new Set<string>();
  let removed = 0;
  for (const c of copies) {
    const age = now.getTime() - c.at.getTime();
    if (age <= HOURLY_KEEP_MS) continue;
    const day = c.at.toISOString().slice(0, 10);
    if (age <= DAILY_KEEP_DAYS * 86_400_000 && !keptDays.has(day)) {
      keptDays.add(day);
      continue;
    }
    unlinkSync(join(dir, c.file));
    removed++;
  }
  return removed;
}
