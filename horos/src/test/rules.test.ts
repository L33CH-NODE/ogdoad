import { test } from "node:test";
import assert from "node:assert/strict";

import { bottomNonEmpty, classify, matches, rulesFor } from "../rules.js";

const view = (text: string, title = "") => ({ lines: text.split("\n"), title });

test("claude: status line while running tools reads as working", () => {
  const rule = classify(rulesFor("claude"), view("● Reading files…\n\n  ✻ Pondering… (12s · esc to interrupt)\n"));
  assert.equal(rule?.state, "working");
});

test("claude: a permission dialog outranks the working status line", () => {
  const screen = "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n  ✻ Waiting… (esc to interrupt)";
  assert.equal(classify(rulesFor("claude"), view(screen))?.state, "blocked");
});

test("claude: an empty prompt box with the shortcuts footer is idle", () => {
  const screen = "╭────────────╮\n│ >          │\n╰────────────╯\n  ? for shortcuts";
  assert.equal(classify(rulesFor("claude"), view(screen))?.state, "idle");
});

test("claude 2.1.x: a selection menu is blocked even though the idle footer is visible", () => {
  const screen = [
    "✻ Churned for 2s · done 3:22 PM",
    "  Teach auto mode about your environment?",
    "  ❯ 1. Yes",
    "    2. Not now",
    "    3. Don't show again",
    "  Enter to confirm · Esc to cancel",
    "❯ ",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 3 agents",
  ].join("\n");
  assert.equal(classify(rulesFor("claude"), view(screen))?.state, "blocked");
});

test("claude 2.1.x: the permission-mode footer marks an idle prompt", () => {
  const screen = "────────\n❯ Try \"refactor <filepath>\"\n────────\n  ⏵⏵ auto mode on (shift+tab to cycle)";
  assert.equal(classify(rulesFor("claude"), view(screen))?.state, "idle");
});

test("generic yes/no prompts are blocked for any harness", () => {
  assert.equal(classify(rulesFor("some-new-cli"), view("Overwrite config? (y/n)"))?.state, "blocked");
  assert.equal(classify(rulesFor("grok"), view("Apply changes [Y/n]"))?.state, "blocked");
});

test("an unrecognised screen matches no rule (the activity fallback decides)", () => {
  assert.equal(classify(rulesFor("claude"), view("hello world")), null);
});

test("patterns: substrings are case-insensitive, /regex/ works, none excludes", () => {
  assert.ok(matches({ any: ["ESC TO INTERRUPT"] }, "… esc to interrupt)"));
  assert.ok(matches({ any: ["/\\bapprove\\b.*\\?/"] }, "Approve this change?"));
  assert.ok(!matches({ any: ["? for shortcuts"], none: ["esc to interrupt"] }, "? for shortcuts · esc to interrupt"));
});

test("bottom region skips blank lines at the end of the screen", () => {
  assert.deepEqual(bottomNonEmpty(["a", "b", "", "c", "", ""], 2), ["b", "c"]);
});
