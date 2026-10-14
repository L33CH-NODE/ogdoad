// The team's side of Flow: what the Ogdoad server says is waiting on the operator. That's its attention
// feed (a hire's question card, an approval, a failed run, a budget alert) plus the tasks assigned to
// the operator. A question card is answered right inside Flow; everything else opens where it lives.

import type { Raised } from "./flow.js";
import { engineAuth } from "../engineClient.js";

export interface TeamSource {
  serverUrl: string;
  companyId: string;
  /** Where the classic UI lives, for items Ogdoad can't settle in place yet. */
  classicUrl?: string;
}

const URGENCY = { critical: 3, high: 2, medium: 1, low: 0 } as const;
type Severity = keyof typeof URGENCY;

interface AttentionSubject { kind: string; id: string; title: string | null; identifier: string | null; status: string | null; href: string | null }
interface AttentionItem {
  sourceKind: string;
  subject: AttentionSubject;
  whyNow: string;
  severity: Severity;
  relatedIssue: AttentionSubject | null;
  originAgentName: string | null;
  dismissal: { isActive: boolean } | null;
  snoozedUntil: string | null;
  detail: { kind: string; firstQuestionText?: string | null; questionCount?: number; createdByAgentName?: string | null } | null;
}
interface AssignedIssue { id: string; identifier: string | null; title: string; status: string; priority?: string | null }

const OPENING: Record<string, string> = {
  approval: "Approve or turn down",
  decision: "Decide",
  join_request: "Someone asks to join",
  recovery_action: "A hire needs help recovering",
  failed_run: "A run failed",
  budget_alert: "Budget",
  agent_error_alert: "A hire hit an error",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The attention feed and the operator's assigned tasks, as Flow work. */
export function raisedFromAttention(items: AttentionItem[], assigned: AssignedIssue[], classicUrl: string): Raised[] {
  const out: Raised[] = [];
  const now = Date.now();
  for (const i of items) {
    if (i.dismissal?.isActive || (i.snoozedUntil && Date.parse(i.snoozedUntil) > now)) continue;
    const urgency = URGENCY[i.severity] ?? 1;
    if (i.sourceKind === "issue_thread_interaction" && i.detail?.kind === "questions" && i.relatedIssue) {
      const who = i.detail.createdByAgentName ?? i.originAgentName ?? "A hire";
      const count = i.detail.questionCount ?? 1;
      out.push({
        key: `team:ask:${i.subject.id}`,
        title: `${who.replace(/ - .*$/, "")} asks: ${i.subject.title ?? "a question"}`,
        context: `${i.detail.firstQuestionText ? clip(i.detail.firstQuestionText, 160) : i.whyNow}${count > 1 ? ` (${count} questions)` : ""}`,
        source: "team",
        ref: `/flow/ask/${i.relatedIssue.id}/${i.subject.id}`,
        // Someone is stopped until it's answered.
        urgency: Math.max(2, urgency) as Raised["urgency"],
        blocking: true,
      });
      continue;
    }
    // An approval is decided right in Flow.
    if (i.sourceKind === "approval" && i.subject.kind === "approval") {
      out.push({
        key: `team:approval:${i.subject.id}`,
        title: i.subject.title ? `Approve or turn down: ${clip(i.subject.title, 120)}` : "Approve or turn down",
        context: i.whyNow, source: "team", ref: `/flow/approve/${i.subject.id}`,
        urgency: Math.max(2, urgency) as Raised["urgency"], blocking: true,
      });
      continue;
    }
    const opening = OPENING[i.sourceKind] ?? "Needs you";
    out.push({
      key: `team:${i.sourceKind}:${i.subject.id}`,
      title: i.subject.title ? `${opening}: ${clip(i.subject.title, 120)}` : opening,
      context: i.whyNow,
      source: "team",
      ref: i.subject.href ? `${classicUrl}${i.subject.href}` : null,
      urgency: urgency as Raised["urgency"],
      blocking: i.sourceKind === "approval" || i.sourceKind === "decision" || i.sourceKind === "recovery_action",
    });
  }
  for (const t of assigned.filter((x) => !["done", "cancelled"].includes(x.status))) {
    const prefix = t.identifier?.split("-")[0];
    out.push({
      key: `team:issue:${t.id}`,
      title: clip(t.title, 160),
      context: `${t.identifier ?? "A task"} is assigned to you${t.status === "blocked" ? ", and it's blocked" : ""}.`,
      source: "team",
      ref: prefix && t.identifier ? `${classicUrl}/${prefix}/issues/${t.identifier}` : null,
      urgency: (URGENCY[(t.priority ?? "medium") as Severity] ?? 1) as Raised["urgency"],
      blocking: t.status === "blocked",
    });
  }
  return out;
}

/** Read what's waiting on the operator. null when the server can't be read, so Flow keeps what it had. */
export async function raisedFromTeam(src: TeamSource): Promise<Raised[] | null> {
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${src.serverUrl}${path}`, { signal: AbortSignal.timeout(2500), headers: { accept: "application/json", ...engineAuth() } });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return (await r.json()) as T;
  };
  try {
    const company = encodeURIComponent(src.companyId);
    const [feed, assigned] = await Promise.all([
      get<{ items: AttentionItem[] }>(`/api/companies/${company}/attention?all=true`),
      get<AssignedIssue[] | { items: AssignedIssue[] }>(`/api/companies/${company}/issues?assigneeUserId=me&limit=100`),
    ]);
    return raisedFromAttention(feed.items ?? [], Array.isArray(assigned) ? assigned : assigned.items ?? [], src.classicUrl ?? src.serverUrl);
  } catch {
    return null;
  }
}
