// A hire's question card, answered right where it lands in Flow: each question's options as choices
// (one, or several), and a text box where the hire offered "I'll describe it". Sending wakes the hire
// with the answers, and the task clears itself from Flow.

import { useEffect, useState } from "react";

import { Icon } from "../components/icons";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { useCenter } from "./data";

interface Option { id: string; label: string; description?: string | null; freeText?: boolean }
interface Question { id: string; prompt: string; helpText?: string | null; selectionMode: "single" | "multi"; required?: boolean; allowOther?: boolean; options: Option[] }
interface Interaction {
  id: string;
  kind: string;
  status: string;
  title: string | null;
  createdByAgentId: string | null;
  payload: { title?: string | null; submitLabel?: string | null; questions: Question[] };
}

export function AskCard({ issueId, interactionId }: { issueId: string; interactionId: string }) {
  const { sophia, say, reloadFlow } = useCenter();
  const [card, setCard] = useState<Interaction | null | undefined>(undefined);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCard(undefined);
    api.get<Interaction[]>(`/api/issues/${issueId}/interactions`).then((list) => setCard(list.find((i) => i.id === interactionId) ?? null), () => setCard(null));
  }, [issueId, interactionId]);

  if (card === undefined) return <div className="now-card askcard"><span className="muted">Opening the question…</span></div>;
  const who = card && sophia?.agentId && card.createdByAgentId === sophia.agentId ? "SOPHIA" : "Your hire";
  if (!card || card.kind !== "ask_user_questions" || card.status !== "pending") {
    return (
      <div className="now-card askcard calm">
        <strong>{card ? "Already answered." : "That question isn't there any more."}</strong>
        <button className="link-btn" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/flow")}>Back to Flow</button>
      </div>
    );
  }

  const qs = card.payload.questions;
  const wantsText = (q: Question) => q.allowOther || q.options.some((o) => o.freeText && (picked[q.id] ?? []).includes(o.id));
  const answered = (q: Question) => (picked[q.id]?.length ?? 0) > 0 || !!text[q.id]?.trim();
  const ready = qs.every((q) => q.required === false || answered(q)) && qs.some(answered);

  const toggle = (q: Question, o: Option) => setPicked((p) => {
    const cur = p[q.id] ?? [];
    const on = cur.includes(o.id);
    const next = q.selectionMode === "single" ? (on ? [] : [o.id]) : on ? cur.filter((x) => x !== o.id) : [...cur, o.id];
    return { ...p, [q.id]: next };
  });

  const send = async () => {
    setBusy(true);
    setError(null);
    const answers = qs
      .map((q) => ({ questionId: q.id, optionIds: picked[q.id] ?? [], otherText: wantsText(q) ? text[q.id]?.trim() || null : null }))
      .filter((a) => a.optionIds.length || a.otherText);
    try {
      await api.post(`/api/issues/${issueId}/interactions/${interactionId}/respond`, { answers });
      say("you", `answered ${who}: ${card.title ?? card.payload.title ?? "a question"}`);
      reloadFlow();
      navigate("/flow");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="now-card askcard enter" onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void send(); }}>
      <span className="zlabel" style={{ color: "var(--primary)" }}>{who} asks</span>
      <strong className="now-title">{card.title ?? card.payload.title ?? "A question for you"}</strong>
      {qs.map((q, n) => (
        <fieldset key={q.id} className="ask-q">
          <legend><span className="mono muted">{n + 1}</span> {q.prompt}</legend>
          {q.helpText ? <p className="muted ask-help">{q.helpText}</p> : null}
          <div className="ask-opts" role={q.selectionMode === "single" ? "radiogroup" : "group"} aria-label={q.prompt}>
            {q.options.map((o) => {
              const on = (picked[q.id] ?? []).includes(o.id);
              return (
                <button type="button" key={o.id} className={`ask-opt${on ? " on" : ""}`} role={q.selectionMode === "single" ? "radio" : "checkbox"} aria-checked={on} onClick={() => toggle(q, o)}>
                  <span className={`ask-mark ${q.selectionMode}`} aria-hidden="true">{on ? <Icon name="check" size={12} /> : null}</span>
                  <span className="ask-label">{o.label}{o.description ? <span className="muted">{o.description}</span> : null}</span>
                </button>
              );
            })}
          </div>
          {wantsText(q) ? (
            <>
              <label htmlFor={`ask-${q.id}`} className="sr">Your own answer to: {q.prompt}</label>
              <textarea id={`ask-${q.id}`} className="input ask-text" rows={2} value={text[q.id] ?? ""} onChange={(e) => setText((t) => ({ ...t, [q.id]: e.target.value }))} placeholder="In your own words" />
            </>
          ) : null}
        </fieldset>
      ))}
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <div className="now-acts">
        <button type="button" className="btn small" onClick={() => navigate("/flow")}>Later</button>
        <button type="submit" className="btn small primary" disabled={!ready || busy}>{busy ? "Sending…" : card.payload.submitLabel ?? `Send to ${who}`}</button>
      </div>
    </form>
  );
}
