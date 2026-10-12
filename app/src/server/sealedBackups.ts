// The engine's backups, sealed. The engine (core/) dumps its database every hour as plain .sql.gz
// files; Ogdoad seals each one to its backup public key within minutes, locked or not, and deletes the
// plain dump only after the sealed copy has been opened again with the private key (which needs the
// vault unlocked) and found identical. Nothing is ever deleted on a seal alone. Old backup folders can
// be queued too (backups/to-seal.json): each becomes one sealed archive next to where it was.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { generateKeyPair, open, openBackup, seal, sealBackup, type KeyPair } from "./sealed.js";

const te = new TextEncoder();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const iso = () => new Date().toISOString();
const EXT = ".sealed";
/** Per round (every two minutes): a backlog clears over a few rounds instead of freezing the app once. */
const PER_ROUND = 12;

export interface BackupPlaces {
  /** Where the engine writes its plain dumps. */
  engineBackups: string;
  /** Where the sealed engine dumps go. */
  dir: string;
  /** The backup keys (the public one, and the private one sealed under the vault). */
  keysDir: string;
}

export function defaultPlaces(home: string): BackupPlaces {
  return {
    engineBackups: process.env.OGDOAD_ENGINE_BACKUPS ?? join(homedir(), ".paperclip", "instances", "default", "data", "backups"),
    dir: join(home, "backups", "engine"),
    keysDir: join(home, "vault"),
  };
}

interface Pending { sealed: string; name: string; original: string; folder: boolean; sha256: string; at: string }

/** A vault's say on the private key: a key for one purpose, while it's unlocked. */
export interface VaultKey { key(purpose: string): Buffer; readonly unlocked: boolean }

const SECRET_AAD = te.encode("ogdoad/v1/backup-secret");

export class SealedBackups {
  constructor(private readonly places: BackupPlaces) {}

  private get pubFile() {
    return join(this.places.keysDir, "backup.pub");
  }
  private get secretFile() {
    return join(this.places.keysDir, "backup.key");
  }
  private get pendingFile() {
    return join(this.places.dir, "pending.json");
  }
  private get queueFile() {
    return join(dirname(this.places.dir), "to-seal.json");
  }
  private get indexFile() {
    return join(this.places.dir, "elsewhere.json");
  }

  /** The backup keys, made the first time the vault is open: the private one sealed under the vault, and a round trip checked. */
  ensureKeys(vault: VaultKey): void {
    if (existsSync(this.pubFile) && existsSync(this.secretFile)) return;
    if (!vault.unlocked) return;
    mkdirSync(this.places.keysDir, { recursive: true });
    const kp = generateKeyPair();
    const probe = sealBackup(kp.publicKey, "probe", te.encode("self-test"));
    if (Buffer.from(openBackup(kp, "probe", probe)).toString() !== "self-test") throw new Error("The backup keys failed their own test.");
    writeFileSync(this.secretFile, seal(vault.key("backup secret"), kp.secretKey, SECRET_AAD));
    writeFileSync(this.pubFile, kp.publicKey);
  }

  publicKey(): Buffer | null {
    return existsSync(this.pubFile) ? readFileSync(this.pubFile) : null;
  }

  private keys(vault: VaultKey): KeyPair | null {
    const pub = this.publicKey();
    if (!pub || !vault.unlocked || !existsSync(this.secretFile)) return null;
    return { publicKey: pub, secretKey: open(vault.key("backup secret"), readFileSync(this.secretFile), SECRET_AAD) };
  }

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private write(file: string, value: unknown): void {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  }

  private sealTo(path: string, name: string, data: Buffer, original: string, folder: boolean): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, sealBackup(this.publicKey()!, name, data));
    renameSync(tmp, path);
    const pending = this.read<Pending[]>(this.pendingFile, []);
    pending.push({ sealed: path, name, original, folder, sha256: sha256(data), at: iso() });
    this.write(this.pendingFile, pending);
  }

  /** Seal what's waiting: the engine's new dumps, and any queued folder. Needs only the public key. */
  sealRound(): { sealed: string[] } {
    const sealed: string[] = [];
    if (!this.publicKey()) return { sealed };
    mkdirSync(this.places.dir, { recursive: true });
    const pending = new Set(this.read<Pending[]>(this.pendingFile, []).map((p) => p.original));
    if (existsSync(this.places.engineBackups)) {
      for (const f of readdirSync(this.places.engineBackups).filter((x) => /\.sql(\.gz)?$/.test(x)).sort()) {
        const original = join(this.places.engineBackups, f);
        const target = join(this.places.dir, `${f}${EXT}`);
        if (pending.has(original) || existsSync(target)) continue;
        // A dump still being written isn't sealed yet.
        if (Date.now() - statSync(original).mtimeMs < 60_000) continue;
        if (sealed.length >= PER_ROUND) break;
        this.sealTo(target, f, readFileSync(original), original, false);
        sealed.push(f);
      }
    }
    const queue = this.read<Array<{ path: string }>>(this.queueFile, []);
    const left: Array<{ path: string }> = [];
    let folders = 0;
    for (const q of queue) {
      if (pending.has(q.path) || !existsSync(q.path)) continue;
      if (folders++ >= 1) {
        left.push(q);
        continue;
      }
      try {
        const name = `${basename(q.path)}.tar`;
        const tar = join(tmpdir(), `ogdoad-${randomUUID().slice(0, 8)}.tar`);
        const tarBin = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
        execFileSync(tarBin, ["-cf", tar, "-C", dirname(q.path), basename(q.path)], { stdio: "ignore" });
        const data = readFileSync(tar);
        unlinkSync(tar);
        const target = join(dirname(q.path), `${name}${EXT}`);
        this.sealTo(target, name, data, q.path, true);
        const index = this.read<Array<{ sealed: string; name: string; at: string; size: number }>>(this.indexFile, []);
        index.push({ sealed: target, name, at: iso(), size: statSync(target).size });
        this.write(this.indexFile, index);
        sealed.push(name);
      } catch {
        left.push(q);
      }
    }
    if (queue.length) this.write(this.queueFile, left);
    return { sealed };
  }

  /**
   * Open each sealed copy not yet checked, with the private key (so the vault must be open): identical to
   * what was sealed, and only then is the plain original deleted.
   */
  verifyRound(vault: VaultKey): { verified: number; failed: string[] } {
    const kp = this.keys(vault);
    if (!kp) return { verified: 0, failed: [] };
    const pending = this.read<Pending[]>(this.pendingFile, []);
    const keep: Pending[] = [];
    let verified = 0;
    const failed: string[] = [];
    for (const p of pending) {
      if (verified + failed.length >= PER_ROUND) {
        keep.push(p);
        continue;
      }
      try {
        const back = openBackup(kp, p.name, readFileSync(p.sealed));
        if (sha256(back) !== p.sha256) throw new Error("different");
        if (existsSync(p.original)) rmSync(p.original, { recursive: p.folder, force: true });
        verified++;
      } catch {
        // Kept, with its original: a failed check never deletes anything.
        failed.push(p.name);
        keep.push(p);
      }
    }
    if (pending.length) this.write(this.pendingFile, keep);
    return { verified, failed };
  }

  /** Sealed engine dumps older than the retention (queued folders are kept). */
  prune(days = 30): number {
    if (!existsSync(this.places.dir)) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    const pending = new Set(this.read<Pending[]>(this.pendingFile, []).map((p) => p.sealed));
    let n = 0;
    for (const f of readdirSync(this.places.dir).filter((x) => x.endsWith(EXT))) {
      const path = join(this.places.dir, f);
      if (!pending.has(path) && statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
        n++;
      }
    }
    return n;
  }

  /** What's sealed, for Settings. */
  list(): { ready: boolean; engine: Array<{ name: string; size: number; at: string }>; elsewhere: Array<{ name: string; size: number; at: string }>; pending: number } {
    const engine = existsSync(this.places.dir)
      ? readdirSync(this.places.dir).filter((x) => x.endsWith(EXT)).map((f) => {
          const s = statSync(join(this.places.dir, f));
          return { name: f.slice(0, -EXT.length), size: s.size, at: s.mtime.toISOString() };
        }).sort((a, b) => b.at.localeCompare(a.at))
      : [];
    const elsewhere = this.read<Array<{ sealed: string; name: string; at: string; size: number }>>(this.indexFile, []).map(({ name, at, size }) => ({ name, at, size }));
    return { ready: !!this.publicKey(), engine, elsewhere, pending: this.read<Pending[]>(this.pendingFile, []).length };
  }

  /** An engine dump, opened again (for a restore): the vault must be open. */
  unseal(vault: VaultKey, name: string): Buffer {
    const kp = this.keys(vault);
    if (!kp) throw new Error("Unlock Ogdoad to open a backup.");
    if (!/^[\w.-]+$/.test(name)) throw new Error("No such backup.");
    return openBackup(kp, name, readFileSync(join(this.places.dir, `${name}${EXT}`)));
  }
}
