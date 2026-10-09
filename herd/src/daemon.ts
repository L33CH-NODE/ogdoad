// Run herd as a background service, independent of whatever terminal started it. Its hires live
// inside it, so herd must outlive the window (or the agent session) that launched it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT, HERD_DIR } from "./paths.js";

export const LOG_FILE = join(HERD_DIR, "herd.log");
const HERD_CLI = fileURLToPath(new URL("./cli.js", import.meta.url));
const LOG_ROLL_BYTES = 5 * 1024 * 1024;

export async function herdUp(port = DEFAULT_PORT): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** Start `herd serve` detached, logging to herd.log. Resolves with its pid once it answers. */
export async function startDetached(port = DEFAULT_PORT): Promise<{ pid: number | null; already: boolean }> {
  if (await herdUp(port)) return { pid: null, already: true };
  mkdirSync(HERD_DIR, { recursive: true });
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_ROLL_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [HERD_CLI, "serve", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    cwd: HERD_DIR,
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await herdUp(port)) return { pid: child.pid ?? null, already: false };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`herd didn't start; see ${LOG_FILE}`);
}
