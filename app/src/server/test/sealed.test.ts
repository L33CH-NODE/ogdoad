// Sealing: the construction checked against an independent implementation's test vectors (the framing
// in vectors/, and the full set when the operator keeps it locally), then the engine's backups sealed,
// checked and only then cleared.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha3_256 } from "@noble/hashes/sha3.js";

import { frame, generateKeyPair, open, openBackup, padme, sealBackup, sealWith, unwrap } from "../sealed.js";
import { SealedBackups } from "../sealedBackups.js";

const PUBLIC = JSON.parse(readFileSync(fileURLToPath(new URL("../../../src/server/test/vectors/seal-v1-vectors.json", import.meta.url)), "utf8"));
/** The full vectors (seal and wrap, with fixed nonces), when this machine keeps them. */
const FULL_FILE = process.env.OGDOAD_CONFORMANCE ?? join(homedir(), ".ogdoad", "conformance", "seal-v1-vectors.json");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);
const plaintext = (n: number) => bytes(n, (i) => 7 * i + 3);

test("seal v1: PADMÉ and the framing match the independent vectors", () => {
  for (const v of PUBLIC.padme) {
    assert.equal(padme(v.framed_len), v.padded_len, `padme(${v.framed_len})`);
    if (v.padded_hex) assert.equal(hex(frame(plaintext(v.len))), v.padded_hex, `frame(${v.len})`);
  }
});

test("seal v1: seal and wrap match the independent vectors byte for byte, with Ogdoad's own prefixes", () => {
  for (const v of PUBLIC.seal) {
    const aad = new TextEncoder().encode(v.aad_utf8);
    const wire = sealWith(Buffer.from(v.key_hex, "hex"), plaintext(v.plaintext_len), aad, Buffer.from(v.nonce_hex, "hex"));
    assert.equal(wire.length, v.wire_len);
    if (v.wire_hex) assert.equal(hex(wire), v.wire_hex, `seal(${v.plaintext_len})`);
    if (v.wire_sha3_256) assert.equal(hex(sha3_256(wire)), v.wire_sha3_256, `seal(${v.plaintext_len})`);
    assert.equal(hex(open(Buffer.from(v.key_hex, "hex"), wire, aad)), hex(plaintext(v.plaintext_len)));
  }
  for (const w of PUBLIC.wrap) {
    const kek = Buffer.from(w.kek_hex, "hex");
    const wire = sealWith(kek, Buffer.from(w.key_hex, "hex"), new TextEncoder().encode(w.aad_utf8), Buffer.from(w.nonce_hex, "hex"));
    assert.equal(hex(wire), w.wire_hex);
    // Ogdoad's own unwrap reads it: the same prefix, the same construction.
    assert.equal(hex(unwrap(kek, wire, w.context_utf8)), w.key_hex);
    assert.throws(() => unwrap(kek, wire, "backup:another"));
  }
});

test("seal v1: an earlier vector set kept on this machine matches too", { skip: !existsSync(FULL_FILE) && "no local vector file" }, () => {
  const V = JSON.parse(readFileSync(FULL_FILE, "utf8"));
  const key = bytes(32, (i) => i);
  const nonce = bytes(24, (i) => 0x40 + i);
  const aad = new TextEncoder().encode(V.seal_aad);
  for (const v of V.seal) {
    const wire = sealWith(key, plaintext(v.plaintext_len), aad, nonce);
    assert.equal(wire.length, v.wire_len);
    if (v.wire_hex) assert.equal(hex(wire), v.wire_hex, `seal(${v.plaintext_len})`);
    if (v.wire_sha3_256) assert.equal(hex(sha3_256(wire)), v.wire_sha3_256, `seal(${v.plaintext_len})`);
    assert.equal(hex(open(key, wire, aad)), hex(plaintext(v.plaintext_len)));
  }
  for (const w of V.wrap) {
    const wireW = sealWith(Buffer.from(w.kek_hex, "hex"), Buffer.from(w.key_hex, "hex"), new TextEncoder().encode(`${V.wrap_aad_prefix}${w.context_utf8}`), Buffer.from(w.nonce_hex, "hex"));
    assert.equal(hex(wireW), w.wire_hex);
  }
});

test("a sealed backup opens only with the private key, under its own name", () => {
  const kp = generateKeyPair();
  assert.equal(kp.publicKey.length, 1216, "ML-KEM-768 + X25519");
  const data = plaintext(5000);
  const s = sealBackup(kp.publicKey, "paperclip-20261012.sql.gz", data);
  assert.equal(hex(openBackup(kp, "paperclip-20261012.sql.gz", s)), hex(data));
  assert.throws(() => openBackup(kp, "renamed.sql.gz", s), "a renamed backup won't open");
  assert.throws(() => openBackup(generateKeyPair(), "paperclip-20261012.sql.gz", s), "nor with another key");
  const bad = Buffer.from(s);
  bad[bad.length - 5] ^= 1;
  assert.throws(() => openBackup(kp, "paperclip-20261012.sql.gz", bad), "nor once tampered with");
  assert.throws(() => sealBackup(kp.publicKey, "a/b", data), /can't contain/);
});

test("the engine's dumps are sealed while locked, and cleared only once a sealed copy opens again identical", () => {
  const root = mkdtempSync(join(tmpdir(), "ogdoad-sealed-"));
  const places = { engineBackups: join(root, "engine"), dir: join(root, "home", "backups", "engine"), keysDir: join(root, "home", "vault") };
  mkdirSync(places.engineBackups, { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000);
  for (const n of ["paperclip-1.sql.gz", "paperclip-2.sql.gz"]) {
    writeFileSync(join(places.engineBackups, n), `dump ${n}`);
    utimesSync(join(places.engineBackups, n), old, old);
  }
  let unlocked = true;
  const vault = { get unlocked() { return unlocked; }, key: (p: string) => createHash("sha256").update(`test vault:${p}`).digest() };
  const backups = new SealedBackups(places);

  // No keys yet: nothing is touched.
  assert.deepEqual(backups.sealRound().sealed, []);
  backups.ensureKeys(vault);

  // Locked: sealed all the same, and the plain dumps stay until a sealed copy is checked.
  unlocked = false;
  assert.deepEqual(backups.sealRound().sealed, ["paperclip-1.sql.gz", "paperclip-2.sql.gz"]);
  assert.equal(backups.verifyRound(vault).verified, 0);
  assert.ok(existsSync(join(places.engineBackups, "paperclip-1.sql.gz")));
  assert.deepEqual(backups.sealRound().sealed, [], "never sealed twice");

  // Unlocked: each sealed copy opens again identical, and only then is its plain dump cleared.
  unlocked = true;
  assert.deepEqual(backups.verifyRound(vault), { verified: 2, failed: [] });
  assert.ok(!existsSync(join(places.engineBackups, "paperclip-1.sql.gz")));
  assert.equal(backups.unseal(vault, "paperclip-2.sql.gz").toString(), "dump paperclip-2.sql.gz");

  // A queued old folder becomes one sealed archive next to it, and goes once checked.
  const folder = join(root, "old-backups", "2026-10-09");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "db.sql"), "old dump");
  writeFileSync(join(root, "home", "backups", "to-seal.json"), JSON.stringify([{ path: folder }]));
  assert.deepEqual(backups.sealRound().sealed, ["2026-10-09.tar"]);
  assert.ok(existsSync(`${folder}.tar.sealed`) && existsSync(folder));
  assert.equal(backups.verifyRound(vault).verified, 1);
  assert.ok(!existsSync(folder));
  const list = backups.list();
  assert.deepEqual([list.ready, list.engine.length, list.elsewhere.map((e) => e.name), list.pending], [true, 2, ["2026-10-09.tar"], 0]);

  // A broken sealed copy never clears its original.
  writeFileSync(join(places.engineBackups, "paperclip-3.sql.gz"), "dump 3");
  utimesSync(join(places.engineBackups, "paperclip-3.sql.gz"), old, old);
  backups.sealRound();
  writeFileSync(join(places.dir, "paperclip-3.sql.gz.sealed"), "garbage");
  assert.deepEqual(backups.verifyRound(vault).failed, ["paperclip-3.sql.gz"]);
  assert.ok(existsSync(join(places.engineBackups, "paperclip-3.sql.gz")));
});
