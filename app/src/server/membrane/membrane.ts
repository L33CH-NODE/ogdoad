// The membrane. On the way out, every real identity in what the operator writes for the team becomes a
// stand-in (C-4821 for a client, EMAIL-2210 for an address), in three passes, surest first: what the
// books know, then patterns with check digits; a local model is the backstop, later. Hints (an age, a
// condition, a place) are flagged, not replaced. On the way back, stand-ins get their real details
// again, on the operator's screen only, and a validator checks every one: a stand-in nobody has, one
// written wrong, or a real detail that should never have been in a hire's message at all.
//
// The map from stand-in to real detail lives in the encrypted books. The engine only ever holds
// stand-ins.

import { createHash, randomInt } from "node:crypto";

import { FAMILY, tokenRe, type Kind } from "../../shared/standins.js";
import type { Money } from "../money/service.js";
import { knownInBooks, matchBooks, type Known } from "./books.js";
import { findPatterns, normalise } from "./patterns.js";
import { findQuasi, quasiWarning, type Flag, type QuasiKind } from "./quasi.js";

export interface Change { start: number; end: number; original: string; token: string; kind: Kind; source: "books" | "pattern"; why: string }

export interface Outgoing {
  /** What the operator wrote. */
  real: string;
  /** What leaves: the same, with stand-ins. */
  text: string;
  changes: Change[];
  flags: Flag[];
  /** The hints add up to someone (the operator's rule, quasiWarning). */
  warn: boolean;
  /** Something here wants the operator's look before it leaves. */
  hold: boolean;
}

export interface Warning {
  /** real: a client's real detail in a hire's message (an alarm); echo: a detail stood in before, written out. */
  kind: "unknown" | "mangled" | "real" | "echo";
  text: string;
  /** The stand-in it probably meant, for a mangled one. */
  token?: string;
  why: string;
}

export interface Incoming {
  /** Each stand-in in the text, and what it stands for. */
  links: Record<string, { real: string; kind: Kind }>;
  warnings: Warning[];
}

const FAMILIES = Object.values(FAMILY).sort((a, b) => b.length - a.length).join("|");
/** A stand-in written wrong: C 4821, C4821, C-482, ME_2210 (the right form is caught first). */
const MANGLED = new RegExp(`\\b(${FAMILIES})(?:[\\s_–—]?-?\\s?)(\\d{1,6})\\b`, "g");
/** "Client 4821": a stand-in's number with a word instead of its family. */
const WORDED = /\b(?:client|participant|customer)\s*(?:no\.?|number|#)?\s*#?(\d{4})\b/gi;

/** The engine's mentions are names of hires, not clients: never touched. */
const MENTION = /\[@[^\]]*\]\(agent:\/\/[^)\s]+\)/g;

const spansOf = (text: string, re: RegExp): Array<[number, number]> => [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);

export class Membrane {
  constructor(private readonly money: Money) {}

  private get db() {
    return this.money.db;
  }

  /** The stand-in for a detail: the one it already has, or a new one (the preferred one, if it's free). */
  tokenFor(kind: Kind, real: string, source: "books" | "pattern", ref: string | null = null, prefer?: string): string {
    const norm = normalise(kind, real);
    const row = this.db.prepare("SELECT token FROM standins WHERE kind = ? AND norm = ?").get(kind, norm) as { token: string } | undefined;
    if (row) return row.token;
    const taken = (t: string) => !!this.db.prepare("SELECT 1 FROM standins WHERE token = ?").get(t);
    let token = prefer && !taken(prefer) ? prefer : "";
    for (let tries = 0; !token; tries++) {
      const t = `${FAMILY[kind]}-${randomInt(1000, 10000)}`;
      if (!taken(t)) token = t;
      if (tries > 200) throw new Error(`No stand-ins left for ${kind}.`);
    }
    this.db.prepare("INSERT INTO standins (token, kind, real, norm, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(token, kind, real, norm, source, ref, new Date().toISOString());
    return token;
  }

  private cache: Known[] | null = null;
  /** What the books know, read once per Membrane (one request's worth). */
  private known(): Known[] {
    return (this.cache ??= knownInBooks(this.money));
  }

  /**
   * The way out. protect: words never to treat as a client (the hires' own names). Stand-ins are made
   * as they're needed and kept, so the same person reads the same in every message.
   */
  out(real: string, opts: { protect?: string[]; dry?: boolean } = {}): Outgoing {
    // A look while typing makes no new stand-ins (half an email would be kept for good).
    const tokenFor = (kind: Kind, value: string, source: "books" | "pattern", ref: string | null = null, prefer?: string) => {
      if (!opts.dry) return this.tokenFor(kind, value, source, ref, prefer);
      const row = this.db.prepare("SELECT token FROM standins WHERE kind = ? AND norm = ?").get(kind, normalise(kind, value)) as { token: string } | undefined;
      return row?.token ?? `${FAMILY[kind]}-····`;
    };
    const keep: Array<[number, number]> = [...spansOf(real, MENTION), ...spansOf(real, tokenRe())];
    // Email addresses first: they carry names' letters that mustn't be split up.
    const emails = findPatterns(real, keep, (k) => k === "email");
    const afterEmails = [...keep, ...emails.map((e): [number, number] => [e.start, e.end])];
    const books = matchBooks(real, this.known(), afterEmails, { protect: opts.protect });
    const afterBooks = [...afterEmails, ...books.hits.map((h): [number, number] => [h.start, h.end])];
    const shapes = findPatterns(real, afterBooks, (k) => k !== "email");
    const changes: Change[] = [
      ...books.hits.map((h) => ({
        start: h.start, end: h.end, original: real.slice(h.start, h.end), kind: h.known.kind, source: "books" as const, why: h.why,
        token: tokenFor(h.known.kind, h.known.real, "books", h.known.ref, h.known.prefer),
      })),
      ...[...emails, ...shapes].map((f) => ({ start: f.start, end: f.end, original: f.value, kind: f.kind, source: "pattern" as const, why: f.why, token: tokenFor(f.kind, f.value, "pattern") })),
    ].sort((a, b) => a.start - b.start);

    const taken = [...afterBooks, ...shapes.map((s): [number, number] => [s.start, s.end])];
    const hints = findQuasi(real, taken);
    const flags = [...books.flags, ...hints].sort((a, b) => a.start - b.start);
    const kinds = new Set(hints.map((h) => h.kind as QuasiKind));
    const warn = quasiWarning(kinds);

    let text = "";
    let at = 0;
    for (const c of changes) {
      text += real.slice(at, c.start) + c.token;
      at = c.end;
    }
    text += real.slice(at);
    const hold = changes.length > 0 || warn || flags.some((f) => f.kind === "maybe-name" || f.kind === "ambiguous");
    return { real, text, changes, flags, warn, hold };
  }

  /** What the stand-ins in a text stand for. */
  lookup(tokens: Iterable<string>): Record<string, { real: string; kind: Kind }> {
    const out: Record<string, { real: string; kind: Kind }> = {};
    const get = this.db.prepare("SELECT real, kind FROM standins WHERE token = ?");
    for (const t of new Set(tokens)) {
      const row = get.get(t.toUpperCase()) as { real: string; kind: Kind } | undefined;
      if (row) out[t] = row;
    }
    return out;
  }

  /** A title or a name with its real details back, for the operator's screen. */
  relink(text: string): string {
    const links = this.lookup([...text.matchAll(tokenRe("gi"))].map((m) => m[0]));
    return text.replace(tokenRe("gi"), (t) => links[t]?.real ?? t);
  }

  /**
   * The way back: what a text's stand-ins stand for, and what's wrong with it. fromTeam: the text came
   * from a hire, so any real detail in it is an alarm (it was never sent one).
   */
  back(text: string, opts: { fromTeam?: boolean } = {}): Incoming {
    const found = [...text.matchAll(tokenRe("gi"))];
    const links = this.lookup(found.map((m) => m[0]));
    const warnings: Warning[] = [];
    const seen = new Set<string>();
    const warn = (w: Warning) => {
      const k = `${w.kind}|${w.text}`;
      if (!seen.has(k)) seen.add(k), warnings.push(w);
    };
    for (const m of found) if (!links[m[0]]) warn({ kind: "unknown", text: m[0], why: `${m[0]} isn't anyone in your books: it may have been made up.` });

    const canonical = spansOf(text, tokenRe("gi"));
    const inCanonical = (i: number) => canonical.some(([a, b]) => i >= a && i < b);
    const known = (family: string, digits: string) => {
      const t = `${family.toUpperCase()}-${digits}`;
      return digits.length === 4 && !!this.lookup([t])[t] ? t : undefined;
    };
    for (const m of text.matchAll(MANGLED)) {
      if (inCanonical(m.index!)) continue;
      const token = known(m[1], m[2]);
      // "C4821" is only a slip if C-4821 is someone; "C-482" is one either way (a family and a dash).
      if (token) warn({ kind: "mangled", text: m[0], token, why: `"${m[0]}" looks like ${token} written wrong. Check who's meant.` });
      else if (m[0].includes("-")) warn({ kind: "mangled", text: m[0], why: `"${m[0]}" looks like a stand-in written wrong, and matches nobody.` });
    }
    for (const m of text.matchAll(WORDED)) {
      const token = known("C", m[1]);
      if (token) warn({ kind: "mangled", text: m[0], token, why: `"${m[0]}" may mean ${token}. Check who's meant.` });
    }

    if (opts.fromTeam) {
      const keep = [...canonical, ...spansOf(text, MENTION)];
      // Only a client's identity is an alarm: the business's own name and details are no secret from
      // its own team (the company it works for may well carry the same name).
      const clients = this.known().filter((k) => k.kind === "who" || k.ref);
      const strong = matchBooks(text, clients, keep, { strong: true }).hits;
      for (const h of strong) {
        warn({ kind: "real", text: text.slice(h.start, h.end), why: `A real ${h.known.kind === "who" ? "name" : "detail"} from your books is in a hire's message. It was never sent one.` });
      }
      // A detail Ogdoad stood in before (an email you once wrote, say), now written out: worth a look,
      // though it may be public (a provider's helpline), so it's no alarm.
      for (const f of findPatterns(text, [...keep, ...strong.map((h): [number, number] => [h.start, h.end])])) {
        const row = this.db.prepare("SELECT token, ref FROM standins WHERE kind = ? AND norm = ?").get(f.kind, normalise(f.kind, f.value)) as { token: string; ref: string | null } | undefined;
        if (row) warn({ kind: row.ref ? "real" : "echo", text: f.value, token: row.token, why: `${f.value} is a detail Ogdoad stands in as ${row.token}, written out in a hire's message.` });
      }
    }
    return { links, warnings };
  }
}

/** One short fingerprint of what the operator was shown, so what's sent is exactly what they checked. */
export function digestOf(pieces: Array<Pick<Outgoing, "text" | "flags">>): string {
  const h = createHash("sha256");
  for (const p of pieces) h.update(`${p.text}\u0000${p.flags.map((f) => `${f.kind}:${f.text}`).join("|")}\u0001`);
  return h.digest("hex").slice(0, 16);
}
