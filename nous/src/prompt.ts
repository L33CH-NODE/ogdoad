// What a member reads when it wakes: who it is, what happened, the task and its latest talk, and how
// to act and to finish. Plain, so any harness can follow it.

import type { Engine, Member } from "./engine.js";
import type { Run } from "./work.js";

const REASON: Record<Run["reason"], string> = {
  assigned: "a task was given to you",
  message: "there's a new message on your task",
  mention: "someone named you in a message",
  answer: "the operator answered your card",
  decision: "the operator decided your approval",
  unfinished: "you closed your last job with your task still in progress: finish it properly",
};

export function promptFor(engine: Engine, run: Run, member: Member, apiUrl: string): string {
  const company = engine.company(member.companyId);
  const lines: string[] = [
    `You're ${member.name}${member.title ? `, ${member.title}` : ""} at ${company.name}. You're awake because ${REASON[run.reason]}.`,
    "",
  ];

  if (run.taskId) {
    const t = engine.task(run.taskId);
    lines.push(`Task ${t.identifier}: ${t.title} (${t.status.replace("_", " ")}, ${t.priority} priority)`);
    if (t.description.trim()) lines.push("", t.description.trim());
    const talk = engine.messages(t.id, { limit: 10 }).reverse();
    if (talk.length) {
      lines.push("", "Latest talk on it (oldest first):");
      for (const m of talk) {
        const who = m.authorId ? (m.authorId === member.id ? "you" : engine.member(m.authorId).name) : "the operator";
        const marker = m.id === run.wake.messageId ? " (this woke you)" : "";
        lines.push(`- ${who}${marker}: ${m.body.length > 1500 ? `${m.body.slice(0, 1500)}…` : m.body}`);
      }
    }
  }
  if (run.wake.cardId) {
    const c = engine.card(run.wake.cardId);
    lines.push("", `Your card "${c.title ?? "questions"}" was answered:`);
    for (const a of c.answers ?? []) {
      const q = c.payload.questions.find((x) => x.id === a.questionId);
      const picked = a.optionIds.map((id) => q?.options.find((o) => o.id === id)?.label ?? id).join(", ");
      lines.push(`- ${q?.prompt ?? a.questionId} ${[picked, a.otherText].filter(Boolean).join(": ")}`);
    }
  }
  if (run.wake.approvalId) {
    const a = engine.approval(run.wake.approvalId);
    lines.push("", `Your approval "${String(a.payload.title ?? a.type)}" was ${a.status}${a.note ? `, with this note: ${a.note}` : "."}`);
  }

  lines.push(
    "",
    `To act, call ${apiUrl}/v1 with \`Authorization: Bearer $NOUS_RUN_TOKEN\` (this run's token, in your job's env; it stops working when the job closes). \`GET ${apiUrl}/v1/openapi.json\` lists every route.`,
    "Reply on the task, claim it, update it, write documents on it, ask the operator with a card, or ask for an approval.",
    "Finish by settling the task: done, or in review while a card or an approval of yours waits on the operator. Then close the job.",
  );
  return lines.join("\n");
}
