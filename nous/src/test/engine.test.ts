// Nous's rules, below the HTTP layer, on a throwaway store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { Engine, prefixFor, type Who } from "../engine.js";
import { openStore } from "../store.js";

const operator: Who = { kind: "operator" };
const fresh = () => new Engine(openStore(":memory:"));

test("identifiers: three letters from the company's name, then a number that only goes up", () => {
  assert.equal(prefixFor("Probe Co"), "PRO");
  assert.equal(prefixFor("  42 - "), "OGD");
  const e = fresh();
  const co = e.createCompany("Sample Plan Managers");
  const a = e.createTask(co.id, { title: "One" }, operator);
  const b = e.createTask(co.id, { title: "Two" }, operator);
  assert.deepEqual([a.identifier, b.identifier], ["SAM-1", "SAM-2"]);
});

test("a hire acts only within its own company: another company's tasks are 'not found'", () => {
  const e = fresh();
  const mine = e.createCompany("Mine");
  const theirs = e.createCompany("Theirs");
  const hire = e.createMember(mine.id, { name: "Hire" });
  const secret = e.createTask(theirs.id, { title: "Theirs only" }, operator);
  const asHire: Who = { kind: "member", memberId: hire.id, companyId: mine.id, runId: "run-1" };
  assert.throws(() => e.task(secret.id, asHire), /No such task/);
  assert.throws(() => e.tasks(theirs.id, {}, asHire), /No such company/);
  assert.throws(() => e.say(secret.id, "hello", asHire), /No such task/);
  // And it can't hand another company's member a task of its own company.
  const stranger = e.createMember(theirs.id, { name: "Stranger" });
  assert.throws(() => e.createTask(mine.id, { title: "x", assigneeId: stranger.id }, asHire), /another company/);
});

test("a hire's message and task are its own: authored by it, on its run", () => {
  const e = fresh();
  const co = e.createCompany("Co");
  const hire = e.createMember(co.id, { name: "Hire" });
  const asHire: Who = { kind: "member", memberId: hire.id, companyId: co.id, runId: "run-7" };
  const t = e.createTask(co.id, { title: "Mine" }, asHire);
  assert.equal(t.authorId, hire.id);
  const m = e.say(t.id, "Hello", asHire);
  assert.deepEqual([m.authorId, m.runId], [hire.id, "run-7"]);
  assert.equal(e.tasks(co.id, { assignee: "me" }, asHire).length, 0, "made by it isn't assigned to it");
});

test("the store opens only with its key", () => {
  const file = join(mkdtempSync(join(tmpdir(), "nous-store-")), "nous.db");
  const key = randomBytes(32);
  openStore(file, key).close();
  assert.doesNotThrow(() => openStore(file, key).close());
  assert.throws(() => openStore(file, randomBytes(32)), /didn't open with this key/);
});
