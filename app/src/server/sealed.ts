// Sealing: how Ogdoad encrypts what must outlive a session (its backups) so only the operator's key
// opens it. The construction (version 1):
//
//   seal(key, data, aad)  = nonce(24) ‖ XChaCha20-Poly1305(key, nonce, aad, u64_le(len) ‖ data ‖ zeros)
//                           with the plaintext PADMÉ-padded to padme(8 + len), so sizes say little
//   wrap(kek, key, ctx)   = seal(kek, key, "ogdoad/v1/wrap" ‖ ctx)
//   hybrid KEM            = ML-KEM-768 + X25519, X-Wing-style:
//                           ss = SHA3-256("ogdoad/v1/hybrid-kem" ‖ ss_mlkem ‖ ss_x25519 ‖ ct_x25519 ‖ pk_x25519)
//                           public key = mlkem_pk(1184) ‖ x25519_pk(32); ciphertext = mlkem_ct(1088) ‖ x25519_eph(32)
//
// A sealed backup is sealed to a PUBLIC key, so backups are sealed even while Ogdoad is locked, without
// the key ever being in memory. Only the private key, kept wrapped under the vault, opens them.
//
//   sealed backup = "OGDOAD-SEALED/1\n" ‖ kem_ct(1120) ‖ wrap(ss, file_key, "backup:" ‖ name)(80) ‖ seal(file_key, data, "ogdoad/v1/backup/" ‖ name)
//
// The seal layer is checked byte for byte against an independent implementation's test vectors
// (test/vectors/seal-v1-vectors.json).

import { randomBytes } from "node:crypto";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";

const te = new TextEncoder();
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));

export const MAGIC = Buffer.from("OGDOAD-SEALED/1\n");
const MLKEM_PK = 1184;
const MLKEM_SK = 2400;
const MLKEM_CT = 1088;
const KEM_CT = MLKEM_CT + 32;
const WRAPPED = 80; // 24 + padme(8 + 32) + 16

/** PADMÉ: the padded size for L bytes, so a sealed size says little about the real one. */
export function padme(L: number): number {
  if (L < 2) return L;
  let e = 0;
  while (2 ** (e + 1) <= L) e++;
  let lg = 0;
  while (2 ** (lg + 1) <= e) lg++;
  const s = e > 0 ? lg + 1 : 1;
  const step = 2 ** Math.max(0, e - s);
  return Math.ceil(L / step) * step;
}

/** The plaintext as sealed: its length, the data, then zeros up to the PADMÉ size. */
export function frame(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(padme(8 + data.length));
  new DataView(padded.buffer).setBigUint64(0, BigInt(data.length), true);
  padded.set(data, 8);
  return padded;
}

/** Seal with a given nonce: only for the conformance vectors. Every real seal takes 24 fresh random bytes. */
export function sealWith(key: Uint8Array, data: Uint8Array, aad: Uint8Array, nonce: Uint8Array): Buffer {
  return cat(nonce, xchacha20poly1305(key, nonce, aad).encrypt(frame(data)));
}

export function seal(key: Uint8Array, data: Uint8Array, aad: Uint8Array): Buffer {
  return sealWith(key, data, aad, randomBytes(24));
}

export function open(key: Uint8Array, wire: Uint8Array, aad: Uint8Array): Buffer {
  if (wire.length < 24 + 8 + 16) throw new Error("Too short to be sealed.");
  const pt = xchacha20poly1305(key, wire.subarray(0, 24), aad).decrypt(wire.subarray(24));
  const len = Number(new DataView(pt.buffer, pt.byteOffset, pt.byteLength).getBigUint64(0, true));
  if (len > pt.length - 8) throw new Error("The sealed length doesn't fit.");
  return Buffer.from(pt.subarray(8, 8 + len));
}

const WRAP = te.encode("ogdoad/v1/wrap");
export const wrap = (kek: Uint8Array, key: Uint8Array, context: string): Buffer => seal(kek, key, cat(WRAP, te.encode(context)));

export function unwrap(kek: Uint8Array, wire: Uint8Array, context: string): Buffer {
  const key = open(kek, wire, cat(WRAP, te.encode(context)));
  if (key.length !== 32) throw new Error("A wrapped key opened to the wrong length.");
  return key;
}

/** A name bound into an AAD parses one way only: no "/" and no NUL. */
function checkName(name: string): void {
  if (!name || /[/\u0000]/.test(name)) throw new Error("A sealed backup's name can't contain \"/\" or NUL.");
}

export interface KeyPair { publicKey: Buffer; secretKey: Buffer }

export function generateKeyPair(): KeyPair {
  const m = ml_kem768.keygen();
  const xs = x25519.utils.randomSecretKey();
  return { publicKey: cat(m.publicKey, x25519.getPublicKey(xs)), secretKey: cat(m.secretKey, xs) };
}

const combine = (ssM: Uint8Array, ssX: Uint8Array, ctX: Uint8Array, pkX: Uint8Array) => sha3_256(cat(te.encode("ogdoad/v1/hybrid-kem"), ssM, ssX, ctX, pkX));

export function encapsulate(publicKey: Uint8Array): { ct: Buffer; ss: Uint8Array } {
  if (publicKey.length !== MLKEM_PK + 32) throw new Error("Not a backup public key.");
  const pkX = publicKey.subarray(MLKEM_PK);
  const m = ml_kem768.encapsulate(publicKey.subarray(0, MLKEM_PK));
  const es = x25519.utils.randomSecretKey();
  const ep = x25519.getPublicKey(es);
  return { ct: cat(m.cipherText, ep), ss: combine(m.sharedSecret, x25519.getSharedSecret(es, pkX), ep, pkX) };
}

export function decapsulate(keys: KeyPair, ct: Uint8Array): Uint8Array {
  if (ct.length !== KEM_CT) throw new Error("Not a key encapsulation.");
  const ep = ct.subarray(MLKEM_CT);
  const ssM = ml_kem768.decapsulate(ct.subarray(0, MLKEM_CT), keys.secretKey.subarray(0, MLKEM_SK));
  return combine(ssM, x25519.getSharedSecret(keys.secretKey.subarray(MLKEM_SK), ep), ep, keys.publicKey.subarray(MLKEM_PK));
}

/** Seal a backup to the public key: no secret needed. The name is bound in: a renamed backup won't open. */
export function sealBackup(publicKey: Uint8Array, name: string, data: Uint8Array): Buffer {
  checkName(name);
  const fileKey = randomBytes(32);
  const { ct, ss } = encapsulate(publicKey);
  return cat(MAGIC, ct, wrap(ss, fileKey, `backup:${name}`), seal(fileKey, data, te.encode(`ogdoad/v1/backup/${name}`)));
}

export function openBackup(keys: KeyPair, name: string, file: Uint8Array): Buffer {
  checkName(name);
  if (!Buffer.from(file.subarray(0, MAGIC.length)).equals(MAGIC)) throw new Error("Not a sealed backup.");
  let at = MAGIC.length;
  const ct = file.subarray(at, (at += KEM_CT));
  const fileKey = unwrap(decapsulate(keys, ct), file.subarray(at, (at += WRAPPED)), `backup:${name}`);
  return open(fileKey, file.subarray(at), te.encode(`ogdoad/v1/backup/${name}`));
}
