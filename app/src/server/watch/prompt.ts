// Reading a hire's permission prompt off its screen: what it wants to do, the question it asks, and the
// answers it offers. Harnesses draw these differently (a boxed dialog with numbered choices, a line
// ending in (y/n)), so this reads the shape, not one harness's exact words. What it reads is only ever
// shown to the operator and answered on their word (or their policy's, for what's plainly safe).

import { createHash } from "node:crypto";

export interface Choice {
  /** What to press to choose it ("1", "y"). */
  keys: string[];
  label: string;
  /** yes: allow once; always: allow and stop asking; no: refuse. */
  kind: "yes" | "always" | "no" | "other";
}

export interface Ask {
  /** The dialog's heading, when it has one ("Bash command", "Edit file"). */
  title: string | null;
  /** What it wants to do, as the screen says it. */
  action: string;
  question: string;
  choices: Choice[];
  /** Paths it names, for "inside its own folder?" */
  paths: string[];
  /** The same prompt reads the same: what a card is about, and what an answer must still be on screen for. */
  fingerprint: string;
}

const BOX = /^[\s│┃║|╭╮╰╯┌┐└┘├┤─━═╔╗╚╝]+|[\s│┃║|╭╮╰╯┌┐└┘├┤─━═╔╗╚╝]+$/g;
const QUESTION = /(do you want to|would you like to|allow\b[^?]*\?|approve\b[^?]*\?|proceed\?|\((y\/n|yes\/no)\)|\[y\/n\])/i;
const NUMBERED = /^(?:[❯>›▶►●*]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
const INLINE = /\((\d)\)\s*([^()]+?)(?=\s*\(\d\)|$)/g;

function kindOf(label: string): Choice["kind"] {
  const l = label.toLowerCase();
  if (/^(no\b|deny|reject|cancel|don't|do not)/.test(l)) return "no";
  if (/^(yes|allow|approve|ok\b|proceed|accept)/.test(l)) return /always|don't ask|do not ask|all\b|session|every|remember/.test(l) ? "always" : "yes";
  return "other";
}

/** The prompt waiting at the bottom of a hire's screen, or null when there isn't one to read. */
export function parsePrompt(screen: string[]): Ask | null {
  const lines = screen.slice(-48).map((l) => l.replace(BOX, ""));
  let q = -1;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 30; i--) {
    if (QUESTION.test(lines[i])) {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  const question = lines[q].trim();

  const choices: Choice[] = [];
  for (let i = q + 1; i < lines.length && choices.length < 9; i++) {
    const m = NUMBERED.exec(lines[i].trim());
    if (m) choices.push({ keys: [m[1]], label: m[2], kind: kindOf(m[2]) });
    else if (choices.length && lines[i].trim() && !/^(esc|enter|↑|tab)/i.test(lines[i].trim())) break;
  }
  // A one-line prompt carries its choices, and often what it wants, on the question line itself.
  let inline = false;
  if (!choices.length) {
    for (const m of question.matchAll(INLINE)) choices.push({ keys: [m[1]], label: m[2].trim(), kind: kindOf(m[2].trim()) });
    inline = choices.length > 0;
  }
  if (!choices.length && /\((y\/n|yes\/no)\)|\[y\/n\]/i.test(question)) {
    // A line prompt: a letter, then Enter.
    choices.push({ keys: ["y", "enter"], label: "Yes", kind: "yes" }, { keys: ["n", "enter"], label: "No", kind: "no" });
  }

  // What it wants to do: the block just above the question, back to a blank line or the box's top.
  const block: string[] = [];
  for (let i = q - 1; i >= 0 && block.length < 24; i--) {
    const t = lines[i].trim();
    if (!t) {
      if (block.length && i > 0 && !lines[i - 1].trim()) break;
      if (block.length) block.unshift("");
      continue;
    }
    block.unshift(t);
    if (/^(bash command|edit file|create file|write|fetch|web fetch|read file|tool use|command|run command|shell)\b/i.test(t)) break;
  }
  while (block.length && !block[0]) block.shift();
  const said = question.replace(INLINE, "").replace(/^[>›❯$#]\s*/, "").trim();
  const ownLine = inline && said.replace(/\b(allow|approve|proceed)\b.*$/i, "").trim().length > 12;
  const title = !ownLine && block.length > 1 && block[0].length <= 40 && !/[`$|;]/.test(block[0]) ? block[0] : null;
  const action = ownLine ? said : (title ? block.slice(1) : block).join("\n").replace(/\n{3,}/g, "\n\n").trim() || question;
  const paths = [...new Set([...`${action}\n${question}`.matchAll(/(?:[A-Za-z]:[\\/]|~\/|\/)[^\s'"`,;)]+|\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|py|rs|go|sql|sh|ps1|toml|yaml|yml|env|txt|csv)\b/g)].map((m) => m[0]))];
  const fingerprint = createHash("sha256").update([title, action, question, ...choices.map((c) => c.label)].join("\u0000")).digest("hex").slice(0, 16);
  return { title, action, question, choices, paths, fingerprint };
}
