// The team's tasks, in the Team zone: what's in hand and who has it, newest first. Any task opens as a
// conversation (its thread, its question cards, a reply), so the classic view isn't needed day to day.

import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { Conversation } from "./Conversation";
import { useCenter } from "./data";

export interface TeamTask { id: string; identifier: string | null; title: string; status: string; assigneeAgentId: string | null; assigneeUserId: string | null; updatedAt: string }
interface Agent { id: string; name: string }

export const STATUS: Record<string, { word: string; tone: string }> = {
  backlog: { word: "later", tone: "" }, todo: { word: "to do", tone: "t-c1" }, in_progress: { word: "in hand", tone: "t-primary" },
  in_review: { word: "in review", tone: "t-c1" }, blocked: { word: "blocked", tone: "t-warn" }, done: { word: "done", tone: "t-good" }, cancelled: { word: "cancelled", tone: "" },
};

/** The company's recent tasks and its agents' names, kept fresh while the Team zone is open. */
export function useTeamTasks(): { tasks: TeamTask[] | null; nameOf: (t: TeamTask) => string } {
  const { sophia } = useCenter();
  const [tasks, setTasks] = useState<TeamTask[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => {
    if (!sophia) return;
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      api.get<TeamTask[] | { items: TeamTask[] }>(`/api/companies/${sophia.companyId}/issues?limit=40`).then((r) => alive && setTasks(Array.isArray(r) ? r : r.items ?? []), () => alive && setTasks([]));
      api.get<Agent[] | { items: Agent[] }>(`/api/companies/${sophia.companyId}/agents`).then((r) => alive && setAgents(Array.isArray(r) ? r : r.items ?? []), () => {});
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sophia?.companyId]);
  const nameOf = (t: TeamTask) => (t.assigneeUserId ? "you" : agents.find((a) => a.id === t.assigneeAgentId)?.name?.replace(/ - .*$/, "") ?? "nobody yet");
  return { tasks, nameOf };
}

export function TaskList({ tasks, nameOf, picked }: { tasks: TeamTask[] | null; nameOf: (t: TeamTask) => string; picked?: string }) {
  if (tasks === null) return null;
  const shown = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="zlabel">The team's tasks</span>
      {shown.length ? shown.map((t) => {
        const st = STATUS[t.status] ?? { word: t.status.replace(/_/g, " "), tone: "" };
        return (
          <button key={t.id} className={`week-shift${t.id === picked ? " picked" : ""}`} onClick={() => navigate(`/team/task/${t.id}`)}>
            <span className="mono week-time" style={{ minWidth: 64 }}>{t.identifier ?? ""}</span>
            <span className="week-who">{t.title}<span className="muted"> · {nameOf(t)}</span></span>
            <span className={`chip quiet ${st.tone}`}>{st.word}</span>
          </button>
        );
      }) : <span className="muted" style={{ fontSize: 13 }}>No tasks yet. Ask SOPHIA for something, and it lands here.</span>}
    </div>
  );
}

export function TaskRoom({ task, nameOf }: { task: TeamTask; nameOf: (t: TeamTask) => string }) {
  const st = STATUS[task.status] ?? { word: task.status.replace(/_/g, " "), tone: "" };
  const who = nameOf(task);
  return (
    <div className="stack hire-room" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="mono muted">{task.identifier}</span>
        <strong style={{ fontSize: 17, minWidth: 0 }}>{task.title}</strong>
        <span className={`chip quiet ${st.tone}`}>{st.word}</span>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12.5 }}>with {who}</span>
      </div>
      <Conversation taskId={task.id} name={who === "you" || who === "nobody yet" ? "the team" : who} />
    </div>
  );
}
