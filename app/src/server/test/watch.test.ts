// The watch, against a stand-in Horos (no real hire is read or answered): prompts are read off made-up
// screens in each harness's shape, sorted by risk, held for the operator, and answered only into the
// very same prompt. The policy answers by itself only when turned on, and never a kind on the floor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";
import { decide } from "../watch/policy.js";
import { parsePrompt } from "../watch/prompt.js";
import { classify } from "../watch/risk.js";
import { raisedFromWatch, Watch } from "../watch/watch.js";

const BOXED = (cmd: string, why: string) => [
  "  some earlier output",
  "╭──────────────────────────────────────────────╮",
  "│ Bash command                                 │",
  "│                                              │",
  `│   ${cmd.padEnd(43)}│`,
  `│   ${why.padEnd(43)}│`,
  "│                                              │",
  "│ Do you want to proceed?                      │",
  "│ ❯ 1. Yes                                     │",
  "│   2. Yes, and don't ask again for this       │",
  "│   3. No, and tell me what to do differently  │",
  "╰──────────────────────────────────────────────╯",
];

test("prompts are read in each harness's shape", () => {
  const a = parsePrompt(BOXED("rm -rf build", "Clear the old build"))!;
  assert.equal(a.title, "Bash command");
  assert.equal(a.action, "rm -rf build\nClear the old build");
  assert.equal(a.question, "Do you want to proceed?");
  assert.deepEqual(a.choices.map((c) => [c.keys[0], c.kind]), [["1", "yes"], ["2", "always"], ["3", "no"]]);
  // The selection marker moving doesn't make it a different prompt.
  assert.equal(parsePrompt(BOXED("rm -rf build", "Clear the old build").map((l) => l.replace("❯ 1", "  1").replace("  2.", "❯ 2.")))!.fingerprint, a.fingerprint);

  const yn = parsePrompt(["Working…", "git push origin main", "Allow command? (y/n)"])!;
  assert.deepEqual(yn.choices.map((c) => [c.keys.join("+"), c.kind]), [["y+enter", "yes"], ["n+enter", "no"]]);
  assert.match(yn.action, /git push origin main/);

  const inline = parsePrompt(["  ✓ brief read", "> wants to open a public website: allow? (1) yes (2) no"])!;
  assert.deepEqual(inline.choices.map((c) => [c.keys[0], c.kind]), [["1", "yes"], ["2", "no"]]);
  assert.equal(inline.action, "wants to open a public website: allow?", "a one-line prompt says what it wants on its own line");
  assert.deepEqual(classify(inline).kinds, ["web"], "the prompt's own > isn't a file being written");

  assert.equal(parsePrompt(["all done", "> "]), null, "no prompt, no card");
});

test("risk is sorted plainly, and the floor is the floor", () => {
  const kinds = (action: string, title = "Bash command") => classify({ title, action, question: "Do you want to proceed?" });
  assert.deepEqual(kinds("rm -rf build").kinds, ["destructive"]);
  assert.ok(kinds("rm -rf build").high);
  assert.deepEqual(kinds("git push origin main").kinds, ["outward"]);
  assert.deepEqual(kinds("cat .env").kinds, ["secrets"]);
  assert.deepEqual(kinds("npm install left-pad").kinds, ["installs"]);
  assert.deepEqual(kinds("curl -X POST https://example.org/hook -d @report.json").kinds.sort(), ["outward", "web"]);
  assert.deepEqual(kinds("ls -la src").kinds, ["reads"]);
  assert.equal(kinds("ls -la src").high, false);
  assert.deepEqual(kinds("node scripts/build.mjs").kinds, ["runs"]);
  assert.deepEqual(kinds("echo done > status.txt").kinds, ["writes"]);
  assert.deepEqual(kinds("npm test 2>&1 | tail -5").kinds, ["runs"]);
  assert.deepEqual(classify({ title: "Edit file", action: "src/app.ts", question: "Do you want to make this edit to app.ts?" }).kinds, ["writes"]);
});

test("the default policy lets through only reading inside the hire's own folder", () => {
  const hire = { label: "Scout", harness: "claude", where: "cloud", cwd: process.platform === "win32" ? "C:\\seats\\scout" : "/seats/scout" };
  const read = parsePrompt(BOXED("ls notes", "List the notes"))!;
  assert.equal(decide(read, classify(read), hire).allow, true);
  const outside = parsePrompt(BOXED(process.platform === "win32" ? "cat C:\\other\\notes.md" : "cat /other/notes.md", "Read someone else's notes"))!;
  assert.equal(decide(outside, classify(outside), hire).allow, false);
  const rm = parsePrompt(BOXED("rm notes.md", "Tidy up"))!;
  assert.equal(decide(rm, classify(rm), hire).allow, false);
});

/** A stand-in Horos: hires, their screens, and the keys pressed (a pressed choice clears the prompt). */
async function fakeHoros(screens: Record<string, string[]>) {
  const pressed: Array<{ id: string; keys: string[] }> = [];
  const hires = Object.keys(screens).map((id) => ({ id, label: `${id} - Claude Code`, harness: "claude", state: "blocked", cwd: "/seats/x", role: "hire" }));
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => {
      const send = (body: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url!, "http://x");
      let m: RegExpExecArray | null;
      if (url.pathname === "/v1/hires") return send(hires);
      if ((m = /^\/v1\/hires\/([^/]+)\/screen$/.exec(url.pathname))) return send({ lines: screens[m[1]] ?? [] });
      if ((m = /^\/v1\/hires\/([^/]+)\/keys$/.exec(url.pathname))) {
        const keys = JSON.parse(raw).keys as string[];
        pressed.push({ id: m[1], keys });
        screens[m[1]] = ["  done", "> "];
        const h = hires.find((x) => x.id === m![1]);
        if (h) h.state = "working";
        return send({ ok: true });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { link: { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers: () => ({}) }, pressed, hires, screens, close: () => server.close() };
}

test("the watch holds what a hire asks, answers only into the same prompt, and a risky yes takes a second yes", async () => {
  const h = await fakeHoros({ builder: BOXED("rm -rf build", "Clear the old build"), scout: BOXED("ls notes", "List the notes") });
  try {
    const money = new Money(openMoneyDb(":memory:"));
    const watch = new Watch(money, h.link);
    assert.equal(await watch.tick(), true);
    const asks = watch.list();
    assert.deepEqual(asks.map((a) => [a.hireLabel, a.risk.kinds[0], a.verdict.allow]).sort(), [["builder", "destructive", false], ["scout", "reads", true]]);
    const cards = raisedFromWatch(money);
    assert.ok(cards.some((c) => c.title === "builder wants to delete or overwrite something" && c.urgency === 3));
    assert.equal(h.pressed.length, 0, "nothing is answered by itself while answering is off, even what the policy allows");
    assert.equal(await watch.tick(), false, "the same prompt is the same card");

    const rm = asks.find((a) => a.hireId === "builder")!;
    await assert.rejects(() => watch.answer(rm.id, "allow"), /Allow it again/);
    // It moved on in its terminal: nothing is pressed into whatever's there now.
    const before = h.screens.builder;
    h.screens.builder = BOXED("rm -rf dist", "Something else");
    await assert.rejects(() => watch.answer(rm.id, "allow", true), /isn't asking that any more/);
    assert.equal(h.pressed.length, 0);
    h.screens.builder = before;
    await watch.tick();
    const again = watch.list().find((a) => a.hireId === "builder" && a.state === "open")!;
    const answered = await watch.answer(again.id, "deny");
    assert.equal(answered.state, "answered");
    assert.deepEqual(h.pressed.at(-1), { id: "builder", keys: ["3"] });
    const labels = money.db.prepare("SELECT detail FROM events WHERE kind = 'watch_answered'").all() as Array<{ detail: string }>;
    assert.deepEqual(JSON.parse(labels[0].detail), { hire: "builder", harness: "claude", kinds: ["destructive"], policy: false, answer: "deny", by: "you" });

    // A hire that stopped waiting takes its card with it.
    h.hires.find((x) => x.id === "scout")!.state = "working";
    await watch.tick();
    assert.equal(watch.list().find((a) => a.hireId === "scout")!.state, "gone");
  } finally {
    h.close();
  }
});

test("with answering on, the policy answers what it allows, and never a kind on the floor", async () => {
  const h = await fakeHoros({ reader: BOXED("ls notes", "List the notes"), pusher: BOXED("git push origin main", "Ship it") });
  try {
    const money = new Money(openMoneyDb(":memory:"));
    const watch = new Watch(money, h.link);
    // Its own folder, so the read is inside it.
    h.hires.forEach((x) => (x.cwd = process.cwd()));
    watch.setAuto(true);
    await watch.tick();
    const reader = watch.list().find((a) => a.hireId === "reader")!;
    assert.equal(reader.state, "answered");
    assert.equal(reader.answeredBy, "policy");
    assert.deepEqual(h.pressed, [{ id: "reader", keys: ["1"] }]);
    assert.equal(watch.list().find((a) => a.hireId === "pusher")!.state, "open", "pushing always waits for the operator");
  } finally {
    h.close();
  }
});
