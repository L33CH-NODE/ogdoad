// What herd does when a kept hire's session ends on its own: a crash, the harness quitting, or
// someone typing /exit in the hire's terminal (or over Remote Control). Hires the operator lets go
// of (`kill`) and hires stopped with herd itself never come through here.

export interface ExitFacts {
  /** The harness's exit code; null when it was killed by a signal. */
  exitCode: number | null;
  /** How long the session ran before it ended. */
  ranForMs: number;
  /** When herd restarted this hire before, newest last (epoch ms). */
  recentRestarts: number[];
  /** Whether the session that just ended was a resume of an earlier one. */
  wasResume: boolean;
}

export interface RestartPlan {
  /** Wait this long, then start the hire again. */
  delayMs: number;
  /** Start a fresh session (brief re-delivered) instead of resuming the old one. */
  fresh: boolean;
}

/**
 * Decide whether to bring a kept hire back, and how. Return null to leave it down; herd then tells
 * the operator (event "hire_gave_up") and the hire stays in the roster for the next herd start.
 *
 * TODO(operator): this is yours to shape. The default below restarts up to 3 times in 10 minutes
 * (5 s, 30 s, 2 min apart), and starts fresh when a resume dies within 20 s (the old session is
 * probably gone). Things to weigh: should a clean exit (code 0, someone typed /exit) count as "the
 * operator meant it" and stay down? Should a CEO seat retry harder than a worker seat?
 */
export function planRestart(f: ExitFacts, now = Date.now()): RestartPlan | null {
  const window = f.recentRestarts.filter((t) => now - t < 10 * 60_000);
  if (window.length >= 3) return null;
  return { delayMs: [5_000, 30_000, 120_000][window.length], fresh: f.wasResume && f.ranForMs < 20_000 };
}
