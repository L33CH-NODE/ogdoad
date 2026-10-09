// Detection rules: how herd tells, from what a hire's terminal shows, whether it is working,
// waiting on a decision (blocked), or idle. Rules are data so they can be tested and updated as
// harnesses change their UI. These are Ogdoad's own; the shape follows Herdr's rule engine
// (regions, any/all/none, priority), credited in NOTICE.

export type HireState = "starting" | "working" | "blocked" | "idle" | "done" | "exited";
export type DetectedState = "working" | "blocked" | "idle";

/** Where on the screen a rule looks: the bottom N lines, the whole screen, or the window title. */
export type Region = { bottom: number } | "screen" | "title";

/**
 * Patterns are case-insensitive substrings, or regular expressions written as "/source/flags".
 * A rule matches when ANY of `any` (if given), ALL of `all` (if given), and NONE of `none` match.
 */
export interface Match {
  any?: string[];
  all?: string[];
  none?: string[];
}

export interface Rule {
  state: DetectedState;
  priority: number;
  region: Region;
  match: Match;
  note?: string;
}

const GENERIC: Rule[] = [
  {
    state: "blocked",
    priority: 90,
    // Only the last non-empty line: line-based CLIs leave answered questions in scrollback, and a
    // live question always sits where the cursor waits. Full-screen TUIs get their own wider rules.
    region: { bottom: 1 },
    match: { any: ["/\\((y\\/n|yes\\/no)\\)\\s*$/i", "/\\[y\\/n\\]\\s*$/i", "press enter to continue", "/continue\\?\\s*$/i"] },
    note: "classic yes/no and press-enter prompts, still unanswered",
  },
];

/** Built-in rules per harness id. Unknown harnesses get only the generic rules plus the activity fallback. */
export const BUILTIN_RULES: Record<string, Rule[]> = {
  claude: [
    {
      state: "blocked",
      priority: 100,
      region: { bottom: 24 },
      match: {
        any: [
          "do you want to proceed?",
          "do you want to make this edit",
          "do you want to create",
          "do you want to allow",
          "would you like to proceed?",
        ],
      },
      note: "permission and plan-approval dialogs",
    },
    { state: "working", priority: 80, region: { bottom: 8 }, match: { any: ["esc to interrupt"] }, note: "status line while thinking or running tools" },
    { state: "idle", priority: 50, region: { bottom: 6 }, match: { any: ["? for shortcuts"], none: ["esc to interrupt"] }, note: "empty prompt box footer" },
    ...GENERIC,
  ],
  codex: [
    { state: "blocked", priority: 100, region: { bottom: 20 }, match: { any: ["allow command?", "approve this", "/\\bapprove\\b.*\\?/i"] }, note: "command approval" },
    { state: "working", priority: 80, region: { bottom: 8 }, match: { any: ["esc to interrupt"] } },
    ...GENERIC,
  ],
  grok: [{ state: "working", priority: 80, region: { bottom: 8 }, match: { any: ["esc to interrupt", "esc to cancel"] } }, ...GENERIC],
  opencode: [{ state: "working", priority: 80, region: { bottom: 8 }, match: { any: ["esc to interrupt", "esc interrupt"] } }, ...GENERIC],
  gemini: [{ state: "working", priority: 80, region: { bottom: 8 }, match: { any: ["esc to cancel"] } }, ...GENERIC],
  generic: GENERIC,
};

export function rulesFor(harness: string): Rule[] {
  return BUILTIN_RULES[harness] ?? GENERIC;
}

function compile(pattern: string): (text: string) => boolean {
  const re = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  if (re) {
    const regex = new RegExp(re[1], re[2].includes("i") ? re[2] : re[2] + "i");
    return (text) => regex.test(text);
  }
  const needle = pattern.toLowerCase();
  return (text) => text.toLowerCase().includes(needle);
}

const cache = new Map<string, (text: string) => boolean>();
function test(pattern: string, text: string): boolean {
  let fn = cache.get(pattern);
  if (!fn) cache.set(pattern, (fn = compile(pattern)));
  return fn(text);
}

export function matches(match: Match, text: string): boolean {
  if (match.any && !match.any.some((p) => test(p, text))) return false;
  if (match.all && !match.all.every((p) => test(p, text))) return false;
  if (match.none && match.none.some((p) => test(p, text))) return false;
  return Boolean(match.any || match.all);
}

export interface ScreenView {
  /** Visible screen lines, top to bottom, trailing spaces trimmed. */
  lines: string[];
  title: string;
}

/** The highest-priority rule that matches the screen, or null. */
export function classify(rules: Rule[], view: ScreenView): Rule | null {
  let best: Rule | null = null;
  for (const rule of rules) {
    if (best && rule.priority <= best.priority) continue;
    const text =
      rule.region === "title" ? view.title
      : rule.region === "screen" ? view.lines.join("\n")
      : bottomNonEmpty(view.lines, rule.region.bottom).join("\n");
    if (matches(rule.match, text)) best = rule;
  }
  return best;
}

/** The last `n` non-empty lines, so a half-empty screen still has a meaningful "bottom". */
export function bottomNonEmpty(lines: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) if (lines[i].trim()) out.unshift(lines[i]);
  return out;
}
