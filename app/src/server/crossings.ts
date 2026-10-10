// The crossings log: every time something the operator wrote leaves for a hire (a message, an answer to
// a question card, a request for a panel), Ogdoad notes who it went to, through which harness, and
// whether that harness is a cloud model, with a short summary. It sits in the encrypted books, so
// "what has the cloud seen?" always has an answer.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OGDOAD_HOME } from "./money/db.js";
import type { Money } from "./money/service.js";

export type Where = "cloud" | "local" | "either" | "unknown";

export interface Crossing {
  id: number;
  at: string;
  issueId: string | null;
  who: string;
  via: string;
  where: Where;
  what: string;
}

/** What Horos knows about each harness (kept in step with horos/src/harnesses.ts). */
const HARNESSES: Record<string, { name: string; where: Where }> = {
  claude: { name: "Claude Code", where: "cloud" },
  codex: { name: "Codex CLI", where: "cloud" },
  grok: { name: "grok CLI", where: "cloud" },
  gemini: { name: "Gemini CLI", where: "cloud" },
  opencode: { name: "opencode", where: "either" },
  hermes: { name: "Hermes", where: "either" },
  ollama: { name: "Ollama", where: "local" },
};

function readJsonFile(file: string): any {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Who reads a task's comments. SOPHIA's own task is known; other tasks go to "the team" for now. */
export function recipientOf(issueId: string, home = OGDOAD_HOME): { who: string; via: string; where: Where } {
  const sophia = readJsonFile(join(home, "sophia.json"));
  if (sophia && sophia.taskId === issueId) {
    const roster = readJsonFile(join(home, "horos", "roster.json"));
    const hires: any[] = Array.isArray(roster) ? roster : roster?.hires ?? [];
    const hire = hires.find((h) => h.id === sophia.hireId);
    const h = hire ? HARNESSES[hire.harness] : undefined;
    return { who: "SOPHIA", via: h?.name ?? hire?.harness ?? "her harness", where: h?.where ?? "unknown" };
  }
  return { who: "the team", via: "the Ogdoad server", where: "unknown" };
}

/** Note a crossing. body is what the browser sent (a comment, or a question card's answers). */
export function recordCrossing(money: Money, issueId: string, kind: "message" | "answer", body: Buffer, home = OGDOAD_HOME): void {
  let what = "";
  try {
    const j = JSON.parse(body.toString("utf8"));
    if (kind === "message") {
      const text = String(j.body ?? "").replace(/\s+/g, " ").trim();
      what = /^Dashboard request from the operator:/.test(text) ? `asked for a panel (the tables' shape went too, no rows): ${/"([^"]*)"/.exec(text)?.[1] ?? ""}` : text;
    } else {
      const n = Array.isArray(j.answers) ? j.answers.length : 0;
      what = `answered a question card (${n} answer${n === 1 ? "" : "s"})`;
    }
  } catch {
    what = kind === "message" ? "a message" : "answers to a question card";
  }
  const r = recipientOf(issueId, home);
  money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'crossing', ?, ?)")
    .run(new Date().toISOString(), issueId, JSON.stringify({ ...r, what: what.slice(0, 280) }));
}

export function crossings(money: Money, limit = 100): Crossing[] {
  const rows = money.db.prepare("SELECT * FROM events WHERE kind = 'crossing' ORDER BY id DESC LIMIT ?").all(limit) as Array<{ id: number; at: string; subject_id: string | null; detail: string }>;
  return rows.map((e) => {
    let d: any = {};
    try {
      d = JSON.parse(e.detail);
    } catch {}
    return { id: e.id, at: e.at, issueId: e.subject_id, who: d.who ?? "the team", via: d.via ?? "", where: d.where ?? "unknown", what: d.what ?? "" };
  });
}
