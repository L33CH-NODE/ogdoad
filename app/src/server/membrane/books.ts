// The membrane's first and surest pass: what the books already know. Every client, participant and
// contact, and the business itself, with the details kept for each. A name is caught however it's
// written: any case, with a possessive, a slip of one letter in a longer name, "Mrs Citizen", or a
// first name alone (but a first name that's also a word, like Will or Grace, only mid-sentence).

import type { Kind } from "../../shared/standins.js";
import type { Money } from "../money/service.js";
import { standIn } from "../work/work.js";
import type { Flag } from "./quasi.js";

/** Someone or something the books know, and the stand-in it would like (the calendar's, for a client). */
export interface Known {
  kind: Kind;
  real: string;
  ref: string | null;
  prefer?: string;
  /** A person's name (so a first name alone counts), rather than an organisation's. */
  person?: boolean;
}

export interface BookHit { start: number; end: number; known: Known; why: string }

const ORG = /\b(pty|ltd|limited|inc|llc|co|corp|corporation|company|trust|group|management|managers?|services?|solutions|care|health|plan|planning|supports?|council|association|assoc|foundation|clinic|hospital|agency|partners|holdings|enterprises|industries|centre|center|network|institute|society|church|school|university|department|dept|ndis|ndia)\b|&/i;
const LEGAL = /\s+(?:pty\.?\s*ltd\.?|pty\.?\s*limited|ltd\.?|limited|inc\.?|incorporated|llc|corp\.?|corporation)$/i;
const TITLES = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof"]);

/** Names that are also everyday words: alone, they count only mid-sentence, where the capital means a name. */
const COMMON = new Set([
  "will", "bill", "mark", "may", "june", "april", "august", "grace", "hope", "joy", "faith", "rose", "ruby", "pearl", "iris", "ivy", "holly", "daisy", "lily", "violet",
  "dawn", "sky", "summer", "autumn", "winter", "angel", "ray", "art", "jack", "frank", "rich", "sunny", "chance", "chase", "hunter", "mason", "carter", "cooper",
  "page", "pat", "sue", "dot", "penny", "sandy", "rocky", "max", "guy", "don", "dean", "drew", "reed", "wade", "cliff", "glen", "dale", "rod", "lance", "miles",
  "norm", "sterling", "brown", "white", "green", "black", "young", "king", "long", "short", "hill", "wood", "gray", "grey", "bell", "lane", "field", "hall", "wells",
  "street", "banks", "price", "cook", "baker", "may", "march", "joy", "storm", "river", "brook", "forest", "heath", "crystal", "amber", "jade", "honey", "star",
]);

/** Everyone and everything the books hold that names someone: the calendar's own stand-ins first. */
export function knownInBooks(money: Money): Known[] {
  const db = money.db;
  const out: Known[] = [];
  const isPerson = (name: string) => !ORG.test(name) && name.trim().split(/\s+/).length <= 4;
  const who = (clientId: string, name: string, prefer: string, person = true) => {
    if (name.trim()) out.push({ kind: "who", real: name.trim(), ref: clientId, prefer, person });
  };
  const clients = db.prepare("SELECT * FROM clients").all() as any[];
  // Participants first: their stand-in is the one the calendar shows.
  for (const c of clients) if (c.participant_name) who(c.id, c.participant_name, standIn(c.id, c.participant_name));
  for (const r of db.prepare("SELECT DISTINCT client_id, participant_name FROM invoices WHERE participant_name <> '' UNION SELECT DISTINCT client_id, participant_name FROM shifts WHERE participant_name <> ''").all() as any[]) {
    who(r.client_id, r.participant_name, standIn(r.client_id, r.participant_name));
  }
  for (const c of clients) who(c.id, c.name, standIn(c.id, ""), isPerson(c.name));
  for (const c of clients) who(c.id, c.contact_name, standIn(c.id, `contact:${c.contact_name}`));
  const s = db.prepare("SELECT * FROM settings WHERE id = 1").get() as any;
  if (s?.business_name?.trim()) out.push({ kind: "me", real: s.business_name.trim(), ref: null, person: isPerson(s.business_name) });
  const accounts = db.prepare("SELECT * FROM payment_accounts").all() as any[];
  for (const a of accounts) if (a.account_name?.trim()) out.push({ kind: "me", real: a.account_name.trim(), ref: null, person: isPerson(a.account_name) });

  const value = (kind: Kind, real: string, ref: string | null) => {
    if (real?.trim()) out.push({ kind, real: real.trim(), ref });
  };
  for (const c of clients) {
    value("email", c.email, c.id);
    value("phone", c.phone, c.id);
    value("address", c.address, c.id);
    value("ndis", c.ndis_number, c.id);
  }
  for (const r of db.prepare("SELECT DISTINCT client_id, ndis_number FROM invoices WHERE ndis_number <> ''").all() as any[]) value("ndis", r.ndis_number, r.client_id);
  if (s) {
    value("abn", s.abn, null);
    value("email", s.contact_email, null);
    value("phone", s.contact_phone, null);
    value("address", s.address, null);
  }
  for (const a of accounts) {
    if (a.bsb && a.account_number) value("bank", `${a.bsb} ${a.account_number}`, null);
    value("bank", a.account_number, null);
  }
  return out;
}

interface Word { core: string; start: number; end: number; full: number }

/** The words of a text, each with its possessive set aside ("Jane's" is Jane, ending before the 's). */
function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu)) {
    const raw = m[0];
    const core = /['’]s$/i.test(raw) && raw.length > 3 ? raw.slice(0, -2) : raw;
    out.push({ core, start: m.index!, end: m.index! + core.length, full: m.index! + raw.length });
  }
  return out;
}

/** Edits between two short strings (a swap of neighbours counts as one). */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const lower = (s: string) => s.toLowerCase().replace(/’/g, "'");
const splitName = (s: string) => wordsOf(s).map((w) => lower(w.core));
const capitalised = (s: string) => /^\p{Lu}/u.test(s);

interface Rule { known: Known; seqs: string[][]; first: string | null; last: string | null }

function rulesFor(known: Known[]): Rule[] {
  const rules: Rule[] = [];
  for (const k of known) {
    if (k.kind !== "who" && k.kind !== "me") continue;
    const words = splitName(k.real);
    if (!words.length) continue;
    const seqs: string[][] = [words];
    let first: string | null = null;
    let last: string | null = null;
    if (k.person) {
      if (words.length >= 2) {
        first = words[0];
        last = words[words.length - 1];
        if (words.length >= 3) seqs.push([first, last]);
        seqs.push([last, first]);
      } else {
        first = words[0];
      }
    } else {
      const bare = splitName(k.real.replace(LEGAL, ""));
      if (bare.length && bare.join(" ") !== words.join(" ")) seqs.push(bare);
      // A one-word organisation is matched like a first name: capitalised, and only mid-sentence if it's a word too.
      if (bare.length === 1) first = bare[0];
    }
    rules.push({ known: k, seqs: seqs.filter((s) => s.length >= 2), first, last });
  }
  return rules;
}

/** Is the word at the start of a sentence (where a capital says nothing about it being a name)? */
function sentenceStart(text: string, at: number): boolean {
  const lead = text.slice(Math.max(0, at - 6), at).replace(/["'“‘(\s]+$/, "");
  return !lead || /[.!?:;\n]$/.test(lead) || /(^|\n)\s*([-*•]|\d+[.)])$/.test(lead) || at === 0;
}

const digitRe = (d: string, phone: boolean) => {
  const sep = "[\\s().-]{0,2}";
  const body = phone && d.startsWith("0") ? `\\(?(?:\\+?61|0)${sep}${[...d.slice(1)].join(sep)}` : [...d].join(sep);
  return new RegExp(`(?<![\\d+])${body}(?!\\d)`, "g");
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface BookMatch { hits: BookHit[]; flags: Flag[] }

/**
 * Find what the books know in a text. strong: only what can't be a coincidence (a whole name, exact; a
 * kept email, number or address), for checking what the team sends back.
 */
export function matchBooks(text: string, known: Known[], taken: Array<[number, number]>, opts: { strong?: boolean; protect?: string[] } = {}): BookMatch {
  const hits: BookHit[] = [];
  const flags: Flag[] = [];
  const claimed = [...taken];
  const free = (s: number, e: number) => !claimed.some(([a, b]) => s < b && e > a);
  const claim = (start: number, end: number, k: Known, why: string) => {
    if (!free(start, end)) return;
    claimed.push([start, end]);
    hits.push({ start, end, known: k, why });
  };

  // Details first (an email or number holds names' letters and digits that must not be split up).
  for (const k of known) {
    if (k.kind === "who" || k.kind === "me") continue;
    if (k.kind === "email") {
      for (const m of text.matchAll(new RegExp(`(?<![\\w.+-])${escapeRe(k.real)}(?![\\w-])`, "gi"))) claim(m.index!, m.index! + m[0].length, k, "an email address in your books");
      continue;
    }
    if (k.kind === "address") {
      const parts = [k.real, ...(/^\s*\d/.test(k.real) && k.real.includes(",") ? [k.real.split(",")[0]] : [])];
      for (const p of parts) {
        const w = p.match(/[\p{L}\p{N}]+/gu) ?? [];
        if (w.length < 2) continue;
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${w.map(escapeRe).join("[\\s,./-]+")}(?![\\p{L}\\p{N}])`, "giu");
        for (const m of text.matchAll(re)) claim(m.index!, m.index! + m[0].length, k, "an address in your books");
      }
      continue;
    }
    const d = k.real.replace(/\D/g, "");
    if (d.length < 6) continue;
    for (const m of text.matchAll(digitRe(d, k.kind === "phone"))) claim(m.index!, m.index! + m[0].length, k, `${k.kind === "phone" ? "a phone number" : k.kind === "bank" ? "bank details" : k.kind === "abn" ? "an ABN" : "a number"} in your books`);
  }

  const rules = rulesFor(known);
  const ws = wordsOf(text);
  const protect = new Set((opts.protect ?? []).map(lower));
  const byFirst = new Map<string, Rule[]>();
  const byLast = new Map<string, Rule[]>();
  for (const r of rules) {
    if (r.first) byFirst.set(r.first, [...(byFirst.get(r.first) ?? []), r]);
    if (r.last) byLast.set(r.last, [...(byLast.get(r.last) ?? []), r]);
  }
  const same = (a: string, b: string, fuzzy: boolean) => {
    const x = lower(a);
    return x === b || (fuzzy && !opts.strong && x.length >= 5 && b.length >= 5 && distance(x, b) <= 1);
  };
  const joined = (i: number, n: number) => {
    for (let k = i; k < i + n - 1; k++) if (!/^[\s,.]{1,3}$/.test(text.slice(ws[k].full, ws[k + 1].start))) return false;
    return true;
  };
  /** One person, however many of their names matched (a first name two people share isn't one person). */
  const distinct = (rs: Rule[]) => new Set(rs.map((r) => lower(r.known.real))).size;

  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (!free(w.start, w.end)) continue;
    // The longest whole name that starts here.
    let best: { n: number; rule: Rule } | null = null;
    for (const r of rules) {
      for (const seq of r.seqs) {
        if (seq.length <= (best?.n ?? 0) || i + seq.length > ws.length || !joined(i, seq.length)) continue;
        if (seq.every((s, k) => same(ws[i + k].core, s, true))) best = { n: seq.length, rule: r };
      }
    }
    if (best) {
      claim(w.start, ws[i + best.n - 1].end, best.rule.known, best.rule.known.kind === "me" ? "your business's name" : "a name in your books");
      i += best.n - 1;
      continue;
    }
    // Coming back, only a whole name counts: "Mrs Smith" from a hire may well be somebody else.
    if (opts.strong) continue;
    const word = lower(w.core);
    // "Mrs Citizen": a title and a surname.
    const next = ws[i + 1];
    if (TITLES.has(word) && next && joined(i, 2) && byLast.has(lower(next.core)) && capitalised(next.core)) {
      const rs = byLast.get(lower(next.core))!;
      if (distinct(rs) === 1) claim(w.start, next.end, rs[0].known, "a title and a surname in your books");
      else flags.push({ start: w.start, end: next.end, text: text.slice(w.start, next.end), kind: "ambiguous", why: "more than one person in your books has this surname" });
      i++;
      continue;
    }
    if (!capitalised(w.core) || w.core.length < 2 || protect.has(word)) continue;
    const firsts = byFirst.get(word);
    if (firsts) {
      if (distinct(firsts) > 1) {
        flags.push({ start: w.start, end: w.end, text: w.core, kind: "ambiguous", why: `${firsts.length} people in your books have this name, so it was left as written` });
      } else if (COMMON.has(word) && sentenceStart(text, w.start)) {
        flags.push({ start: w.start, end: w.end, text: w.core, kind: "maybe-name", why: "this may be a name in your books, or just the word" });
      } else {
        claim(w.start, w.end, firsts[0].known, firsts[0].known.person ? "a first name in your books" : "a name in your books");
      }
      continue;
    }
    // A surname alone may be someone; it's shown, not replaced.
    if (byLast.has(word) && !COMMON.has(word) && word.length >= 3) {
      flags.push({ start: w.start, end: w.end, text: w.core, kind: "maybe-name", why: "a surname in your books" });
    }
  }
  return { hits: hits.sort((a, b) => a.start - b.start), flags };
}
