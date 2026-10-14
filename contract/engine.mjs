// The engine the contract runs against. Today that's Paperclip, booted by Ogdoad's own installer
// into homes and ports of its own (never the live ones): the installer's isolated mode, kept between
// runs so only the first boot pays for the engine download. Later it's Ogdoad's own engine.
//
//   node contract/engine.mjs up | down | status

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = resolve(process.env.OGDOAD_CONTRACT_HOME ?? join(tmpdir(), "ogdoad-contract"));
export const PORTS = { engine: 3410, app: 3411, horos: 3412, mailbox: 3413 };
export const ENGINE_URL = `http://127.0.0.1:${PORTS.engine}`;
export const MAILBOX_URL = `http://127.0.0.1:${PORTS.mailbox}`;
export const HOROS_URL = `http://127.0.0.1:${PORTS.horos}`;
/** Where the engine keeps its home: the live-agent keys are under it. */
export const PAPERCLIP_HOME = join(HOME, "paperclip");
export const OGDOAD_HOME = join(HOME, "ogdoad");

const env = () => ({ ...process.env, OGDOAD_HOME, PAPERCLIP_HOME });
const installer = (args) =>
  spawnSync(process.execPath, [join(REPO, "installer", "cli.mjs"), ...args], { stdio: ["ignore", "inherit", "inherit"], env: env() }).status ?? 1;

export async function engineUp() {
  try {
    return (await fetch(`${ENGINE_URL}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** The engine up (set up the first time), the live-agent adapter installed, ready for the tests. */
export async function up() {
  if (await engineUp()) return;
  const ports = Object.entries(PORTS).flatMap(([k, v]) => [`--${k}-port`, String(v)]);
  if (installer(["--no-sophia", "--no-open", ...ports]) !== 0) throw new Error(`The contract engine didn't come up; see ${join(OGDOAD_HOME, "horos", "horos.log")}`);
}

export function down() {
  if (!existsSync(join(OGDOAD_HOME, "install", "install.json"))) return;
  installer(["stop"]);
}

/** The key the mailbox expects from a live agent, made by the engine (or SOPHIA's wizard) per agent. */
export function agentKey(agentId) {
  return readFileSync(join(PAPERCLIP_HOME, "live-agent", "keys", `${agentId}.key`), "utf8").trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? "status";
  if (command === "up") await up();
  else if (command === "down") down();
  console.log(`contract engine ${(await engineUp()) ? "up" : "down"} at ${ENGINE_URL} (home ${HOME})`);
}
