// Backups of the books: the encrypted database copied as it stands (VACUUM INTO keeps it encrypted
// under the same key, and every copy is checked), with the vault's wrapped keys beside it, because
// without those even the recovery phrase can't open a copy. Hourly while Ogdoad is open; the last
// day's copies are all kept, then one a day for a month.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { isPlaintextDb, MONEY_DIR } from "./money/db.js";
import type { Money } from "./money/service.js";
import { VAULT_FILE } from "./vault.js";

export const BACKUP_DIR = join(MONEY_DIR, "backups");
const HOURLY_KEEP_MS = 24 * 3_600_000;
const DAILY_KEEP_DAYS = 30;

export interface BackupInfo {
  stamp: string;
  at: string;
  bytes: number;
  /** The vault's wrapped keys were copied with it. */
  withKeys: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
const stampOf = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
const dateOf = (stamp: string) => new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);

/** Copy the books now. Refuses (and removes the copy) if it somehow came out unencrypted. */
export function backupNow(money: Money, opts: { dir?: string; vaultFile?: string; now?: Date } = {}): BackupInfo {
  const dir = opts.dir ?? BACKUP_DIR;
  const vaultFile = opts.vaultFile ?? VAULT_FILE;
  mkdirSync(dir, { recursive: true });
  const stamp = stampOf(opts.now ?? new Date());
  const target = join(dir, `money-${stamp}.db`);
  if (existsSync(target)) unlinkSync(target);
  money.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  if (isPlaintextDb(target)) {
    unlinkSync(target);
    throw new Error("The copy came out unencrypted, so it was thrown away.");
  }
  const withKeys = existsSync(vaultFile);
  if (withKeys) copyFileSync(vaultFile, join(dir, `vault-${stamp}.json`));
  prune(dir, opts.now ?? new Date());
  return { stamp, at: dateOf(stamp).toISOString(), bytes: statSync(target).size, withKeys };
}

export function listBackups(dir = BACKUP_DIR): BackupInfo[] {
  if (!existsSync(dir)) return [];
  const names = new Set(readdirSync(dir));
  return [...names]
    .map((n) => /^money-(\d{8}-\d{6})\.db$/.exec(n)?.[1])
    .filter((s): s is string => !!s)
    .sort()
    .reverse()
    .map((stamp) => ({ stamp, at: dateOf(stamp).toISOString(), bytes: statSync(join(dir, `money-${stamp}.db`)).size, withKeys: names.has(`vault-${stamp}.json`) }));
}

/** Keep every copy from the last day, then the newest copy of each day for a month. */
export function prune(dir: string, now = new Date()): string[] {
  const removed: string[] = [];
  const seenDays = new Set<string>();
  for (const b of listBackups(dir)) {
    const age = now.getTime() - Date.parse(b.at);
    const day = b.stamp.slice(0, 8);
    const keep = age < HOURLY_KEEP_MS || (!seenDays.has(day) && age < DAILY_KEEP_DAYS * 86_400_000);
    seenDays.add(day);
    if (keep) continue;
    for (const f of [`money-${b.stamp}.db`, `vault-${b.stamp}.json`]) {
      if (existsSync(join(dir, f))) unlinkSync(join(dir, f));
    }
    removed.push(b.stamp);
  }
  return removed;
}
