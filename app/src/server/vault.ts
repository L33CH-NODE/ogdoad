// The vault: everything Ogdoad keeps is encrypted under one random data key, and that key exists in
// the clear only in this process's memory while the operator has unlocked it. On disk it's stored
// twice, wrapped: once under a key derived from the operator's password (scrypt, memory-hard), once
// under a key derived from their 24-word recovery phrase. Either unlocks it. There is no account
// anywhere and no copy of the key: lose both the password and the phrase and the data is gone.
//
// The director key (Ed25519) is derived from the phrase and kept wrapped under the data key; signing
// with it asks for the password again.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes, scryptSync, sign, timingSafeEqual, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { OGDOAD_HOME } from "./money/db.js";

export const VAULT_FILE = join(OGDOAD_HOME, "vault", "vault.json");

export class VaultError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

interface Wrapped {
  iv: string;
  ct: string;
  tag: string;
}

interface VaultFile {
  v: 1;
  login: string;
  createdAt: string;
  kdf: { alg: "scrypt"; N: number; r: number; p: number; salt: string };
  password: Wrapped;
  phrase: { salt: string; wrapped: Wrapped };
  director: { publicKey: string; seed: Wrapped };
}

/** Memory-hard enough to make guessing a stolen vault file slow (about half a second per try). */
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };
const MIN_PASSWORD = 10;
// DER prefix that turns a raw 32-byte Ed25519 seed into a PKCS#8 private key.
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

const b64 = (b: Buffer) => b.toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

function seal(key: Buffer, plain: Buffer, aad: string): Wrapped {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

function open(key: Buffer, w: Wrapped, aad: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, unb64(w.iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(unb64(w.tag));
  return Buffer.concat([d.update(unb64(w.ct)), d.final()]);
}

function passwordKey(password: string, kdf: VaultFile["kdf"]): Buffer {
  return scryptSync(password.normalize("NFKC"), unb64(kdf.salt), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 });
}

function phraseEntropy(phrase: string): Buffer {
  const words = phrase.trim().toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(words, wordlist)) throw new VaultError("bad_phrase", "That isn't a valid recovery phrase. Check each word and the order.");
  return Buffer.from(mnemonicToEntropy(words, wordlist));
}

function phraseKey(entropy: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", entropy, salt, "ogdoad vault: phrase key", 32));
}

function directorSeed(entropy: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", entropy, Buffer.alloc(0), "ogdoad director key: ed25519 seed", 32));
}

function directorKeys(seed: Buffer) {
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: "der", type: "pkcs8" });
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKey: publicDer.subarray(-32) };
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD) throw new VaultError("weak_password", `Use at least ${MIN_PASSWORD} characters. A few unrelated words make a strong one.`);
}

export class Vault {
  private dataKey: Buffer | null = null;

  constructor(readonly file = VAULT_FILE) {}

  /** A fresh 24-word phrase (256 bits). */
  static newPhrase(): string {
    return generateMnemonic(wordlist, 256);
  }

  static checkPassword(password: string): void {
    checkPassword(password);
  }

  get exists(): boolean {
    return existsSync(this.file);
  }

  get unlocked(): boolean {
    return this.dataKey !== null;
  }

  status(): { exists: boolean; unlocked: boolean; login: string | null } {
    return { exists: this.exists, unlocked: this.unlocked, login: this.exists ? this.read().login : null };
  }

  private read(): VaultFile {
    return JSON.parse(readFileSync(this.file, "utf8")) as VaultFile;
  }

  private write(v: VaultFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /**
   * Make the vault: a new data key, wrapped under the password and under a fresh 24-word phrase.
   * Returns the phrase, once; it is never stored. The vault is left unlocked.
   */
  create(login: string, password: string, phrase = Vault.newPhrase()): { phrase: string } {
    if (this.exists) throw new VaultError("exists", "The vault already exists.");
    if (!login.trim()) throw new VaultError("no_login", "Choose a login.");
    checkPassword(password);
    const dataKey = randomBytes(32);
    const entropy = phraseEntropy(phrase);
    const kdf = { alg: "scrypt" as const, ...SCRYPT, salt: b64(randomBytes(16)) };
    const phraseSalt = randomBytes(16);
    const seed = directorSeed(entropy);
    this.write({
      v: 1,
      login: login.trim(),
      createdAt: new Date().toISOString(),
      kdf,
      password: seal(passwordKey(password, kdf), dataKey, "data key"),
      phrase: { salt: b64(phraseSalt), wrapped: seal(phraseKey(entropy, phraseSalt), dataKey, "data key") },
      director: { publicKey: b64(directorKeys(seed).publicKey), seed: seal(dataKey, seed, "director seed") },
    });
    this.dataKey = dataKey;
    return { phrase };
  }

  /** Login and password: unwrap the data key into memory. */
  unlock(login: string, password: string): void {
    const v = this.read();
    let dataKey: Buffer;
    try {
      dataKey = open(passwordKey(password, v.kdf), v.password, "data key");
    } catch {
      throw new VaultError("wrong_password", "That login and password don't unlock the vault.");
    }
    // Compare the login only after the slow part, so timing says nothing about which one was wrong.
    const a = Buffer.from(login.trim());
    const b = Buffer.from(v.login);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new VaultError("wrong_password", "That login and password don't unlock the vault.");
    this.dataKey = dataKey;
  }

  /** Forgotten password: the phrase unlocks the vault and sets a new password. */
  recover(phrase: string, newPassword: string): void {
    checkPassword(newPassword);
    const v = this.read();
    const entropy = phraseEntropy(phrase);
    let dataKey: Buffer;
    try {
      dataKey = open(phraseKey(entropy, unb64(v.phrase.salt)), v.phrase.wrapped, "data key");
    } catch {
      throw new VaultError("wrong_phrase", "That recovery phrase doesn't unlock this vault.");
    }
    const kdf = { alg: "scrypt" as const, ...SCRYPT, salt: b64(randomBytes(16)) };
    this.write({ ...v, kdf, password: seal(passwordKey(newPassword, kdf), dataKey, "data key") });
    this.dataKey = dataKey;
  }

  changePassword(oldPassword: string, newPassword: string): void {
    const v = this.read();
    this.unlock(v.login, oldPassword);
    checkPassword(newPassword);
    const kdf = { alg: "scrypt" as const, ...SCRYPT, salt: b64(randomBytes(16)) };
    this.write({ ...v, kdf, password: seal(passwordKey(newPassword, kdf), this.dataKey!, "data key") });
  }

  lock(): void {
    this.dataKey?.fill(0);
    this.dataKey = null;
  }

  /** A key for one purpose ("money db", "money pdfs"), derived from the data key. */
  key(purpose: string): Buffer {
    if (!this.dataKey) throw new VaultError("locked", "The vault is locked.");
    return Buffer.from(hkdfSync("sha256", this.dataKey, Buffer.alloc(0), `ogdoad: ${purpose}`, 32));
  }

  /** Sign an irreversible act with the director key. Asks for the password again, every time. */
  signAsDirector(password: string, payload: Buffer): { signature: string; publicKey: string } {
    const v = this.read();
    let dataKey: Buffer;
    try {
      dataKey = open(passwordKey(password, v.kdf), v.password, "data key");
    } catch {
      throw new VaultError("wrong_password", "That password doesn't sign.");
    }
    const { privateKey } = directorKeys(open(dataKey, v.director.seed, "director seed"));
    return { signature: b64(sign(null, payload, privateKey)), publicKey: v.director.publicKey };
  }

  directorPublicKey(): string {
    return this.read().director.publicKey;
  }
}

/** Check a director signature against the vault's public key. */
export function verifyDirector(publicKey: string, payload: Buffer, signature: string): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), unb64(publicKey)]);
  return verify(null, payload, createPublicKey({ key: spki, format: "der", type: "spki" }), unb64(signature));
}

/** Files at rest (issued PDFs): AES-256-GCM with a purpose key from the vault. */
export function sealFile(path: string, bytes: Buffer | Uint8Array, key: Buffer): void {
  const w = seal(key, Buffer.from(bytes), "file");
  writeFileSync(path, JSON.stringify(w), { mode: 0o600 });
}

export function openFile(path: string, key: Buffer): Buffer {
  return open(key, JSON.parse(readFileSync(path, "utf8")) as Wrapped, "file");
}
