// Backups of the books, on made-up data: a copy stays encrypted under the same key (and opens with
// it), the vault's wrapped keys go beside it, and the last day plus one a day for a month are kept.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupNow, listBackups, prune } from "../backup.js";
import { isPlaintextDb, openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";

function books() {
  const dir = mkdtempSync(join(tmpdir(), "ogdoad-backup-"));
  const key = randomBytes(32);
  const m = new Money(openMoneyDb(join(dir, "money.db"), key));
  m.createClient({ name: "Harbour Plan Managers" }, "operator");
  const vaultFile = join(dir, "vault.json");
  writeFileSync(vaultFile, JSON.stringify({ wrapped: "made-up" }));
  return { dir, key, m, vaultFile, backups: join(dir, "backups") };
}

test("a backup stays encrypted under the same key, and the vault's keys go with it", () => {
  const { key, m, vaultFile, backups } = books();
  const b = backupNow(m, { dir: backups, vaultFile });
  const file = join(backups, `money-${b.stamp}.db`);
  assert.ok(existsSync(file));
  assert.equal(isPlaintextDb(file), false, "no readable header");
  assert.equal(b.withKeys, true);
  assert.ok(existsSync(join(backups, `vault-${b.stamp}.json`)));
  const copy = new Money(openMoneyDb(file, key));
  assert.deepEqual(copy.clients().map((c) => c.name), ["Harbour Plan Managers"], "and it opens with the key");
  copy.db.close();
  assert.throws(() => openMoneyDb(file, randomBytes(32)), /didn't open with this key/);
  assert.equal(listBackups(backups)[0].stamp, b.stamp);
});

test("the last day's copies are all kept, then the newest of each day for a month", () => {
  const { m, vaultFile, backups } = books();
  const now = new Date("2026-10-10T12:00:00Z");
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000);
  for (const h of [1, 5, 23, 30, 31, 24 * 3, 24 * 3 + 2, 24 * 40]) backupNow(m, { dir: backups, vaultFile, now: at(h) });
  const removed = prune(backups, now);
  const kept = listBackups(backups).map((b) => b.at);
  // 30 and 31 hours ago fall on the same day as 23 hours ago, which is already kept.
  assert.equal(kept.length, 4, `kept ${kept.join(", ")}`);
  assert.ok(kept.includes(at(1).toISOString()) && kept.includes(at(23).toISOString()), "everything from the last day");
  assert.ok(kept.includes(at(24 * 3).toISOString()) && !kept.includes(at(24 * 3 + 2).toISOString()), "the newest of an older day");
  assert.ok(!kept.includes(at(24 * 40).toISOString()), "nothing past a month");
  assert.ok(removed.length >= 1);
  assert.equal(readdirSync(backups).filter((f) => f.startsWith("vault-")).length, 4, "keys go when their copy goes");
});
