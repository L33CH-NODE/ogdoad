#!/usr/bin/env node
// Moving in: bring a company from the engine Ogdoad started on into Nous, through each engine's own
// API. It only reads from the old engine; it writes through Nous's operator-only import, which keeps
// every id, number and time and wakes nobody. Run it again and it updates what's there, so the last
// run before the switch catches anything new.
//
//   node nous/dist/importPaperclip.js --from http://127.0.0.1:3100 --to http://127.0.0.1:3100 \
//     --token-file ~/.ogdoad/nous/operator.token [--keys ~/.paperclip/live-agent/keys] [--company <id>]
//
// It prints counts only, never what's in them, and exits 1 if the two engines disagree.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ImportBatch } from "./engine.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const FROM = (flag("from") ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const TO = (flag("to") ?? "").replace(/\/+$/, "");
const TOKEN = flag("token-file") ? readFileSync(flag("token-file")!, "utf8").trim() : process.env.NOUS_OPERATOR_TOKEN ?? "";
const KEYS = flag("keys");
const CHUNK = 200;

async function from<T = any>(path: string): Promise<T> {
  const r = await fetch(`${FROM}${path}`, { headers: { accept: "application/json", origin: FROM } });
  if (!r.ok) throw new Error(`the old engine answered ${r.status} to GET ${path.replace(/[0-9a-f-]{36}/g, ":id")}`);
  return (await r.json()) as T;
}
const list = (b: any): any[] => (Array.isArray(b) ? b : (b?.items ?? []));

async function to(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${TO}${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Nous answered ${r.status} to ${method} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const TASK = new Set(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"]);
const PRIORITY = new Set(["critical", "high", "medium", "low"]);
const memberStatus = (s: string) => (s === "terminated" ? "let_go" : s === "paused" || s === "pending_approval" ? "paused" : "idle");
const cardStatus = (s: string) => (s === "pending" ? "pending" : ["answered", "accepted", "resolved", "rejected"].includes(s) ? "answered" : "withdrawn");
const approvalStatus = (s: string) => (s === "approved" ? "approved" : s === "rejected" || s === "cancelled" ? "rejected" : "pending");

/** Parents before children, so every chunk's parents are already in. */
function parentsFirst<T extends { id: string; parentId: string | null }>(tasks: T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (t: T, depth = 0) => {
    if (seen.has(t.id) || depth > 64) return;
    const p = t.parentId ? byId.get(t.parentId) : undefined;
    if (p) visit(p, depth + 1);
    seen.add(t.id);
    out.push(t);
  };
  tasks.forEach((t) => visit(t));
  return out;
}

async function importCompany(companyId: string): Promise<boolean> {
  const c = await from(`/api/companies/${companyId}`);
  const agents = list(await from(`/api/companies/${companyId}/agents`));
  const projects = list(await from(`/api/companies/${companyId}/projects`));

  const issues: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = list(await from(`/api/companies/${companyId}/issues?limit=1000&offset=${offset}`));
    issues.push(...page);
    if (page.length < 1000) break;
  }
  // A parent the list didn't include (hidden, say) is fetched on its own.
  const have = new Set(issues.map((i) => i.id));
  for (let i = 0; i < issues.length; i++) {
    const p = issues[i].parentId;
    if (p && !have.has(p)) {
      issues.push(await from(`/api/issues/${p}`));
      have.add(p);
    }
  }

  const batch: ImportBatch = {
    company: { id: c.id, name: c.name, prefix: c.issuePrefix, nextNumber: (c.issueCounter ?? 0) + 1, createdAt: c.createdAt, updatedAt: c.updatedAt },
    members: agents.map((a) => {
      const keyFile = KEYS ? join(KEYS, `${a.id}.key`) : null;
      return {
        id: a.id, name: a.name, role: a.role ?? "general", title: a.title ?? "", capabilities: a.capabilities ?? "", status: memberStatus(a.status),
        mailboxKey: keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : null, createdAt: a.createdAt, updatedAt: a.updatedAt,
      };
    }),
    rooms: projects.map((p) => ({ id: p.id, name: p.name, brief: p.description ?? null, status: p.status ?? "in_progress", leadId: p.leadAgentId ?? null, color: p.color ?? null, archivedAt: p.archivedAt ?? null, createdAt: p.createdAt, updatedAt: p.updatedAt })),
    tasks: parentsFirst(issues.map((i) => ({
      id: i.id, roomId: i.projectId ?? null, parentId: i.parentId ?? null, number: i.issueNumber, title: i.title, description: i.description ?? "",
      status: TASK.has(i.status) ? i.status : "todo", priority: PRIORITY.has(i.priority) ? i.priority : "medium",
      assigneeId: i.assigneeAgentId ?? null, forOperator: !!i.assigneeUserId, authorId: i.createdByAgentId ?? null,
      startedAt: i.startedAt ?? null, finishedAt: i.completedAt ?? i.cancelledAt ?? null, createdAt: i.createdAt, updatedAt: i.updatedAt,
    }))),
    messages: [],
    docs: [],
    cards: [],
    approvals: [],
  };

  for (const i of issues) {
    for (let after: string | null = null; ;) {
      const page = list(await from(`/api/issues/${i.id}/comments?order=asc&limit=500${after ? `&after=${after}` : ""}`));
      batch.messages.push(...page.map((m: any) => ({ id: m.id, taskId: i.id, authorId: m.authorAgentId ?? null, body: m.body ?? "", requestId: m.clientRequestId ?? null, createdAt: m.createdAt })));
      if (page.length < 500) break;
      after = page[page.length - 1].id;
    }
    for (const d of list(await from(`/api/issues/${i.id}/documents`))) {
      batch.docs.push({ id: d.id, taskId: i.id, key: d.key, title: d.title ?? d.key, format: d.format ?? "markdown", body: d.body ?? "", revision: d.latestRevisionNumber ?? 1, authorId: d.createdByAgentId ?? null, createdAt: d.createdAt, updatedAt: d.updatedAt });
    }
    for (const x of list(await from(`/api/issues/${i.id}/interactions`))) {
      batch.cards.push({
        id: x.id, taskId: i.id, kind: x.kind, title: x.title ?? null, payload: x.payload ?? { questions: [] }, status: cardStatus(x.status), authorId: x.createdByAgentId ?? null,
        answers: x.result?.answers ?? null, answeredAt: x.resolvedAt ?? null, createdAt: x.createdAt, updatedAt: x.updatedAt,
      });
    }
  }
  for (const a of list(await from(`/api/companies/${companyId}/approvals`))) {
    const linked = list(await from(`/api/approvals/${a.id}/issues`)).map((x: any) => x.id).filter((id: string) => have.has(id));
    batch.approvals.push({
      id: a.id, type: a.type, payload: a.payload ?? {}, status: approvalStatus(a.status), note: a.decisionNote ?? null, requestedBy: a.requestedByAgentId ?? null,
      taskIds: linked, decidedAt: a.decidedAt ?? null, createdAt: a.createdAt, updatedAt: a.updatedAt,
    });
  }

  // In chunks: the company, its people and rooms first, then everything that hangs off tasks.
  const empty = { members: [], rooms: [], tasks: [], messages: [], docs: [], cards: [], approvals: [] };
  await to("POST", "/v1/import", { ...empty, company: batch.company, members: batch.members, rooms: batch.rooms });
  for (const key of ["tasks", "messages", "docs", "cards", "approvals"] as const) {
    const all = batch[key] as unknown[];
    for (let i = 0; i < all.length; i += CHUNK) await to("POST", "/v1/import", { ...empty, company: batch.company, [key]: all.slice(i, i + CHUNK) });
  }

  const want = { members: batch.members.length, rooms: batch.rooms.length, tasks: batch.tasks.length, messages: batch.messages.length, docs: batch.docs.length, cards: batch.cards.length, approvals: batch.approvals.length };
  const got = (await to("GET", `/v1/companies/${companyId}/counts`)) as Record<string, number>;
  const rows = Object.keys(want).map((k) => ({ what: k, old: want[k as keyof typeof want], nous: got[k] }));
  const same = rows.every((r) => r.old === r.nous);
  console.log(`${same ? "ok  " : "DIFF"} company ${companyId.slice(0, 8)}: ${rows.map((r) => `${r.what} ${r.old}${r.old === r.nous ? "" : `->${r.nous}`}`).join(", ")}`);
  return same;
}

async function main(): Promise<void> {
  if (!TO || !TOKEN) throw new Error("Usage: importPaperclip --from <old engine url> --to <nous url> --token-file <nous operator.token> [--keys <dir>] [--company <id>]");
  const ids = flag("company") ? [flag("company")!] : list(await from("/api/companies")).map((c: any) => c.id);
  let allSame = true;
  for (const id of ids) allSame = (await importCompany(id)) && allSame;
  if (!allSame) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
