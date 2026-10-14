// The engine the contract runs against, in homes and ports of its own (never the live ones), kept
// between runs so the next one starts quickly.
//   CONTRACT_ENGINE=paperclip (default): the engine Ogdoad started on, booted by Ogdoad's own installer.
//   CONTRACT_ENGINE=nous: Nous, Ogdoad's own engine, from nous/dist, unlocked with a test key.
//
//   node contract/engine.mjs up | down | status

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const KIND = process.env.CONTRACT_ENGINE ?? "paperclip";
export const HOME = resolve(process.env.OGDOAD_CONTRACT_HOME ?? join(tmpdir(), "ogdoad-contract"));

const paperclip = {
  ports: { engine: 3410, app: 3411, horos: 3412, mailbox: 3413 },
  home: join(HOME, "paperclip"),
  ogdoadHome: join(HOME, "ogdoad"),
};
const nous = { port: 3420, home: join(HOME, "nous") };

export const ENGINE_URL = KIND === "nous" ? `http://127.0.0.1:${nous.port}` : `http://127.0.0.1:${paperclip.ports.engine}`;
export const MAILBOX_URL = KIND === "nous" ? `${ENGINE_URL}/mailbox` : `http://127.0.0.1:${paperclip.ports.mailbox}`;
/** Where the hires' mailbox keys are kept. */
export const KEYS_DIR = KIND === "nous" ? join(nous.home, "keys") : join(paperclip.home, "live-agent", "keys");

/** The operator's token (Nous asks for one; the old engine trusted anything on this machine). */
export function operatorToken() {
  const file = join(nous.home, "operator.token");
  return KIND === "nous" && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

export async function engineUp() {
  try {
    return (await fetch(`${ENGINE_URL}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

const installer = (args) =>
  spawnSync(process.execPath, [join(REPO, "installer", "cli.mjs"), ...args], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, OGDOAD_HOME: paperclip.ogdoadHome, PAPERCLIP_HOME: paperclip.home },
  }).status ?? 1;

async function nousUp() {
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

/** The engine up, ready for the tests. */
export async function up() {
  if (KIND === "nous") return nousUp();
  if (await engineUp()) return;
  const ports = Object.entries(paperclip.ports).flatMap(([k, v]) => [`--${k}-port`, String(v)]);
  if (installer(["--no-sophia", "--no-open", ...ports]) !== 0) throw new Error(`The contract engine didn't come up; see ${join(paperclip.ogdoadHome, "horos", "horos.log")}`);
}

export function down() {
  if (KIND === "nous") {
    const pidFile = join(nous.home, "nous.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")));
      } catch {
        // already gone
      }
    }
    return;
  }
  if (existsSync(join(paperclip.ogdoadHome, "install", "install.json"))) installer(["stop"]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "status";
  if (command === "up") await up();
  else if (command === "down") down();
  await new Promise((r) => setTimeout(r, command === "down" ? 1000 : 0));
  console.log(`contract engine (${KIND}) ${(await engineUp()) ? "up" : "down"} at ${ENGINE_URL} (home ${HOME})`);
}
