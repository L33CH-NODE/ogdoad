// How hot a tile glows in the heat grid: 0 is a quiet day, 1 is as loud as the colour goes. The sign of
// the change picks green or red; this picks how much.

import type { Quote } from "../../lib/markets";

/**
 * What counts as a big day differs by kind: crypto moving 3% is a Tuesday, the ASX 200 moving 3% is
 * news. So each kind is measured against its own "big day" before it's coloured.
 *
 * TODO(operator): this is yours to tune. It works as it stands; the choices worth making are:
 *  - the "big day" per kind (a bigger number makes that kind calmer);
 *  - the curve: a power under 1 lifts small moves so the grid never looks dead, and 1 is honest and linear;
 *  - whether a market that's closed (q.open false, not crypto) should glow less, since its move is yesterday's.
 */
export function heatLevel(q: Quote): number {
  const BIG_DAY: Record<Quote["kind"], number> = { crypto: 6, stock: 3, index: 1.5, fx: 0.8, commodity: 2.5 };
  const pct = Math.abs(q.changePct ?? 0);
  return Math.min(1, Math.pow(pct / BIG_DAY[q.kind], 0.7));
}
