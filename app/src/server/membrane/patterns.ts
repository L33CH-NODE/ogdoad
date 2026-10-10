// The membrane's second pass: identifiers that have a shape. Each is found by its pattern and kept only
// when its check digits agree (an ABN's mod 89, a TFN's mod 11, Medicare's check digit, a card's Luhn)
// or when the words around it say what it is, so an order number isn't taken for a tax file number.

import type { Kind } from "../../shared/standins.js";
import { isValidAbn } from "../money/service.js";

export interface Found { start: number; end: number; kind: Kind; value: string; why: string }

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** A tax file number's check: weights, then mod 11 (nine digits, or the older eight). */
export function tfnOk(d: string): boolean {
  const w = d.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : d.length === 8 ? [10, 7, 8, 4, 6, 3, 5, 1] : null;
  return !!w && [...d].reduce((a, c, i) => a + Number(c) * w[i], 0) % 11 === 0;
}

/** A Medicare card number's check digit (the ninth), with an optional issue number after it. */
export function medicareOk(d: string): boolean {
  if ((d.length !== 10 && d.length !== 11) || !/^[2-6]/.test(d)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9];
  return w.reduce((a, x, i) => a + x * Number(d[i]), 0) % 10 === Number(d[8]);
}

/** A card number's Luhn check. */
export function luhnOk(d: string): boolean {
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

/** The same value however it's written: lower case for words, digits only for numbers, +61 as 0. */
export function normalise(kind: Kind, value: string): string {
  if (kind === "email") return value.trim().toLowerCase();
  if (kind === "who" || kind === "me" || kind === "address" || kind === "dob") return value.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").trim();
  const d = digitsOf(value);
  return kind === "phone" && d.startsWith("61") && d.length === 11 ? `0${d.slice(2)}` : d;
}

/** The words just before a match, for "TFN: …", "Medicare …" and the like. */
const before = (text: string, at: number, n = 32) => text.slice(Math.max(0, at - n), at).toLowerCase();
const separated = (v: string) => /[\s-]/.test(v.trim());

const STATES = "NSW|VIC|QLD|SA|WA|TAS|NT|ACT|Vic|Qld|Tas";
const STREET_TYPES = [
  "Street", "St", "Road", "Rd", "Avenue", "Ave", "Av", "Drive", "Dr", "Court", "Ct", "Place", "Pl", "Crescent", "Cres", "Lane", "Ln", "Way", "Parade", "Pde",
  "Terrace", "Tce", "Close", "Cl", "Boulevard", "Boulevarde", "Blvd", "Bvd", "Highway", "Hwy", "Circuit", "Cct", "Grove", "Gr", "Esplanade", "Esp", "Square", "Sq",
  "Rise", "Mews", "Track", "Trail", "Loop", "Row", "Walk", "Promenade", "Circle", "Cir", "Gardens", "Gdns", "Heights", "Hts", "Ridge", "Glade", "Retreat",
];
const STREET = STREET_TYPES.flatMap((w) => [w, w.toLowerCase(), w.toUpperCase()]).join("|");
const NAME_WORD = "[A-Z][\\p{L}'’-]+";
const SUBURB = `(?:,\\s*${NAME_WORD}(?:\\s+${NAME_WORD}){0,2}|\\s+${NAME_WORD}(?:\\s+${NAME_WORD}){0,2}(?=,?\\s+(?:${STATES}|\\d{4})\\b))`;
const TAIL = `${SUBURB}?(?:,?\\s+(?:${STATES}))?(?:,?\\s+\\d{4})?(?!\\d)`;

interface Pattern { kind: Kind; re: RegExp; group?: number; why: string; accept?: (value: string, text: string, start: number) => boolean }

/** In order: what's surest first, so a phone number is never read as an ABN. */
const PATTERNS: Pattern[] = [
  { kind: "email", re: /(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g, why: "an email address" },
  { kind: "phone", re: /(?<![\w+])(?:\+?61[\s-]?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/g, why: "a mobile number" },
  {
    kind: "phone", re: /(?<![\w+(])(?:\+?61[\s-]?\(?0?[2378]\)?|\(0[2378]\)|0[2378])[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g, why: "a phone number",
    accept: (v) => [10, 11].includes(digitsOf(v).length),
  },
  { kind: "phone", re: /(?<![\w+])\+(?!61)\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d){5,12}(?!\d)/g, why: "a phone number", accept: (v) => digitsOf(v).length >= 8 && digitsOf(v).length <= 15 },
  { kind: "ndis", re: /\bNDIS\b[^\d\n]{0,20}(\d(?:[\s-]?\d){8})(?!\d)/dgi, group: 1, why: "an NDIS number" },
  { kind: "ndis", re: /(?<![\d./-])43\d[\s-]?\d{3}[\s-]?\d{3}(?![\d./-])/g, why: "an NDIS number" },
  { kind: "abn", re: /(?<![\d./-])\d{2}\s?\d{3}\s?\d{3}\s?\d{3}(?![\d./-])/g, why: "an ABN", accept: (v) => isValidAbn(digitsOf(v)) },
  { kind: "bank", re: /(?<![\d./-])\d{3}-\d{3}[\s,/]+\d{6,10}(?![\d./-])/g, why: "a BSB and account number" },
  { kind: "bank", re: /\bBSB\b[\s:#.-]*(\d{3}[\s-]?\d{3})(?!\d)/dgi, group: 1, why: "a BSB" },
  { kind: "bank", re: /\b(?:acc(?:oun)?t|a\/c|acct)\.?\s*(?:no\.?|num(?:ber)?|#)?[\s:#.-]*(\d(?:[\s-]?\d){4,9})(?!\d)/dgi, group: 1, why: "an account number" },
  {
    kind: "medicare", re: /(?<![\d./-])[2-6]\d{3}[\s-]?\d{5}[\s-]?\d(?:[\s/-]?\d)?(?![\d./-])/g, why: "a Medicare number",
    accept: (v, t, s) => medicareOk(digitsOf(v)) && (separated(v) || /medicare/.test(before(t, s))),
  },
  {
    kind: "tfn", re: /(?<![\d./-])\d{3}[\s-]?\d{3}[\s-]?\d{2,3}(?![\d./-])/g, why: "a tax file number",
    accept: (v, t, s) => tfnOk(digitsOf(v)) && (/\b(tfn|tax file)/.test(before(t, s)) || /^\d{3}[\s-]\d{3}[\s-]\d{3}$/.test(v)),
  },
  {
    kind: "card", re: /(?<![\d./-])(?:(?:\d{4}[\s-]){3}\d{1,7}|\d{4}[\s-]\d{6}[\s-]\d{5}|\d{13,19})(?![\d./-])/g, why: "a card number",
    accept: (v) => luhnOk(digitsOf(v)),
  },
  {
    kind: "dob",
    re: /\b(?:DOB|D\.O\.B\.?|date of birth|born(?:\s+on)?|birthday)\b[\s:,-]*(\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/dgi,
    group: 1, why: "a date of birth",
  },
  {
    kind: "address",
    re: new RegExp(`(?<![\\w/])(?:(?:Unit|Apt|Apartment|Flat|Suite|Shop|Level|Lvl|U)\\s*\\d+[A-Za-z]?\\s*[,/]?\\s*|\\d{1,5}[A-Za-z]?\\s*/\\s*)?\\d{1,5}[A-Za-z]?(?:\\s*-\\s*\\d{1,5})?\\s+(?:${NAME_WORD}\\s+){1,3}(?:${STREET})\\.?(?![\\p{L}])${TAIL}`, "gu"),
    why: "a street address",
  },
  { kind: "address", re: new RegExp(`\\b(?:P\\.?\\s?O\\.?\\s+Box|PO\\s?Box|GPO\\s+Box|Locked\\s+Bag)\\s+\\d+\\b${TAIL}`, "gu"), why: "a postal address" },
];

/** Every identifier with a shape in the text, outside the spans already taken. */
export function findPatterns(text: string, taken: Array<[number, number]> = [], only?: (kind: Kind) => boolean): Found[] {
  const out: Found[] = [];
  const claimed = [...taken];
  const free = (s: number, e: number) => !claimed.some(([a, b]) => s < b && e > a);
  for (const p of PATTERNS) {
    if (only && !only(p.kind)) continue;
    for (const m of text.matchAll(p.re)) {
      const g = p.group ?? 0;
      const value = m[g];
      if (!value) continue;
      const start = g ? m.indices![g][0] : m.index!;
      const end = start + value.length;
      if (!free(start, end)) continue;
      if (p.accept && !p.accept(value, text, start)) continue;
      claimed.push([start, end]);
      out.push({ start, end, kind: p.kind, value, why: p.why });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
