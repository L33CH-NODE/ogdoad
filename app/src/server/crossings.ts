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

export interface Recipient { who: string; via: string; where: Where }

function describe(hire: any, who: string): Recipient {
  const h = hire ? HARNESSES[hire.harness] : undefined;
  return { who, via: h?.name ?? hire?.harness ?? "its harness", where: h?.where ?? "unknown" };
}

function rosterHires(home: string): any[] {
  const roster = readJsonFile(join(home, "horos", "roster.json"));
  return Array.isArray(roster) ? roster : roster?.hires ?? [];
}

/** Who reads a task's comments, when it's SOPHIA's own task (known without asking anyone). */
export function recipientOf(issueId: string, home = OGDOAD_HOME): Recipient | null {
  const sophia = readJsonFile(join(home, "sophia.json"));
  if (!sophia || sophia.taskId !== issueId) return null;
  return describe(rosterHires(home).find((h) => h.id === sophia.hireId), "SOPHIA");
}

/**
 * Who reads a task's comments: SOPHIA for her own task; otherwise the task's assignee, matched to the
 * hire whose seat that agent is (Horos's roster), so the harness (and the cloud) is named.
 */
export async function recipientFor(issueId: string, serverUrl: string, home = OGDOAD_HOME): Promise<Recipient> {
  const known = recipientOf(issueId, home);
  if (known) return known;
  try {
    const r = await fetch(`${serverUrl}/api/issues/${encodeURIComponent(issueId)}`, { signal: AbortSignal.timeout(2500), headers: { accept: "application/json" } });
    const issue = r.ok ? ((await r.json()) as { assigneeAgentId?: string | null }) : null;
    const agentId = issue?.assigneeAgentId;
    if (agentId) {
      const hire = rosterHires(home).find((h) => h.seat?.agentId === agentId);
      if (hire) return describe(hire, String(hire.label ?? "a hire").replace(/ - .*$/, ""));
      return { who: "an agent", via: "the Ogdoad server", where: "unknown" };
    }
  } catch {
    // Unknown is still recorded.
  }
  return { who: "the team", via: "the Ogdoad server", where: "unknown" };
}

/** Who a hire is, from Horos's roster: for what's typed straight into its terminal. */
export function recipientOfHire(hireId: string, home = OGDOAD_HOME, fallback?: { label?: string; harness?: string }): Recipient {
  const hire = rosterHires(home).find((h) => h.id === hireId) ?? (fallback ? { harness: fallback.harness, label: fallback.label } : null);
  return describe(hire, String(hire?.label ?? "a hire").replace(/ - .*$/, ""));
}

/** The hire whose seat an agent is (for an approval's note, which goes back to the agent that asked). */
export function recipientOfAgent(agentId: string | null | undefined, home = OGDOAD_HOME): Recipient {
  const hire = agentId ? rosterHires(home).find((h) => h.seat?.agentId === agentId) : null;
  return hire ? describe(hire, String(hire.label ?? "a hire").replace(/ - .*$/, "")) : { who: agentId ? "an agent" : "the team", via: "the Ogdoad server", where: "unknown" };
}

/** The agents a message mentions, in the engine's own form: [@Name](agent://<id>). Each once. */
export function mentionsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\[@[^\]]*\]\(agent:\/\/([^)\s]+)\)/g)].map((m) => m[1]))];
}

/** The hire whose seat an agent is, if Horos keeps one: for presence and the cloud/local tag. */
export function hireOfAgent(agentId: string, home = OGDOAD_HOME): { hireId: string; harness: string; via: string; where: Where } | null {
  const hire = rosterHires(home).find((h) => h.seat?.agentId === agentId);
  if (!hire) return null;
  const d = describe(hire, "");
  return { hireId: String(hire.id), harness: String(hire.harness), via: d.via, where: d.where };
}

/**
 * Everyone a comment reaches: the task's reader and every agent it mentions (the engine wakes each), once
 * each. "The team" stands in only when nobody more specific gets it.
 */
export async function recipientsOfComment(issueId: string, text: string, serverUrl: string, home = OGDOAD_HOME): Promise<Recipient[]> {
  const reader = await recipientFor(issueId, serverUrl, home);
  const mentioned = mentionsIn(text).map((id) => recipientOfAgent(id, home));
  const all = mentioned.length && reader.who === "the team" ? mentioned : [reader, ...mentioned];
  const seen = new Set<string>();
  return all.filter((r) => {
    const k = `${r.who}|${r.via}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Note text that went straight to a hire (typed into its terminal, or its first message). */
export function recordDirectCrossing(money: Money, hireId: string, text: string, to: Recipient): void {
  const what = text.replace(/\s+/g, " ").trim().slice(0, 280);
  money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'crossing', ?, ?)")
    .run(new Date().toISOString(), `hire:${hireId}`, JSON.stringify({ ...to, what: what || "a message" }));
}

/** Note a crossing. body is what the browser sent (a comment, or a question card's answers). */
export function recordCrossing(money: Money, issueId: string, kind: "message" | "answer", body: Buffer, to: Recipient): void {
  let what = "";
  try {
    const j = JSON.parse(body.toString("utf8"));
    if (kind === "message") {
      // Mentions read as names here, as they do in the room.
      const text = String(j.body ?? "").replace(/\[@([^\]]*)\]\(agent:\/\/[^)\s]+\)/g, "@$1").replace(/\s+/g, " ").trim();
      what = /^Dashboard request from the operator:/.test(text) ? `asked for a panel (the tables' shape went too, no rows): ${/"([^"]*)"/.exec(text)?.[1] ?? ""}` : text;
    } else {
      const n = Array.isArray(j.answers) ? j.answers.length : 0;
      what = `answered a question card (${n} answer${n === 1 ? "" : "s"})`;
    }
  } catch {
    what = kind === "message" ? "a message" : "answers to a question card";
  }
  money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'crossing', ?, ?)")
    .run(new Date().toISOString(), issueId, JSON.stringify({ ...to, what: what.slice(0, 280) }));
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
