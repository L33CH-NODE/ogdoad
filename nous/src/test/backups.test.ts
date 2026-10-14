// Nous's backups: encrypted like the store, opened only with its key, kept a day hourly and a month daily.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupNow, prune } from "../backups.js";
import { Engine } from "../engine.js";
import { openStore } from "../store.js";

test("a backup is encrypted under the store's key, and opens with it alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "nous-backup-"));
  const key = randomBytes(32);
  const engine = new Engine(openStore(join(dir, "nous.db"), key));
  const co = engine.createCompany("Backed Up Co");
  const { file } = backupNow(engine.db, join(dir, "backups"));
  assert.notEqual(readFileSync(file).toString("latin1", 0, 15), "SQLite format 3", "not readable as plain SQLite");
  const copy = new Engine(openStore(file, key));
  assert.equal(copy.company(co.id).name, "Backed Up Co");
  assert.throws(() => openStore(file, randomBytes(32)), /didn't open with this key/);
});

test("pruning keeps every copy from the last day, then one a day for a month", () => {
  const dir = mkdtempSync(join(tmpdir(), "nous-prune-"));
  const now = new Date("2026-10-14T12:00:00Z");
  const stamp = (h: number) => {
    const d = new Date(now.getTime() - h * 3_600_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `nous-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.db`;
  };
  // Hourly for the last two days, and one forty days back.
  for (let h = 0; h < 48; h++) writeFileSync(join(dir, stamp(h)), "x");
  writeFileSync(join(dir, stamp(40 * 24)), "x");
  prune(dir, now);
  const left = readdirSync(dir);
  assert.ok(left.includes(stamp(0)) && left.includes(stamp(23)), "the last day, hourly");
  assert.ok(!left.includes(stamp(40 * 24)), "older than a month: gone");
  const olderThanADay = left.filter((f) => ![...Array(25).keys()].some((h) => f === stamp(h)));
  assert.ok(olderThanADay.length <= 2, `one a day beyond the last day (got ${olderThanADay.length})`);
});
