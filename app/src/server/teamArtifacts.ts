// The hires' work on the Artifacts shelf: the documents they write on their tasks (a company profile, a
// plan, a letter draft), with where each came from. Who wrote it, through which harness, and whether
// that harness is a cloud model. Read from the Ogdoad server and kept for a minute, since the shelf
// asks often.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Artifact } from "./center.js";
import { Nous, type NousDoc } from "./engineClient.js";
import { OGDOAD_HOME } from "./money/db.js";

const CLOUD = new Set(["claude", "codex", "grok", "gemini"]);
const LOCAL = new Set(["ollama"]);
const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", grok: "grok CLI", gemini: "Gemini CLI", opencode: "opencode", hermes: "Hermes", ollama: "Ollama" };

let cached: { at: number; key: string; list: Artifact[] } | null = null;

function rosterHires(home: string): any[] {
  try {
    const r = JSON.parse(readFileSync(join(home, "horos", "roster.json"), "utf8"));
    return Array.isArray(r) ? r : r?.hires ?? [];
  } catch {
    return [];
  }
}

/** Documents on the company's recent tasks, as artifacts. null when the server can't be read. */
export async function teamArtifacts(serverUrl: string, companyId: string, home = OGDOAD_HOME): Promise<Artifact[] | null> {
  const key = `${serverUrl}|${companyId}`;
  if (cached && cached.key === key && Date.now() - cached.at < 60_000) return cached.list;
  const nous = new Nous(serverUrl, 4000);
  try {
    const [issues, agents] = await Promise.all([nous.tasks(companyId, { limit: 30 }), nous.members(companyId)]);
    const docs = (await Promise.all(issues.map((i) => nous.docs(i.id).catch((): NousDoc[] => [])))).flat();
    const hires = rosterHires(home);
    const list = docs.map((d): Artifact => {
      // A document with no author is the operator's own.
      const yours = !d.authorId;
      const agent = agents.find((a) => a.id === d.authorId);
      const hire = d.authorId ? hires.find((h) => h.seat?.agentId === d.authorId) : null;
      const harness = String(hire?.harness ?? "");
      const issue = issues.find((i) => i.id === d.taskId);
      const cloud = CLOUD.has(harness);
      return {
        id: `doc:${d.id}`,
        kind: "document",
        title: `${d.title || d.key}${issue?.identifier ? ` · ${issue.identifier}` : ""}`,
        by: yours ? "you" : (agent?.name ?? "a hire").replace(/ - .*$/, ""),
        via: yours ? "Ogdoad" : NAMES[harness] ?? "its harness",
        at: new Date(d.updatedAt).toISOString(),
        tier: yours ? "local only" : cloud ? "made by a cloud hire" : LOCAL.has(harness) ? "made on this machine" : "made by a hire",
        cloudSaw: yours ? "nothing" : cloud ? `whatever its task gave ${NAMES[harness]}; check "What the cloud has seen"` : LOCAL.has(harness) ? "nothing" : "depends on the hire's harness",
        sealed: false,
        open: null,
        ref: `/team/task/${d.taskId}`,
        source: { issueId: d.taskId, key: d.key },
      };
    });
    cached = { at: Date.now(), key, list };
    return list;
  } catch {
    return null;
  }
}
