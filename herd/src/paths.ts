import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OGDOAD_HOME = process.env.OGDOAD_HOME ?? join(homedir(), ".ogdoad");
export const HERD_DIR = join(OGDOAD_HOME, "herd");
export const TOKEN_FILE = join(HERD_DIR, "herd.token");
export const DEFAULT_PORT = Number(process.env.OGDOAD_HERD_PORT ?? 3198);

/** The per-install API token. Created on first use, readable only by this account on Unix. */
export function readOrCreateToken(): string {
  mkdirSync(HERD_DIR, { recursive: true });
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
