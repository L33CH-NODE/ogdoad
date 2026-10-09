// Who should be SOPHIA? On first launch Ogdoad asks how much the operator trusts the cloud with
// their business, looks at what's installed, and recommends one candidate (the operator can still
// pick another). This file turns the detected inventory into candidates; the recommendation itself
// is a judgement call about privacy versus power.

import type { Inventory, Privacy } from "../harnesses.js";

/** How the operator answered "How much do you trust the cloud with your business?" */
export type Trust =
  | "private" //  nothing leaves this machine
  | "balanced" // cloud is fine for planning, company data stays local
  | "power"; //   use the strongest model available

export interface Candidate {
  /** "harness" = a CLI agent (claude, codex, ...); "local-model" = a model served on this machine. */
  kind: "harness" | "local-model";
  /** Harness id (claude, codex, grok, gemini, opencode, hermes) or the local model's name. */
  id: string;
  name: string;
  privacy: Privacy;
  /** Local models only: size on disk, a rough proxy for capability (bigger is usually smarter). */
  sizeBytes?: number;
  /** Local models only: which runtime serves it. */
  runtime?: "ollama" | "lmstudio";
}

export interface Recommendation {
  pick: Candidate;
  /** One or two sentences shown to the operator: why this one, given their answer. */
  why: string;
}

/** Everything SOPHIA could be on this machine, in no particular order. */
export function candidatesFrom(inventory: Inventory): Candidate[] {
  const harnesses: Candidate[] = inventory.harnesses
    .filter((h) => h.id !== "ollama") // ollama is a runtime; its models are listed below
    .map((h) => ({ kind: "harness", id: h.id, name: h.name, privacy: h.privacy }));
  const models: Candidate[] = inventory.localModels.map((m) => ({
    kind: "local-model",
    id: m.name,
    name: `${m.name} (${m.runtime})`,
    privacy: "local",
    sizeBytes: m.sizeBytes,
    runtime: m.runtime,
  }));
  return [...harnesses, ...models];
}

/**
 * Pick SOPHIA for this operator.
 *
 * TODO(operator): this is the heart of first launch: your call on privacy vs power. Return null only
 * when nothing fits (the wizard then explains what to install). Things to weigh:
 *  - "private" must never pick a `privacy: "cloud"` candidate. Is a bigger local model always
 *    better, or is there a size past which it's too slow on a 4080 shared with other local work?
 *  - "either" harnesses (opencode, hermes) can run local models: do they count as private?
 *  - "power": which cloud CLI do you rank first, and why (claude, codex, grok, gemini)?
 *  - "balanced": what does "planning in the cloud, data local" mean as a pick?
 * The `why` is shown to the operator, so write it the way you'd explain it to a new user.
 */
export function recommendSophia(trust: Trust, candidates: Candidate[]): Recommendation | null {
  // Placeholder until the operator's rules land: the first candidate that doesn't break "private".
  const allowed = trust === "private" ? candidates.filter((c) => c.privacy !== "cloud") : candidates;
  const pick = allowed[0];
  return pick ? { pick, why: "Placeholder pick: the recommendation rules haven't been written yet." } : null;
}
