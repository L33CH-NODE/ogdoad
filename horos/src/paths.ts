import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OGDOAD_HOME = process.env.OGDOAD_HOME ?? join(homedir(), ".ogdoad");
export const HOROS_DIR = join(OGDOAD_HOME, "horos");
export const TOKEN_FILE = join(HOROS_DIR, "horos.token");
export const DEFAULT_PORT = Number(process.env.OGDOAD_HOROS_PORT ?? 3198);

/** Horos was called herd before 2026-10-09: carry its folder (token, roster, feed, log) over once. */
export function migrateFromHerd(): void {
  const old = join(OGDOAD_HOME, "herd");
  if (!existsSync(old) || existsSync(HOROS_DIR)) return;
  renameSync(old, HOROS_DIR);
  for (const [from, to] of [["herd.token", "horos.token"], ["herd.log", "horos.log"], ["herd.log.1", "horos.log.1"]]) {
    if (existsSync(join(HOROS_DIR, from))) renameSync(join(HOROS_DIR, from), join(HOROS_DIR, to));
  }
}

/** Whether this process has admin rights (Windows). Hires and servers inherit whatever Horos has. */
export function isElevated(): boolean {
  if (process.platform !== "win32") return typeof process.getuid === "function" && process.getuid() === 0;
  const net = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "net.exe");
  return spawnSync(net, ["session"], { stdio: "ignore", windowsHide: true }).status === 0;
}

/** The per-install API token. Created on first use, readable only by this account on Unix. */
export function readOrCreateToken(): string {
  mkdirSync(HOROS_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Windows: the file lives under the user's profile, which only that account (and admins) can read.
  }
  return token;
}
