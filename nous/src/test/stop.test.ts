// Nous stops when Horos asks, the way Horos asks: a stop file its hook turns into SIGINT inside the
// process (Ctrl+C can't reach a background server on Windows). It closes its store and exits cleanly,
// instead of waiting out Horos's patience and being killed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(here, "..", "main.js");
// As Horos passes it: forward slashes (NODE_OPTIONS reads a backslash inside quotes as an escape).
const HOOK = resolve(here, "..", "..", "..", "horos", "hooks", "graceful-hook.cjs").replaceAll("\\", "/");
const REQUIRE = HOOK.includes(" ") ? `--require "${HOOK}"` : `--require ${HOOK}`;

const freePort = () => new Promise<number>((done) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => done(port));
  });
});

test("Horos's stop file stops Nous cleanly, store closed, exit 0", async () => {
  const home = mkdtempSync(join(tmpdir(), "nous-stop-"));
  const stopFile = join(home, "stop");
  const port = await freePort();
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, NOUS_HOME: home, NOUS_PORT: String(port), OGDOAD_STOP_FILE: stopFile, NODE_OPTIONS: REQUIRE },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  try {
    for (let i = 0; i < 50 && !/Nous on/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    // Unlocked, with a live stream open: the stop has to close that too.
    const token = readFileSync(join(home, "operator.token"), "utf8").trim();
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const unlocked = await fetch(`http://127.0.0.1:${port}/v1/unlock`, { method: "POST", headers: auth, body: JSON.stringify({ key: "ab".repeat(32) }) });
    assert.equal(unlocked.status, 200);
    const co = (await (await fetch(`http://127.0.0.1:${port}/v1/companies`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Stop Co" }) })).json()) as { id: string };
    const stream = new AbortController();
    void fetch(`http://127.0.0.1:${port}/v1/companies/${co.id}/events`, { headers: auth, signal: stream.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    const asked = Date.now();
    writeFileSync(stopFile, "stop");
    const code = await Promise.race([exited, new Promise<"slow">((r) => setTimeout(() => r("slow"), 5000))]);
    stream.abort();
    assert.equal(code, 0, `exited ${code} (${out.trim().split("\n").at(-1)})`);
    assert.ok(Date.now() - asked < 3000, "well inside Horos's patience, not on the fallback");
    assert.match(out, /stopping/);
  } finally {
    child.kill();
  }
});
