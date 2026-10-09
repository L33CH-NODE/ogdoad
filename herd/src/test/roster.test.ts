// Kept hires survive herd: restored with the same id after a restart, brought back when their
// session ends on its own, and gone for good once the operator lets them go.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRoster, resumeArgsFor } from "../roster.js";
import { planRestart } from "../restart.js";
import { Herd } from "../server.js";

const claudeResume = (id: string) => ["--resume", id];

test("resume args swap --session-id for the harness's resume flag and keep everything else", () => {
  const args = ["--remote-control", "SOPHIA - Co", "--session-id", "abc-123", "--append-system-prompt-file", "SOPHIA.md"];
  assert.deepEqual(resumeArgsFor(claudeResume, args), ["--remote-control", "SOPHIA - Co", "--append-system-prompt-file", "SOPHIA.md", "--resume", "abc-123"]);
  assert.equal(resumeArgsFor(claudeResume, ["--remote-control", "x"]), null, "no session id yet: nothing to resume");
  assert.deepEqual(resumeArgsFor(claudeResume, ["-x"], "reported-id"), ["-x", "--resume", "reported-id"], "a reported session id works too");
  assert.equal(resumeArgsFor(undefined, args), null, "harness can't resume");
});

test("the default restart plan backs off, gives up after three tries, and starts fresh after a failed resume", () => {
  const now = 1_000_000_000;
  assert.deepEqual(planRestart({ exitCode: 1, ranForMs: 60_000, recentRestarts: [], wasResume: false }, now), { delayMs: 5_000, fresh: false });
  assert.deepEqual(planRestart({ exitCode: 1, ranForMs: 3_000, recentRestarts: [now - 1000], wasResume: true }, now), { delayMs: 30_000, fresh: true });
  assert.equal(planRestart({ exitCode: 1, ranForMs: 1_000, recentRestarts: [now - 3000, now - 2000, now - 1000], wasResume: false }, now), null);
  assert.ok(planRestart({ exitCode: 1, ranForMs: 1_000, recentRestarts: [now - 11 * 60_000, now - 2000, now - 1000], wasResume: false }, now), "old restarts age out");
});

const IDLER = `process.stdout.write("idler ready\\n> "); process.stdin.on("data", (d) => { if (String(d).includes("quit")) process.exit(3); });`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "herd-roster-"));
  const script = join(dir, "idler.mjs");
  writeFileSync(script, IDLER);
  return { dir, script, rosterFile: join(dir, "roster.json") };
}

test("a kept hire comes back with the same id after herd restarts; a released one doesn't", { timeout: 40_000 }, async () => {
  const { dir, script, rosterFile } = fixture();
  const first = new Herd({ rosterFile });
  const kept = first.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, label: "kept one", keep: true });
  const passing = first.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, label: "passing" });
  assert.ok(await kept.waitFor((s) => s === "idle", 10_000));
  assert.deepEqual(loadRoster(rosterFile).map((e) => e.id), [kept.id], "only the kept hire is on the roster");
  first.shutdown();
  assert.equal(passing.state, "exited");
  assert.deepEqual(loadRoster(rosterFile).map((e) => e.id), [kept.id], "stopping herd keeps the roster");

  const second = new Herd({ rosterFile });
  await second.restore();
  const back = second.hires.get(kept.id);
  try {
    assert.ok(back, "restored under the same id");
    assert.ok(await back.waitFor((s) => s === "idle", 10_000));
    assert.match(back.screen().join("\n"), /idler ready/);
    assert.equal(back.label, "kept one");
    second.release(kept.id);
    assert.equal(back.state, "exited");
    assert.deepEqual(loadRoster(rosterFile), [], "letting it go drops it from the roster");
  } finally {
    second.shutdown();
  }
});

test("a kept hire whose session ends on its own is brought back", { timeout: 40_000 }, async () => {
  const { dir, script, rosterFile } = fixture();
  const herd = new Herd({ rosterFile });
  const events: string[] = [];
  const original = herd.broadcast.bind(herd);
  herd.broadcast = (event, data) => {
    events.push(event);
    original(event, data);
  };
  const hire = herd.spawn({ harness: "idler", command: "node", args: [script], cwd: dir, keep: true });
  try {
    assert.ok(await hire.waitFor((s) => s === "idle", 10_000));
    await hire.prompt("quit");
    assert.ok(await hire.waitFor((s) => s === "exited", 5_000));
    assert.ok(events.includes("hire_restarting"), `no restart planned; saw ${events.join(",")}`);
    const deadline = Date.now() + 15_000;
    while (herd.hires.get(hire.id) === hire && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const again = herd.hires.get(hire.id);
    assert.ok(again && again !== hire, "a new session under the same id");
    assert.ok(await again.waitFor((s) => s === "idle", 10_000));
  } finally {
    herd.shutdown();
  }
});
