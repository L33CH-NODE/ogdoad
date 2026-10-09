// The practice copy: made-up books, a statement that exercises every bank path, and a clean reset.

import { test } from "node:test";
import assert from "node:assert/strict";

import { importStatement } from "../money/bank.js";
import { openMoneyDb } from "../money/db.js";
import { practiceStatement, resetPractice, seedPractice } from "../money/practice.js";
import { Money } from "../money/service.js";

test("practice books fill up, their statement tries every bank path, and reset starts again", () => {
  const money = new Money(openMoneyDb(":memory:"));
  seedPractice(money);
  const invoices = money.invoices();
  assert.ok(invoices.length > 15);
  assert.ok(invoices.some((i) => i.status === "draft"));
  assert.ok(invoices.some((i) => i.bucket === "90+" || i.bucket === "61-90" || i.bucket === "31-60"), "something is late, to practise on");
  assert.equal(money.settings().businessName, "Practice Co");

  const personal = money.accounts().find((a) => a.kind === "personal")!;
  const s = importStatement(money, { accountId: personal.id, csv: practiceStatement(money) }, "practice");
  assert.ok(s.matched >= 2, "named invoices and payer matches record themselves");
  assert.ok(s.suggested >= 1, "an amount alone waits for the operator");
  assert.equal(s.personalDropped, 1);
  assert.equal(s.debitsSkipped, 1);

  resetPractice(money);
  assert.equal((money.db.prepare("SELECT COUNT(*) AS n FROM bank_lines").get() as { n: number }).n, 0);
  assert.equal(money.settings().nextNumber, 501 + money.invoices().filter((i) => i.status === "issued").length);
});
