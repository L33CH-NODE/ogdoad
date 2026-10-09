// The operator's feed: everything is recorded, repeats are folded, bursts become one toast, and
// status flips arrive as a digest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Notifier } from "../notify.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the feed persists, counts unread (not pulses), and survives a restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "herd-notify-")), "notifications.jsonl");
  const a = new Notifier({ file });
  a.push({ level: "error", kind: "hire_down", title: "SOPHIA is down", body: "x" });
  a.push({ level: "pulse", kind: "status", title: "SOPHIA idle", body: "" });
  a.push({ level: "info", kind: "job_done", title: "SOPHIA finished a job", body: "y" });
  assert.equal(a.unread(), 2);
  a.markRead(1);
  assert.equal(a.unread(), 1);

  const b = new Notifier({ file });
  assert.deepEqual(b.list().map((n) => n.id), [1, 2, 3]);
  assert.equal(b.unread(), 1, "read state survives too");
  assert.equal(b.push({ level: "info", kind: "k", title: "t", body: "" })!.id, 4, "ids carry on");
});

test("a repeat within its window is folded until cleared", () => {
  const n = new Notifier();
  const down = { level: "error" as const, kind: "mailbox_down", title: "Can't reach the mailbox", body: "", dedupeKey: "mailbox:a", dedupeMs: 60_000 };
  assert.ok(n.push(down));
  assert.equal(n.push(down), null);
  assert.ok(n.clear("mailbox:a"));
  assert.ok(n.push(down));
});

test("a burst becomes one toast led by the worst, and pulses arrive as a digest", async () => {
  const toasts: Array<[string, string]> = [];
  const n = new Notifier({ toast: (t, b) => toasts.push([t, b]), pulseDigestMs: 300 });
  n.push({ level: "info", kind: "a", title: "Ledger picked up work", body: "" });
  await sleep(50);
  assert.equal(toasts.length, 1, "the first goes out at once");
  n.push({ level: "info", kind: "b", title: "Scout finished a job", body: "" });
  n.push({ level: "error", kind: "c", title: "SOPHIA is down", body: "crashed" });
  n.push({ level: "pulse", kind: "status", title: "Ledger working", body: "", hireId: "l" });
  n.push({ level: "pulse", kind: "status", title: "Ledger idle", body: "", hireId: "l" });
  n.push({ level: "pulse", kind: "status", title: "Scout working", body: "", hireId: "s" });
  await sleep(1700);
  n.close();
  const burst = toasts.filter((t) => t[0] !== "Team pulse").slice(1);
  assert.equal(burst.length, 1, "the burst is one toast");
  assert.equal(burst[0][0], "SOPHIA is down", "the error leads the burst");
  assert.match(burst[0][1], /Also: Scout finished a job/);
  const pulse = toasts.find((t) => t[0] === "Team pulse");
  assert.deepEqual(pulse?.[1], "Ledger idle · Scout working", "latest state per hire");
});
