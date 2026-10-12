// What the operator should do next. Every open task gets a score; the highest is Now, the next three
// are Next. This is the policy the whole control center leans on (Pulse ranks with it too), so it's
// kept small, pure and in one place, until SOPHIA takes the ranking over.

import type { Task } from "./flow.js";

export interface RankContext {
  now: Date;
  /** Today in the operator's timezone, YYYY-MM-DD. */
  today: string;
}

const DAY = 86_400_000;
const SKIP_HOLD_MS = 4 * 3_600_000;

/**
 * Higher is sooner. The operator chose this weighting (2026-10-13): urgency first, money next.
 *
 * Things to weigh:
 * - Urgency (0 calm to 3 alarm) and blocking (other work waits on this) say how much it matters.
 * - Money at stake, and how overdue it is, say what it costs to leave it.
 * - Age lets a small, old task rise eventually instead of rotting at the bottom.
 * - Focus (you pulled it to Now) and skip (you said "not now") are you overriding the rest.
 */
export function scoreTask(t: Task, ctx: RankContext): number {
  if (t.focusAt) return 10_000 + Date.parse(t.focusAt) / 1e10;
  let score = t.urgency * 100 + (t.blocking ? 60 : 0);
  if (t.cents) score += Math.min(40, Math.log10(t.cents / 100 + 1) * 12);
  if (t.dueOn && t.dueOn < ctx.today) score += Math.min(50, (Date.parse(ctx.today) - Date.parse(t.dueOn)) / DAY);
  score += Math.min(20, ((ctx.now.getTime() - Date.parse(t.createdAt)) / DAY) * 2);
  if (t.skippedAt && ctx.now.getTime() - Date.parse(t.skippedAt) < SKIP_HOLD_MS) score -= 1_000;
  return Math.round(score * 10) / 10;
}
