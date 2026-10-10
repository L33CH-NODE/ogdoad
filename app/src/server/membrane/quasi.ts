// Hints, not identities: an age, a condition, a place. None names anyone alone, so none is replaced,
// but together they can point to one person (a 34-year-old with autism in a small town), so they're
// shown to the operator on the check card, and enough of them together hold a message for a look.

export type QuasiKind = "age" | "condition" | "place";

export interface Flag {
  start: number;
  end: number;
  text: string;
  /** maybe-name: a word that may be someone's name; ambiguous: a first name more than one person has. */
  kind: QuasiKind | "maybe-name" | "ambiguous";
  why: string;
}

/**
 * Do these hints together point to one person closely enough that the message waits for a look?
 *
 * Every hint is listed on the check card either way; this decides whether hints alone (with nothing
 * stood in) hold a message, and whether the card warns that they add up. Too eager, and every planning
 * chat that mentions a suburb stops at the check; too relaxed, and "the 34-year-old with autism in
 * Kingscliff" goes out because no name was in it.
 *
 * kinds: which of age, condition and place appear in the message (each counts once).
 */
export function quasiWarning(kinds: ReadonlySet<QuasiKind>): boolean {
  // TODO(operator): your rule. The default: any two kinds together.
  return kinds.size >= 2;
}

const CONDITION_WORDS = [
  "autism", "autistic", "intellectual disability", "cerebral palsy", "multiple sclerosis", "epilepsy", "epileptic", "seizures", "down syndrome", "down's syndrome",
  "dementia", "alzheimer's", "alzheimers", "parkinson's", "parkinsons", "acquired brain injury", "brain injury", "spinal cord injury", "quadriplegia", "quadriplegic",
  "paraplegia", "paraplegic", "schizophrenia", "schizoaffective", "bipolar", "psychosis", "psychosocial disability", "borderline personality", "depression",
  "anxiety disorder", "eating disorder", "anorexia", "bulimia", "diabetes", "diabetic", "hepatitis", "cancer", "stroke", "muscular dystrophy", "motor neurone disease",
  "deafness", "hearing impairment", "vision impairment", "legally blind", "developmental delay", "fetal alcohol", "tourette", "tourette's", "dyspraxia", "rett syndrome",
  "fragile x", "spina bifida", "hydrocephalus", "amputee", "amputation", "stoma", "tracheostomy", "peg feed", "addiction", "alcoholism",
];
/** Acronyms count only in capitals ("add" is a word; "ADD" isn't one here). */
const CONDITION_ACRONYMS = ["ASD", "ADHD", "ABI", "BPD", "PTSD", "OCD", "HIV", "MND", "FASD"];

/** A condition as a pattern: spaces and apostrophes as they're typed. */
const conditionSource = (w: string) => w.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/'/g, "['’]").replace(/ /g, "[\\s-]+");

const PATTERNS: Array<{ kind: QuasiKind; re: RegExp; why: string; group?: number }> = [
  { kind: "age", re: /\b(?:aged?\s*:?\s*\d{1,3}|\d{1,3}[\s-]*(?:years?|yrs?)[\s-]*old|\d{1,3}\s*(?:yo|y\/o|y\.o\.))(?![\w])/gi, why: "an age" },
  { kind: "condition", re: new RegExp(`\\b(?:${CONDITION_WORDS.map(conditionSource).join("|")})(?![\\w])`, "gi"), why: "a health condition" },
  { kind: "condition", re: new RegExp(`\\b(?:${CONDITION_ACRONYMS.join("|")})\\b`, "g"), why: "a health condition" },
  { kind: "place", re: /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2},?\s+(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b(?:\s+\d{4})?/g, why: "a place" },
  { kind: "place", re: /\b(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}\b/g, why: "a place" },
  { kind: "place", re: /\b(?:lives|living|lived|resides|residing|based|located|grew up)\s+(?:in|at|near)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})/dg, group: 1, why: "a place" },
];

/** The hints in the text, outside the spans already taken. */
export function findQuasi(text: string, taken: Array<[number, number]> = []): Flag[] {
  const out: Flag[] = [];
  const claimed = [...taken];
  const free = (s: number, e: number) => !claimed.some(([a, b]) => s < b && e > a);
  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const g = p.group ?? 0;
      const value = m[g];
      if (!value) continue;
      const start = g ? m.indices![g][0] : m.index!;
      const end = start + value.length;
      if (!free(start, end)) continue;
      claimed.push([start, end]);
      out.push({ start, end, text: value, kind: p.kind, why: p.why });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
