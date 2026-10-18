// The team's side of Flow: what Nous says is waiting on the operator. That's a member's open question
// card, an approval asked for, and the tasks given to the operator. A card and an approval are settled
// right inside Flow; a task opens in Ogdoad's own task room.

import type { Raised } from "./flow.js";
import { Nous, type NousMember, type NousTask, type NousWaiting } from "../engineClient.js";

export interface TeamSource {
  serverUrl: string;
  companyId: string;
}

const URGENCY = { critical: 3, high: 2, medium: 1, low: 0 } as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const shortName = (name: string) => name.replace(/ - .*$/, "");

/** What's waiting and the operator's own tasks, as Flow work. Keys stay as they were, so Flow's memory of each holds. */
export function raisedFromWaiting(waiting: NousWaiting[], members: NousMember[], mine: NousTask[]): Raised[] {
  const out: Raised[] = [];
  const name = (id: string | null) => (id ? shortName(members.find((m) => m.id === id)?.name ?? "A hire") : "You");
  for (const w of waiting) {
    if (w.kind === "card") {
      const c = w.card;
      const count = c.payload.questions.length;
      const first = c.payload.questions[0]?.prompt;
      out.push({
        key: `team:ask:${c.id}`,
        title: `${name(c.authorId)} asks: ${c.title ?? c.payload.title ?? "a question"}`,
        context: `${first ? clip(first, 160) : `${name(c.authorId)} is waiting on your answer.`}${count > 1 ? ` (${count} questions)` : ""}`,
        source: "team",
        ref: `/flow/ask/${w.task.id}/${c.id}`,
        // Someone is stopped until it's answered.
        urgency: 2,
        blocking: true,
      });
      continue;
    }
    const a = w.approval;
    const said = (k: string) => (typeof a.payload[k] === "string" && a.payload[k] ? String(a.payload[k]) : null);
    // A hire's payload.title is the job it's for, not the request's: it reads "Hire Ledger (Bookkeeper)".
    const title = a.type === "hire_agent" && said("name") ? `Hire ${said("name")}${said("title") ? ` (${said("title")})` : ""}` : said("title");
    out.push({
      key: `team:approval:${a.id}`,
      title: title ? `Approve or turn down: ${clip(title, 120)}` : "Approve or turn down",
      context: `${name(a.requestedBy)} is asking you to decide.`,
      source: "team",
      ref: `/flow/approve/${a.id}`,
      urgency: 2,
      blocking: true,
    });
  }
  for (const t of mine.filter((x) => x.forOperator && !["done", "cancelled"].includes(x.status))) {
    out.push({
      key: `team:issue:${t.id}`,
      title: clip(t.title, 160),
      context: `${t.identifier} is assigned to you${t.status === "blocked" ? ", and it's blocked" : ""}.`,
      source: "team",
      ref: `/team/task/${t.id}`,
      urgency: (URGENCY[t.priority] ?? 1) as Raised["urgency"],
      blocking: t.status === "blocked",
    });
  }
  return out;
}

/** Read what's waiting on the operator. null when Nous can't be read, so Flow keeps what it had. */
export async function raisedFromTeam(src: TeamSource): Promise<Raised[] | null> {
  const nous = new Nous(src.serverUrl, 2500);
  try {
    const [waiting, members, mine] = await Promise.all([
      nous.waiting(src.companyId),
      nous.members(src.companyId),
      nous.tasks(src.companyId, { assignee: "me", limit: 100 }),
    ]);
    return raisedFromWaiting(waiting, members, mine);
  } catch {
    return null;
  }
}
