// How a hire is doing, in one word and one colour: the same everywhere a hire appears (the
// constellation, a room's members, a part's lane).

import type { HireInfo, RosterEntry } from "../lib/api";

export const COLOR: Record<string, string> = { working: "var(--c1)", blocked: "var(--warn)", idle: "var(--muted)", done: "var(--good)", starting: "var(--muted)", resting: "var(--idle)", unknown: "var(--idle)" };
export const WORD: Record<string, string> = { working: "working", blocked: "needs you", idle: "idle", done: "finished", starting: "starting", resting: "resting", unknown: "not on Horos" };

/** A hire's state from Horos: live if it's running, resting if it's kept but stopped. */
export function presenceOf(hireId: string | null | undefined, team: HireInfo[], roster: RosterEntry[]): string {
  if (!hireId) return "unknown";
  const live = team.find((h) => h.id === hireId);
  if (live && live.state !== "exited") return live.state;
  return roster.some((r) => r.id === hireId) ? "resting" : "unknown";
}
