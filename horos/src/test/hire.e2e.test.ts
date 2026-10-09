// End to end on a real PTY (ConPTY on Windows): a fake harness that idles at a prompt, works,
// asks a yes/no question, then finishes. Horos should follow it through every state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hire } from "../hire.js";

const FAKE_HARNESS = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write("fake harness ready\\n> ");
let awaitingAnswer = false;
rl.on("line", async (line) => {
  if (awaitingAnswer) {
    awaitingAnswer = false;
    process.stdout.write(line.trim() === "y" ? "applied. done.\\n> " : "skipped.\\n> ");
    return;
  }
  if (line.trim() === "work") {
    for (let i = 0; i < 12; i++) { process.stdout.write("thinking " + i + "\\n"); await new Promise((r) => setTimeout(r, 120)); }
    process.stdout.write("Apply the change? (y/n) ");
    awaitingAnswer = true;
  }
});
`;

test("Horos follows a hire: idle -> working -> blocked -> done -> idle -> exited", { timeout: 40_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "horos-e2e-"));
  const script = join(dir, "fake-harness.mjs");
  writeFileSync(script, FAKE_HARNESS);

  const hire = new Hire({ harness: "fakebot", file: process.execPath, args: [script], cwd: dir });
  const seen: string[] = [];
  hire.on("state", (s: string) => seen.push(s));

  try {
    assert.ok(await hire.waitFor((s) => s === "idle", 10_000), `never idle; saw ${seen.join(",")}`);
    assert.match(hire.screen().join("\n"), /fake harness ready/);

    await hire.prompt("work");
    assert.ok(await hire.waitFor((s) => s === "working", 5_000), `never working; saw ${seen.join(",")}`);
    assert.ok(await hire.waitFor((s) => s === "blocked", 8_000), `never blocked; saw ${seen.join(",")}`);
    await assert.rejects(() => hire.prompt("more"), /waiting on a decision/);

    hire.keys(["y", "enter"]);
    assert.ok(await hire.waitFor((s) => s === "done", 8_000), `never done; saw ${seen.join(",")}`);
    assert.match(hire.read(20).join("\n"), /applied\. done\./);
    assert.equal(hire.state, "idle", "reading the result acknowledges it");
  } finally {
    hire.kill();
  }
  assert.equal(hire.state, "exited");
});
