// The hires' work on the Artifacts shelf: the documents they write on their tasks (a company profile, a
// plan, a letter draft), with where each came from. Who wrote it, through which harness, and whether
// that harness is a cloud model. Read from the Ogdoad server and kept for a minute, since the shelf
// asks often.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Artifact } from "./center.js";
import { engineAuth } from "./engineClient.js";
import { OGDOAD_HOME } from "./money/db.js";

const CLOUD = new Set(["claude", "codex", "grok", "gemini"]);
const LOCAL = new Set(["ollama"]);
const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", grok: "grok CLI", gemini: "Gemini CLI", opencode: "opencode", hermes: "Hermes", ollama: "Ollama" };

interface Doc { id: string; issueId: string; key: string; title: string | null; createdByAgentId: string | null; createdByUserId: string | null; updatedAt: string }
interface Issue { id: string; identifier: string | null; title: string; updatedAt: string }
interface Agent { id: string; name: string }

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
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${serverUrl}${path}`, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json", ...engineAuth() } });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.json()) as T;
  };
  try {
    const c = encodeURIComponent(companyId);
    const [issuesRaw, agentsRaw] = await Promise.all([get<Issue[] | { items: Issue[] }>(`/api/companies/${c}/issues?limit=30`), get<Agent[] | { items: Agent[] }>(`/api/companies/${c}/agents`)]);
    const issues = Array.isArray(issuesRaw) ? issuesRaw : issuesRaw.items ?? [];
    const agents = Array.isArray(agentsRaw) ? agentsRaw : agentsRaw.items ?? [];
    const docs = (await Promise.all(issues.map((i) => get<Doc[]>(`/api/issues/${encodeURIComponent(i.id)}/documents`).then((d) => (Array.isArray(d) ? d : []), () => [] as Doc[])))).flat();
    const hires = rosterHires(home);
    const list = docs.map((d): Artifact => {
      const agent = agents.find((a) => a.id === d.createdByAgentId);
      const hire = d.createdByAgentId ? hires.find((h) => h.seat?.agentId === d.createdByAgentId) : null;
      const harness = String(hire?.harness ?? "");
      const issue = issues.find((i) => i.id === d.issueId);
      const cloud = CLOUD.has(harness);
      return {
        id: `doc:${d.id}`,
        kind: "document",
        title: `${d.title || d.key}${issue?.identifier ? ` · ${issue.identifier}` : ""}`,
        by: d.createdByUserId ? "you" : (agent?.name ?? "a hire").replace(/ - .*$/, ""),
        via: d.createdByUserId ? "the classic view" : NAMES[harness] ?? "its harness",
        at: new Date(d.updatedAt).toISOString(),
        tier: d.createdByUserId ? "local only" : cloud ? "made by a cloud hire" : LOCAL.has(harness) ? "made on this machine" : "made by a hire",
        cloudSaw: d.createdByUserId ? "nothing" : cloud ? `whatever its task gave ${NAMES[harness]}; check "What the cloud has seen"` : LOCAL.has(harness) ? "nothing" : "depends on the hire's harness",
        sealed: false,
        open: null,
        ref: `/team/task/${d.issueId}`,
        source: { issueId: d.issueId, key: d.key },
      };
    });
    cached = { at: Date.now(), key, list };
    return list;
  } catch {
    return null;
  }
}
