import { test } from "node:test";
import assert from "node:assert/strict";

import { ACTIVITY_WINDOW_MS, IDLE_CONFIRM_CAP_MS, STARTUP_GRACE_MS, Stabilizer } from "../detector.js";
import type { Rule } from "../rules.js";

const blocked: Rule = { state: "blocked", priority: 100, region: { bottom: 5 }, match: { any: ["(y/n)"] } };
const idleChrome: Rule = { state: "idle", priority: 50, region: { bottom: 5 }, match: { any: ["? for shortcuts"] } };

test("startup grace: a hire is 'starting' for the first 3 s, even when quiet", () => {
  const s = new Stabilizer(0);
  assert.equal(s.observe({ now: 1000, rule: null, lastOutputAt: 0 }), "starting");
  assert.equal(s.observe({ now: STARTUP_GRACE_MS + 10, rule: idleChrome, lastOutputAt: 0 }), "idle");
});

test("startup output doesn't count as work: a quiet hire after startup is idle, not done", () => {
  const s = new Stabilizer(0);
  s.observe({ now: 500, rule: null, lastOutputAt: 400 });
  assert.equal(s.observe({ now: STARTUP_GRACE_MS + 2000, rule: null, lastOutputAt: 400 }), "idle");
});

test("output means working; silence settles to done after confirmation; reading it makes it idle", () => {
  const s = new Stabilizer(0);
  let t = STARTUP_GRACE_MS + 100;
  assert.equal(s.observe({ now: t, rule: null, lastOutputAt: t }), "working");
  t += ACTIVITY_WINDOW_MS + 10; // quiet now
  assert.equal(s.observe({ now: t, rule: null, lastOutputAt: t - ACTIVITY_WINDOW_MS - 10 }), "working"); // 1st idle check
  assert.ok(s.confirming);
  t += 100;
  assert.equal(s.observe({ now: t, rule: null, lastOutputAt: 0 }), "working"); // 2nd
  t += 100;
  assert.equal(s.observe({ now: t, rule: null, lastOutputAt: 0 }), "done"); // 3rd: settled
  s.acknowledge();
  assert.equal(s.state, "idle");
});

test("visible idle chrome settles at once, without confirmations", () => {
  const s = new Stabilizer(0);
  const t = STARTUP_GRACE_MS + 100;
  s.observe({ now: t, rule: null, lastOutputAt: t });
  assert.equal(s.observe({ now: t + ACTIVITY_WINDOW_MS + 10, rule: idleChrome, lastOutputAt: t }), "done");
});

test("the 700 ms cap settles idle even if checks come slowly", () => {
  const s = new Stabilizer(0);
  let t = STARTUP_GRACE_MS + 100;
  s.observe({ now: t, rule: null, lastOutputAt: t });
  t += ACTIVITY_WINDOW_MS + 10;
  s.observe({ now: t, rule: null, lastOutputAt: 0 });
  assert.equal(s.observe({ now: t + IDLE_CONFIRM_CAP_MS, rule: null, lastOutputAt: 0 }), "done");
});

test("blocked comes only from a rule, and wins over a self-report", () => {
  const s = new Stabilizer(0);
  const t = STARTUP_GRACE_MS + 100;
  s.acceptReport({ state: "working", source: "hook", seq: 1, at: t });
  assert.equal(s.observe({ now: t, rule: blocked, lastOutputAt: 0 }), "blocked");
});

test("a self-report outranks screen reading, and stale reports are ignored", () => {
  const s = new Stabilizer(0);
  const t = STARTUP_GRACE_MS + 100;
  assert.ok(s.acceptReport({ state: "working", source: "hook", seq: 5, at: t }));
  assert.ok(!s.acceptReport({ state: "idle", source: "hook", seq: 4, at: t }));
  assert.equal(s.observe({ now: t, rule: idleChrome, lastOutputAt: 0 }), "working");
});
