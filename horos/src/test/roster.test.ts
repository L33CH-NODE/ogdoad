// Kept hires survive horos: restored with the same id after a restart, brought back when they
// crash, left to rest when they sign off (until work or the operator wakes them), and closed
// cleanly by a graceful shutdown. The operator hears about every step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Notifier } from "../notify.js";
import { loadRoster, resumeArgsFor } from "../roster.js";
import { planRestart } from "../restart.js";
import { Horos } from "../server.js";

const claudeResume = (id: string) => ["--resume", id];

test("resume args swap --session-id for the harness's resume flag and keep everything else", () => {
  const args = ["--remote-control", "SOPHIA - Co", "--session-id", "abc-123", "--append-system-prompt-file", "SOPHIA.md"];
  assert.deepEqual(resumeArgsFor(claudeResume, args), ["--remote-control", "SOPHIA - Co", "--append-system-prompt-file", "SOPHIA.md", "--resume", "abc-123"]);
  assert.equal(resumeArgsFor(claudeResume, ["--remote-control", "x"]), null, "no session id yet: nothing to resume");
  assert.deepEqual(resumeArgsFor(claudeResume, ["-x"], "reported-id"), ["-x", "--resume", "reported-id"], "a reported session id works too");
  assert.equal(resumeArgsFor(undefined, args), null, "harness can't resume");
});

test("restart plan: /exit rests, crashes back off and resume failures start fresh, a crash loop rests", () => {
  const now = 1_000_000_000;
  assert.deepEqual(planRestart({ exitCode: 0, ranForMs: 60_000, recentRestarts: [], wasResume: true }, now), { action: "rest", why: "signed_off" });
  assert.deepEqual(planRestart({ exitCode: 1, ranForMs: 60_000, recentRestarts: [], wasResume: false }, now), { action: "restart", delayMs: 5_000, fresh: false });
  assert.deepEqual(planRestart({ exitCode: 1, ranForMs: 3_000, recentRestarts: [now - 1000], wasResume: true }, now), { action: "restart", delayMs: 30_000, fresh: true });
  assert.deepEqual(planRestart({ exitCode: 1, ranForMs: 1_000, recentRestarts: [now - 3000, now - 2000, now - 1000], wasResume: false }, now), { action: "rest", why: "gave_up" });
  assert.equal(planRestart({ exitCode: 1, ranForMs: 1_000, recentRestarts: [now - 11 * 60_000, now - 2000, now - 1000], wasResume: false }, now).action, "restart", "old restarts age out");
});

// A stand-in harness: idles at a prompt; "quit" crashes it (exit 3), "/exit" signs off (exit 0).
const IDLER = `process.stdout.write("idler ready\\n> "); process.stdin.on("data", (d) => { const s = String(d); if (s.includes("/exit")) process.exit(0); if (s.includes("quit")) process.exit(3); });`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "horos-roster-"));
  const script = join(dir, "idler.mjs");
  writeFileSync(script, IDLER);
  const notifier = new Notifier();
  const horos = new Horos({ rosterFile: join(dir, "roster.json"), notifier });
  const kinds = () => notifier.list({ limit: 500 }).map((n) => n.kind);
  return { dir, script, rosterFile: join(dir, "roster.json"), notifier, horos, kinds };
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return check();
}

test("a kept hire comes back with the same id after Horos restarts; a released one doesn't", { timeout: 40_000 }, async () => {
  const { dir, script, rosterFile, horos: first } = fixture();
  const kept = first.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, label: "kept one", keep: true });
  const passing = first.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, label: "passing" });
  assert.ok(await kept.waitFor((s) => s === "idle", 10_000));
  assert.deepEqual(loadRoster(rosterFile).map((e) => e.id), [kept.id], "only the kept hire is on the roster");
  first.shutdown();
  assert.equal(passing.state, "exited");
  assert.deepEqual(loadRoster(rosterFile).map((e) => e.id), [kept.id], "stopping Horos keeps the roster");

  const notifier = new Notifier();
  const second = new Horos({ rosterFile, notifier });
  await second.restore();
  const back = second.hires.get(kept.id);
  try {
    assert.ok(back, "restored under the same id");
    assert.ok(await back.waitFor((s) => s === "idle", 10_000));
    assert.match(back.screen().join("\n"), /idler ready/);
    assert.equal(back.label, "kept one");
    assert.match(notifier.list().find((n) => n.kind === "horos_started")?.body ?? "", /Back: kept one/);
    second.release(kept.id);
    assert.equal(back.state, "exited");
    assert.deepEqual(loadRoster(rosterFile), [], "letting it go drops it from the roster");
  } finally {
    second.shutdown();
  }
});

test("a crashed kept hire is restarted, and the operator is told", { timeout: 40_000 }, async () => {
  const { dir, script, horos, kinds } = fixture();
  const hire = horos.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, keep: true });
  try {
    assert.ok(await hire.waitFor((s) => s === "idle", 10_000));
    await hire.prompt("quit");
    assert.ok(await hire.waitFor((s) => s === "exited", 5_000));
    assert.ok(kinds().includes("hire_restarting"), `no restart notice; saw ${kinds().join(",")}`);
    assert.ok(await until(() => horos.hires.get(hire.id) !== hire, 15_000), "never restarted");
    const again = horos.hires.get(hire.id)!;
    assert.ok(await again.waitFor((s) => s === "idle", 10_000));
    assert.ok(kinds().includes("hire_back"));
  } finally {
    horos.shutdown();
  }
});

test("a hire that signs off with /exit rests until it's woken, and isn't restarted", { timeout: 40_000 }, async () => {
  const { dir, script, rosterFile, horos, kinds } = fixture();
  const hire = horos.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, label: "sleepy", keep: true });
  try {
    assert.ok(await hire.waitFor((s) => s === "idle", 10_000));
    await hire.typeLine("/exit");
    assert.ok(await hire.waitFor((s) => s === "exited", 5_000));
    assert.ok(kinds().includes("hire_signed_off"), `saw ${kinds().join(",")}`);
    assert.equal(loadRoster(rosterFile)[0].dormant, true, "marked as resting");
    await new Promise((r) => setTimeout(r, 6_000));
    assert.equal(horos.hires.get(hire.id), hire, "no restart for a clean exit");

    const woken = await horos.wake(hire.id, "work");
    assert.ok(woken && woken !== hire, "woken as a new session");
    assert.ok(await woken.waitFor((s) => s === "idle", 10_000));
    assert.equal(loadRoster(rosterFile)[0].dormant, false, "awake again");
  } finally {
    horos.shutdown();
  }
});

test("graceful shutdown waits for each hire, quits it, and keeps it on the roster", { timeout: 40_000 }, async () => {
  const { dir, script, rosterFile, horos, kinds } = fixture();
  const hire = horos.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, keep: true });
  assert.ok(await hire.waitFor((s) => s === "idle", 10_000));
  await horos.gracefulShutdown({ exitTimeoutMs: 5_000 });
  assert.equal(hire.state, "exited");
  assert.ok(kinds().includes("shutdown_started") && kinds().includes("shutdown_done"), `saw ${kinds().join(",")}`);
  assert.ok(!kinds().includes("hire_restarting") && !kinds().includes("hire_signed_off"), "a shutdown isn't a crash or a sign-off");
  const [entry] = loadRoster(rosterFile);
  assert.equal(entry.id, hire.id);
  assert.notEqual(entry.dormant, true, "it comes back on the next start");
});
