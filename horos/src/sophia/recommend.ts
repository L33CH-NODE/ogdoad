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

/** Cloud harnesses, strongest first for running a company: long careful work, then the rest. */
const CLOUD_ORDER = ["claude", "codex", "grok", "gemini"];
/** Harnesses that can use any provider, local included. */
const EITHER_ORDER = ["opencode", "hermes"];
/** About a 9B model at 4 bits: quick on one consumer graphics card that other local work shares. */
const QUICK_LOCAL_BYTES = 7 * 1024 ** 3;

const STRENGTH: Record<string, string> = {
  claude: "the strongest at long, careful work, and you can reach it from your phone",
  codex: "strong at planning and at code",
  grok: "quick, with a long memory for a conversation",
  gemini: "good with very long documents",
};

/** The biggest local model that stays quick; if every one is bigger, the smallest of them. */
function bestLocal(candidates: Candidate[]): Candidate | null {
  const local = candidates.filter((c) => c.kind === "local-model");
  const quick = local.filter((c) => (c.sizeBytes ?? Infinity) <= QUICK_LOCAL_BYTES).sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  if (quick.length) return quick[0];
  return local.sort((a, b) => (a.sizeBytes ?? Infinity) - (b.sizeBytes ?? Infinity))[0] ?? null;
}

const byOrder = (candidates: Candidate[], order: string[]) =>
  order.map((id) => candidates.find((c) => c.kind === "harness" && c.id === id)).find((c): c is Candidate => !!c) ?? null;

/**
 * Pick SOPHIA for this operator: the operator's rules (2026-10-13).
 *  - private: never anything that can reach the cloud. The biggest local model that stays quick on a
 *    card shared with other local work. opencode and Hermes can use the cloud too, so they're never
 *    recommended here (the operator can still choose one, pointed at a local model).
 *  - power: Claude Code, then Codex, grok, Gemini; then opencode or Hermes; then a local model.
 *  - balanced: the same pick as power. The difference is in her brief: plans in the cloud, while the
 *    membrane keeps the company's data here.
 * Null only when nothing fits; the wizard then explains what to install.
 */
export function recommendSophia(trust: Trust, candidates: Candidate[]): Recommendation | null {
  if (trust === "private") {
    const pick = bestLocal(candidates);
    if (!pick) return null;
    const quick = (pick.sizeBytes ?? Infinity) <= QUICK_LOCAL_BYTES;
    return {
      pick,
      why: quick
        ? `${pick.name} runs on this machine, so your business never leaves it. It's the biggest model you have that stays quick on your graphics card.`
        : `${pick.name} runs on this machine, so your business never leaves it. It's the smallest you have, and still big: replies may be slow.`,
    };
  }
  const cloud = byOrder(candidates, CLOUD_ORDER);
  const pick = cloud ?? byOrder(candidates, EITHER_ORDER) ?? bestLocal(candidates);
  if (!pick) return null;
  const strength = cloud ? `${pick.name}: ${STRENGTH[pick.id]}.` : `${pick.name}: the strongest you have installed.`;
  return {
    pick,
    why: trust === "balanced"
      ? `${strength} She plans in the cloud; your company's data stays here, because the membrane stands real names in before anything leaves, and anything that names someone waits for you.`
      : strength,
  };
}
