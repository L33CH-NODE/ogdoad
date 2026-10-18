// The engine the contract runs against: Nous, from nous/dist, in a home and port of its own (never the
// live ones), unlocked with a test key, and kept between runs so the next one starts quickly.
//
//   node contract/engine.mjs up | down | status

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = resolve(process.env.OGDOAD_CONTRACT_HOME ?? join(tmpdir(), "ogdoad-contract"));

const nous = { port: 3420, home: join(HOME, "nous") };

export const ENGINE_URL = `http://127.0.0.1:${nous.port}`;
export const MAILBOX_URL = `${ENGINE_URL}/mailbox`;
/** Where the hires' mailbox keys are kept. */
export const KEYS_DIR = join(nous.home, "keys");

/** The operator's token: being on this machine isn't enough for Nous. */
export function operatorToken() {
  const file = join(nous.home, "operator.token");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

export async function engineUp() {
  try {
    return (await fetch(`${ENGINE_URL}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** The engine up, ready for the tests. */
export async function up() {
  mkdirSync(nous.home, { recursive: true });
  if (!(await engineUp())) {
    if (!existsSync(join(REPO, "nous", "dist", "main.js"))) throw new Error("Build Nous first: npm --prefix nous run build");
    const log = openSync(join(nous.home, "nous.log"), "a");
    const child = spawn(process.execPath, [join(REPO, "nous", "dist", "main.js")], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
      env: { ...process.env, NOUS_HOME: nous.home, NOUS_PORT: String(nous.port) },
    });
    child.unref();
    writeFileSync(join(nous.home, "nous.pid"), String(child.pid));
    for (let i = 0; i < 60 && !(await engineUp()); i++) await new Promise((r) => setTimeout(r, 250));
    if (!(await engineUp())) throw new Error(`Nous didn't start; see ${join(nous.home, "nous.log")}`);
  }
  // The key the app would hand over on unlock: one per contract home, so restarts reopen the same store.
  const keyFile = join(nous.home, "test.key");
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("hex"));
  const res = await fetch(`${ENGINE_URL}/v1/unlock`, {
    method: "POST",
    headers: { authorization: `Bearer ${operatorToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ key: readFileSync(keyFile, "utf8").trim() }),
  });
  if (!res.ok) throw new Error(`Nous wouldn't unlock: ${res.status} ${await res.text()}`);
}

export function down() {
  const pidFile = join(nous.home, "nous.pid");
  if (existsSync(pidFile)) {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")));
    } catch {
      // already gone
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "status";
  if (command === "up") await up();
  else if (command === "down") down();
  await new Promise((r) => setTimeout(r, command === "down" ? 1000 : 0));
  console.log(`contract engine (Nous) ${(await engineUp()) ? "up" : "down"} at ${ENGINE_URL} (home ${HOME})`);
}
