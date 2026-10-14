// Which engine the app is on, and how it signs its calls. On Nous (OGDOAD_ENGINE=nous), every call the
// app makes or proxies carries the operator's token, and the app hands Nous its key when the vault
// opens. The engine Ogdoad started on trusted anything from this machine and needs neither.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OGDOAD_HOME } from "./money/db.js";

export const ENGINE = process.env.OGDOAD_ENGINE === "nous" ? "nous" : "paperclip";
export const NOUS_HOME = process.env.OGDOAD_NOUS_HOME ?? join(OGDOAD_HOME, "nous");
const TOKEN_FILE = join(NOUS_HOME, "operator.token");

let token: string | null = null;

/** The headers that make a call the operator's (none on the old engine). */
export function engineAuth(): Record<string, string> {
  if (ENGINE !== "nous") return {};
  if (!token && existsSync(TOKEN_FILE)) token = readFileSync(TOKEN_FILE, "utf8").trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Nous's state: up or not, locked or not. */
export async function nousState(serverUrl: string): Promise<{ up: boolean; locked: boolean }> {
  try {
    const r = await fetch(`${serverUrl}/v1/health`, { signal: AbortSignal.timeout(2000) });
    const h = (await r.json()) as { locked?: boolean };
    return { up: r.ok, locked: h.locked !== false };
  } catch {
    return { up: false, locked: true };
  }
}

/** Hand Nous its key (once the vault is open). Nous keeps it until it stops: "after first unlock". */
export async function handNousKey(serverUrl: string, key: Buffer): Promise<boolean> {
  if (ENGINE !== "nous") return false;
  try {
    const r = await fetch(`${serverUrl}/v1/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json", ...engineAuth() },
      body: JSON.stringify({ key: key.toString("hex") }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
