// The roster: hires herd brings back after it restarts (a reboot, a crash, the operator closing
// a window). Each kept hire is saved with how to start it again: resumed where the harness can
// pick its own session back up (Claude Code, Codex), otherwise fresh with its brief re-delivered.
// Seats are saved with their hire, so jobs keep flowing to the same agent.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HERD_DIR } from "./paths.js";

export const ROSTER_FILE = join(HERD_DIR, "roster.json");

export interface RosterEntry {
  /** The hire id, kept across restarts so seats and saved state still point at it. */
  id: string;
  harness: string;
  /** The command the hire was spawned from (unresolved), when it wasn't a known harness. */
  command?: string;
  cwd: string;
  label?: string;
  env?: Record<string, string>;
  /** Args for a fresh start. */
  args: string[];
  /** Args that pick the harness's own session back up; null when it can't resume. */
  resumeArgs: string[] | null;
  /** Re-delivered on a fresh start, so a hire that can't resume still knows its role. */
  brief?: string;
  seat?: { agentId: string; mailbox?: string };
  keptAt: string;
}

export function loadRoster(file = ROSTER_FILE): RosterEntry[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRoster(entries: RosterEntry[], file = ROSTER_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  // Write then rename, so a crash mid-write never leaves a half roster behind.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Turn a fresh-start argv into one that resumes the same session. A hire started with its own
 * session id (`--session-id <uuid>` for Claude Code) resumes by that id; otherwise there's
 * nothing to resume yet and the hire must report its session id first.
 */
export function resumeArgsFor(harnessResume: ((id: string) => string[]) | undefined, args: string[], sessionId?: string | null): string[] | null {
  if (!harnessResume) return null;
  const i = args.indexOf("--session-id");
  const id = sessionId ?? (i >= 0 ? args[i + 1] : undefined);
  if (!id) return null;
  const rest = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  return [...rest, ...harnessResume(id)];
}
