// The keeper: whether the books are open, and who may look. Until the operator unlocks the vault the
// Money database stays closed (it's encrypted at rest) and every route but unlocking answers "locked".
// Unlocking opens it and starts a session: a random token in an HttpOnly, same-site cookie. Idle for
// too long, or locked on purpose, and the key is dropped from memory and the books close again.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { HttpError } from "./http.js";
import { encryptExistingDb, isPlaintextDb, MONEY_DB, openMoneyDb } from "./money/db.js";
import { seedPractice } from "./money/practice.js";
import { Money } from "./money/service.js";
import { Vault, VaultError } from "./vault.js";

const COOKIE = "ogdoad_session";

export interface KeeperStatus {
  practice: boolean;
  exists: boolean;
  unlocked: boolean;
  login: string | null;
  lockMinutes: number;
}

export class Keeper {
  money: Money | null = null;
  private readonly sessions = new Map<string, number>();
  private failures = 0;
  /** First launch: the key being made, held in memory only until the phrase is confirmed. */
  private pending: { login: string; password: string; phrase: string; check: number[]; until: number } | null = null;

  constructor(
    readonly practice: boolean,
    readonly vault: Vault | null,
    private readonly lockMs: number,
    private readonly onLock: (why: string) => void = () => {},
  ) {
    // The practice copy has no secrets: its made-up books are always open.
    if (practice) this.openBooks();
    setInterval(() => this.idleCheck(), 30_000).unref();
  }

  status(): KeeperStatus {
    const v = this.vault?.status();
    return { practice: this.practice, exists: this.practice || !!v?.exists, unlocked: this.practice || !!v?.unlocked, login: v?.login ?? null, lockMinutes: Math.round(this.lockMs / 60_000) };
  }

  /** Is this request from an unlocked session? Touches the session, so activity keeps it open. */
  allows(req: IncomingMessage): boolean {
    if (this.practice) return true;
    if (!this.vault?.unlocked) return false;
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    for (const [known] of this.sessions) {
      if (known.length === token.length && timingSafeEqual(Buffer.from(known), Buffer.from(token))) {
        this.sessions.set(known, Date.now());
        return true;
      }
    }
    return false;
  }

  /**
   * First launch, step one: choose a login and password, get the recovery phrase to write down and
   * which three words will be asked back. Nothing is written yet: the vault is made only once the
   * operator proves the phrase is on paper (confirm), so a reload here never strands a vault whose
   * phrase nobody kept.
   */
  prepare(login: string, password: string): { phrase: string; check: number[] } {
    const vault = this.need();
    if (vault.exists) throw new VaultError("exists", "The vault already exists.");
    if (!login.trim()) throw new VaultError("no_login", "Choose a login.");
    Vault.checkPassword(password);
    const check = new Set<number>();
    while (check.size < 3) check.add(1 + randomBytes(1)[0] % 24);
    const phrase = Vault.newPhrase();
    this.pending = { login: login.trim(), password, phrase, check: [...check].sort((a, b) => a - b), until: Date.now() + 30 * 60_000 };
    return { phrase, check: this.pending.check };
  }

  /** First launch, step two: the three words back; then the vault is made and the books open. */
  confirm(words: Record<string, string>): string {
    const p = this.pending;
    if (!p || Date.now() > p.until) throw new VaultError("expired", "That took too long; start making your key again.");
    const list = p.phrase.split(" ");
    const wrong = p.check.filter((n) => String(words[n] ?? "").trim().toLowerCase() !== list[n - 1]);
    if (wrong.length) throw new VaultError("wrong_words", `Word${wrong.length > 1 ? "s" : ""} ${wrong.join(", ")} ${wrong.length > 1 ? "don't" : "doesn't"} match. Check your paper.`);
    this.need().create(p.login, p.password, p.phrase);
    this.pending = null;
    this.openBooks();
    return this.startSession();
  }

  async unlock(login: string, password: string): Promise<string> {
    const vault = this.need();
    if (this.failures >= 5) await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** (this.failures - 5))));
    try {
      vault.unlock(login, password);
    } catch (err) {
      this.failures++;
      throw err;
    }
    this.failures = 0;
    this.openBooks();
    return this.startSession();
  }

  recover(phrase: string, newPassword: string): string {
    this.need().recover(phrase, newPassword);
    this.openBooks();
    return this.startSession();
  }

  lock(why = "locked"): void {
    if (this.practice) return;
    const wasOpen = !!this.money;
    this.money?.db.close();
    this.money = null;
    this.vault?.lock();
    this.sessions.clear();
    if (wasOpen) this.onLock(why);
  }

  /** The cookie that ends the session in the browser. */
  static clearCookie(): string {
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  private need(): Vault {
    if (!this.vault) throw new HttpError(400, "practice", "The practice copy has no vault.");
    return this.vault;
  }

  private openBooks(): void {
    if (this.money) return;
    if (this.practice) {
      this.money = new Money(openMoneyDb());
      if (!this.money.invoices().length) seedPractice(this.money);
      return;
    }
    const key = this.vault!.key("money db");
    // Books kept before the vault existed are encrypted in place, once.
    if (isPlaintextDb(MONEY_DB)) encryptExistingDb(MONEY_DB, key);
    this.money = new Money(openMoneyDb(MONEY_DB, key));
    this.money.fileKey = this.vault!.key("money pdfs");
  }

  private startSession(): string {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now());
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
  }

  private idleCheck(): void {
    if (this.practice || !this.vault?.unlocked) return;
    const last = Math.max(0, ...this.sessions.values());
    if (Date.now() - last > this.lockMs) this.lock(`locked after ${Math.round(this.lockMs / 60_000)} idle minutes`);
  }
}

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export { VaultError };
