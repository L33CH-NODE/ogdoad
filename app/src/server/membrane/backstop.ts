// The membrane's third pass: a local model, for what the books and the patterns can't know (a name
// nobody entered, an address in passing, a key pasted by mistake). It runs on this machine (OpenAI's
// Privacy Filter, on the CPU in WSL, behind a small service that never logs what it reads). What it
// finds is shown to the operator as possibly sensitive: never replaced quietly, never passed quietly.

import type { Kind } from "../../shared/standins.js";

export interface ModelSpan { label: string; start: number; end: number; text: string; score: number }

/** Where the model listens; OGDOAD_BACKSTOP_URL=off turns the pass off. */
export const BACKSTOP_URL = process.env.OGDOAD_BACKSTOP_URL ?? "http://127.0.0.1:11441";

/** What each label is, in words, and the stand-in it can become once the operator says so. */
export const MODEL_LABEL: Record<string, { word: string; kind?: Kind }> = {
  private_person: { word: "a name your books don't have", kind: "who" },
  private_address: { word: "an address", kind: "address" },
  private_email: { word: "an email address", kind: "email" },
  private_phone: { word: "a phone number", kind: "phone" },
  account_number: { word: "an account number", kind: "bank" },
  private_url: { word: "a private link" },
  private_date: { word: "a date that may be a birthday", kind: "dob" },
  secret: { word: "a secret (a key or a password): take it out" },
};

/** The model's spans for a text, or null when it couldn't be asked (off, down, or slow). */
export async function scan(text: string, protect: string[], url: string | null = BACKSTOP_URL, timeoutMs = 2500): Promise<ModelSpan[] | null> {
  if (!url || url === "off" || !text.trim()) return url && url !== "off" ? [] : null;
  try {
    const r = await fetch(`${url}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, protect }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { spans?: ModelSpan[] };
    return Array.isArray(body.spans) ? body.spans.filter((s) => Number.isInteger(s.start) && Number.isInteger(s.end) && s.end > s.start && s.end <= text.length) : null;
  } catch {
    return null;
  }
}
