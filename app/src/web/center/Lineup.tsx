// The dispatcher's lineup, in a room: a local model reads the job (stand-ins only) and the team, and
// proposes who takes which part, and why. The operator changes anything (the parts, their words, who
// takes each), then approves or denies it. A part that needs the real records can only go to a local
// hire: the model is told, the server moves it if the model forgets, and this card won't let it go to a
// cloud hire either.

import { useState } from "react";

import { api, type Room, type RoomMember } from "../lib/api";

interface Part { title: string; brief: string; agentId: string | null; why: string; needsRealData: boolean; problem?: string }
interface Proposal { parts: Part[]; seconds: number; model: string }

const WHERE: Record<string, string> = { cloud: "cloud", local: "local", either: "cloud or local", unknown: "?" };

export function Lineup({ room, everyone, onAdded }: { room: Room; everyone: RoomMember[]; onAdded: (note: string) => void }) {
  const [state, setState] = useState<"idle" | "asking" | "open" | "saving">("idle");
  const [proposed, setProposed] = useState<Part[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [meta, setMeta] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(everyone.map((m) => [m.agentId, m]));

  const ask = async () => {
    setState("asking");
    setError(null);
    try {
      const r = await api.post<Proposal>(`/ogdoad/rooms/${room.id}/lineup`);
      setProposed(r.parts);
      setParts(r.parts.map((p) => ({ ...p })));
      setMeta(`${r.parts.length} part${r.parts.length === 1 ? "" : "s"} in ${r.seconds}s, by a local model`);
      setState("open");
    } catch (err) {
      setError((err as Error).message);
      setState("idle");
    }
  };
  const set = (i: number, patch: Partial<Part>) => setParts(parts.map((p, k) => (k === i ? { ...p, ...patch, problem: undefined } : p)));
  const broken = (p: Part) => (p.needsRealData && p.agentId && byId.get(p.agentId)?.where !== "local" ? "It needs the real records, so only a local hire (or nobody yet) can take it." : !p.title.trim() ? "Give it a title." : null);
  const decide = async (approve: boolean) => {
    setState("saving");
    setError(null);
    try {
      if (approve) {
        const r = await api.post<{ added: number; held: number }>(`/ogdoad/rooms/${room.id}/lineup/approve`, { parts, proposed });
        onAdded(`Added ${r.added} part${r.added === 1 ? "" : "s"}${r.held ? `; ${r.held} wait${r.held === 1 ? "s" : ""} for your check` : ""}.`);
      } else {
        await api.post(`/ogdoad/rooms/${room.id}/lineup/deny`, { proposed });
      }
      setState("idle");
      setParts([]);
    } catch (err) {
      setError((err as Error).message);
      setState("open");
    }
  };

  if (state === "idle" || state === "asking") {
    return (
      <div className="stack lineup-ask" style={{ gap: 6 }}>
        <button type="button" className="btn small" disabled={state === "asking"} onClick={() => void ask()} title="A local model reads the brief (stand-ins only) and proposes who does what">
          {state === "asking" ? "The dispatcher is reading the job…" : "Ask the dispatcher"}
        </button>
        <span className="muted" style={{ fontSize: 11.5 }}>{state === "asking" ? "A local model, on this machine: about half a minute." : "A local model proposes who takes which part. You decide."}</span>
        {error ? <span className="error-text" role="alert" style={{ fontSize: 12.5 }}>{error}</span> : null}
      </div>
    );
  }

  const problems = parts.map(broken);
  return (
    <div className="now-card lineup-card" role="group" aria-label="The dispatcher's lineup">
      <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
        <span className="zlabel">The dispatcher's lineup</span>
        <span className="muted" style={{ fontSize: 11.5 }}>{meta}</span>
      </div>
      {parts.map((p, i) => (
        <div key={i} className={`lineup-part${problems[i] ? " bad" : ""}`}>
          <div className="row" style={{ gap: 6 }}>
            <input className="input small" style={{ flex: 1, minWidth: 0 }} value={p.title} onChange={(e) => set(i, { title: e.target.value })} aria-label="Part" />
            <button type="button" className="icon-btn" aria-label={`Drop "${p.title}"`} onClick={() => setParts(parts.filter((_, k) => k !== i))}>×</button>
          </div>
          <textarea className="input small" rows={2} value={p.brief} onChange={(e) => set(i, { brief: e.target.value })} aria-label="Its brief" />
          <select className="input small" value={p.agentId ?? ""} onChange={(e) => set(i, { agentId: e.target.value || null })} aria-label="Who takes it">
            <option value="">Nobody yet</option>
            {everyone.map((m) => <option key={m.agentId} value={m.agentId} disabled={p.needsRealData && m.where !== "local"}>{m.name} ({WHERE[m.where] ?? m.where})</option>)}
          </select>
          <label className="row" style={{ gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={p.needsRealData} onChange={(e) => set(i, { needsRealData: e.target.checked })} />
            Needs the real records (local hires only)
          </label>
          {p.why ? <span className="muted" style={{ fontSize: 11.5 }}>{p.why}</span> : null}
          {p.problem ? <span className="lineup-note">{p.problem}</span> : null}
          {problems[i] ? <span className="error-text" style={{ fontSize: 12 }}>{problems[i]}</span> : null}
        </div>
      ))}
      <button type="button" className="btn small link" style={{ alignSelf: "flex-start" }} onClick={() => setParts([...parts, { title: "", brief: "", agentId: null, why: "", needsRealData: false }])}>Add a part</button>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn small primary" disabled={state === "saving" || !parts.length || problems.some(Boolean)} onClick={() => void decide(true)}>{state === "saving" ? "Adding…" : `Approve ${parts.length} part${parts.length === 1 ? "" : "s"}`}</button>
        <button className="btn small" disabled={state === "saving"} onClick={() => void decide(false)}>Deny</button>
      </div>
      {error ? <span className="error-text" role="alert" style={{ fontSize: 12.5 }}>{error}</span> : null}
      <span className="muted" style={{ fontSize: 11.5 }}>The parts go through the membrane like anything else you write. The dispatcher only proposes.</span>
    </div>
  );
}
