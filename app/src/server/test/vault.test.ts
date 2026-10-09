// The vault: the password and the phrase both unlock it, nothing else does, and the director key signs
// only with the password given again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openFile, sealFile, Vault, VaultError, verifyDirector } from "../vault.js";

const fresh = () => new Vault(join(mkdtempSync(join(tmpdir(), "vault-")), "vault.json"));
const PW = "correct horse battery";

test("making a vault gives a 24-word phrase once, stores neither it nor the key in the clear", () => {
  const v = fresh();
  const { phrase } = v.create("operator", PW);
  assert.equal(phrase.split(" ").length, 24);
  assert.ok(v.unlocked, "left unlocked after making it");
  const onDisk = readFileSync(v.file, "utf8");
  for (const word of phrase.split(" ").slice(0, 6)) assert.ok(!onDisk.includes(` ${word} `), "the phrase isn't on disk");
  assert.ok(!onDisk.includes(PW));
  assert.throws(() => v.create("operator", PW), (e: VaultError) => e.code === "exists");
});

test("short passwords are refused", () => {
  assert.throws(() => fresh().create("operator", "short"), (e: VaultError) => e.code === "weak_password");
});

test("the password unlocks; a wrong password or login doesn't; locking forgets the key", () => {
  const v = fresh();
  v.create("operator", PW);
  const key = v.key("money db");
  v.lock();
  assert.throws(() => v.key("money db"), (e: VaultError) => e.code === "locked");
  assert.throws(() => v.unlock("operator", "wrong password here"), (e: VaultError) => e.code === "wrong_password");
  assert.throws(() => v.unlock("someone", PW), (e: VaultError) => e.code === "wrong_password");
  v.unlock("operator", PW);
  assert.deepEqual(v.key("money db"), key, "the same data key comes back");
  assert.notDeepEqual(v.key("money pdfs"), key, "each purpose gets its own key");
});

test("the phrase recovers a forgotten password; a wrong or invalid phrase doesn't", () => {
  const v = fresh();
  const { phrase } = v.create("operator", PW);
  const key = v.key("money db");
  v.lock();
  assert.throws(() => v.recover("orbit velvet harbor", "a brand new password"), (e: VaultError) => e.code === "bad_phrase");
  const other = fresh().create("operator", PW).phrase;
  assert.throws(() => v.recover(other, "a brand new password"), (e: VaultError) => e.code === "wrong_phrase");
  v.recover(`  ${phrase.toUpperCase()}  `, "a brand new password");
  assert.deepEqual(v.key("money db"), key);
  v.lock();
  assert.throws(() => v.unlock("operator", PW), "the old password no longer works");
  v.unlock("operator", "a brand new password");
});

test("the director key signs only with the password, and its signature verifies", () => {
  const v = fresh();
  v.create("operator", PW);
  const act = Buffer.from(JSON.stringify({ act: "issue", invoice: "00107" }));
  assert.throws(() => v.signAsDirector("not the password", act), (e: VaultError) => e.code === "wrong_password");
  const { signature, publicKey } = v.signAsDirector(PW, act);
  assert.ok(verifyDirector(publicKey, act, signature));
  assert.ok(!verifyDirector(publicKey, Buffer.from("something else"), signature));
});

test("files sealed at rest open only with their key", () => {
  const v = fresh();
  v.create("operator", PW);
  const path = join(mkdtempSync(join(tmpdir(), "sealed-")), "Invoice 00107.pdf.sealed");
  sealFile(path, Buffer.from("%PDF synthetic"), v.key("money pdfs"));
  assert.ok(!readFileSync(path, "utf8").includes("synthetic"));
  assert.equal(openFile(path, v.key("money pdfs")).toString(), "%PDF synthetic");
  assert.throws(() => openFile(path, v.key("money db")));
});

test("an existing plaintext Money database is encrypted in place, with nothing lost", async () => {
  const { openMoneyDb, encryptExistingDb, isPlaintextDb } = await import("../money/db.js");
  const { Money } = await import("../money/service.js");
  const file = join(mkdtempSync(join(tmpdir(), "money-enc-")), "money.db");
  const plain = new Money(openMoneyDb(file));
  plain.createAccount({ label: "Business", kind: "business", bankName: "Sample Bank", accountName: "Sample Co", bsb: "111111", accountNumber: "87654321" }, "op");
  plain.db.close();
  assert.ok(isPlaintextDb(file));

  const v = fresh();
  v.create("operator", PW);
  encryptExistingDb(file, v.key("money db"));
  assert.ok(!isPlaintextDb(file), "no readable header any more");
  assert.ok(!readFileSync(file).includes(Buffer.from("87654321")), "the account number isn't on disk in the clear");
  assert.throws(() => openMoneyDb(file), /didn't open|not a database|NOTADB/i, "unreadable without the key");
  const opened = new Money(openMoneyDb(file, v.key("money db")));
  assert.equal(opened.accounts()[0].accountNumber, "87654321", "everything is still there with the key");
  opened.db.close();
});
