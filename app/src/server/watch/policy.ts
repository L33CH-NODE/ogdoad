// The operator's policy for the watch: which of a hire's requests may be answered "yes, once" without
// asking them. It only ever suggests until the operator turns answering on (Settings › The watch), and
// even then it can never let through a kind on the floor (ALWAYS_ASK: deleting, sending out, spending,
// investing, secrets, starting agents). Every card shows what the policy would have done, so its
// judgement can be watched against the operator's own before it's trusted with anything.

import { isAbsolute, relative, resolve } from "node:path";

import type { Ask } from "./prompt.js";
import type { Risk } from "./risk.js";

export interface HireFacts {
  label: string;
  harness: string;
  /** cloud, local, either or unknown (the crossings' word for it). */
  where: string;
  /** The hire's own folder. */
  cwd: string | null;
}

export interface Verdict {
  allow: boolean;
  why: string;
}

/** Is a path the prompt names inside the hire's own folder? A bare file name is taken as inside it. */
export function inside(path: string, cwd: string | null): boolean {
  if (!cwd) return false;
  const p = path.replace(/^~[\\/]/, "");
  if (!isAbsolute(p) && !/^[A-Za-z]:/.test(p)) return !p.startsWith("..");
  const rel = relative(resolve(cwd), resolve(p));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Would the operator say "yes, once" to this without being asked?
 *
 * ask: the prompt as read off the screen (its action, its question, the paths it names).
 * risk: the kinds of risk in it (risk.kinds), each with why (risk.reasons); risk.high means a kind on
 * the floor, which is held whatever this says.
 * hire: who asks (its harness, cloud or local, its own folder).
 *
 * Trade-offs: every "yes" here is a decision nobody looked at. Too strict, and every `ls` waits for you;
 * too loose, and a cloud hire reads a client export because "reading is harmless". (For a cloud hire,
 * reading a file means sending it to the cloud.)
 */
export function decide(ask: Ask, risk: Risk, hire: HireFacts): Verdict {
  // TODO(operator): your rule. The default lets through only reading, inside the hire's own folder.
  if (risk.kinds.every((k) => k === "reads") && ask.paths.every((p) => inside(p, hire.cwd))) {
    return { allow: true, why: "it only reads, inside its own folder" };
  }
  return { allow: false, why: "it does more than read inside its own folder" };
}
