// What Horos does when a kept hire's session ends on its own: a crash, the harness quitting, or
// someone typing /exit in the hire's terminal (or over Remote Control). Hires the operator lets go
// of (`kill`) and hires stopped with Horos itself never come through here. Every outcome is
// reported to the operator; this only decides what happens next.

export interface ExitFacts {
  /** The harness's exit code; null when it was killed by a signal. */
  exitCode: number | null;
  /** How long the session ran before it ended. */
  ranForMs: number;
  /** When Horos restarted this hire before, newest last (epoch ms). */
  recentRestarts: number[];
  /** Whether the session that just ended was a resume of an earlier one. */
  wasResume: boolean;
}

export type RestartPlan =
  /** Start it again after a pause; fresh = a new session with the brief re-delivered. */
  | { action: "restart"; delayMs: number; fresh: boolean }
  /** Leave it down. Its seat keeps listening, so assigned work starts it again. */
  | { action: "rest"; why: "signed_off" | "gave_up" };

/**
 * The operator's rules (the operator, 2026-10-09):
 * - A clean exit (/exit) means the hire meant to stop: it stays down, and comes back only when a
 *   task is assigned to it.
 * - A crash restarts it, resumed; if a resume dies within 20 s the old session is likely gone, so
 *   the next try starts fresh.
 * - Three restarts in ten minutes is a crash loop: it rests until work arrives.
 */
export function planRestart(f: ExitFacts, now = Date.now()): RestartPlan {
  if (f.exitCode === 0) return { action: "rest", why: "signed_off" };
  const window = f.recentRestarts.filter((t) => now - t < 10 * 60_000);
  if (window.length >= 3) return { action: "rest", why: "gave_up" };
  return { action: "restart", delayMs: [5_000, 30_000, 120_000][window.length], fresh: f.wasResume && f.ranForMs < 20_000 };
}
