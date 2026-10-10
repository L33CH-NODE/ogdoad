// II. Flow: one thing in focus, the next three behind it, and everything else out of sight until its
// time. Done, skip and park are one key each (D, S, P) when you're not typing. Opened, it shows the
// whole stream: what's later, what's parked, what's done today, and what the hires are carrying.

import { useEffect, useState } from "react";

import { Icon } from "../components/icons";
import { api, type Task } from "../lib/api";
import { aud } from "../lib/format";
import { match, navigate, openRef, usePath } from "../lib/router";
import { AskCard } from "./AskCard";
import { typing, useZoom, Zone } from "./ControlCenter";
import { shortName, useCenter } from "./data";

const SOURCE: Record<Task["source"], string> = { you: "yours", money: "Money", bank: "Bank", work: "Work", team: "Team" };

export function FlowZone() {
  const { flow, reloadFlow, team, deep, setDeep, say } = useCenter();
  const path = usePath();
  const open = useZoom() === "flow";
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (t: Task, action: string) => {
    setBusy(true);
    try {
      // The server records it, so it reaches Signals (and every open page) through the stream.
      await api.post(`/ogdoad/flow/${t.id}/${action}`);
      reloadFlow();
    } catch (err) {
      say("Ogdoad", (err as Error).message, "bad");
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const title = adding.trim();
    if (!title) return;
    setAdding("");
    await api.post("/ogdoad/flow", { title }).catch((err) => say("Ogdoad", (err as Error).message, "bad"));
    reloadFlow();
  };

  const now = flow?.now ?? null;
  const asking = !!now?.key?.startsWith("team:ask:");
  const ask = match("/flow/ask/:issue/:interaction", path);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!now || busy || ask || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      const action = { d: asking ? null : "done", s: "skip", p: "park" }[e.key.toLowerCase()];
      if (action) {
        e.preventDefault();
        void act(now, action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [now?.id, busy, !!ask]);

  const currents = team.filter((h) => h.role !== "server" && h.state === "working");
  const chip = flow ? (
    <span className="chip quiet">{flow.doneToday} done today{flow.streak > 1 ? ` · ${flow.streak}-day run` : ""}</span>
  ) : null;

  const nowCard = now ? (
    <div className="now-card enter" key={now.id}>
      <span className="zlabel" style={{ color: "var(--primary)" }}>Now</span>
      <strong className="now-title">{now.title}</strong>
      {now.context ? <span className="muted now-context">{now.context}</span> : null}
      <div className="now-meta">
        <span className="chip quiet">{SOURCE[now.source]}{now.cents ? ` · ${aud(now.cents, { cents: false })}` : ""}</span>
        {now.ref && !asking ? <button className="link-btn" style={{ fontSize: 13 }} onClick={() => openRef(now.ref!)}>Open it{/^https?:/.test(now.ref) ? " (classic view)" : ""}</button> : null}
      </div>
      <div className="now-acts">
        <button className="btn small" disabled={busy} onClick={() => act(now, "park")} title="Park it (P)">Park <kbd>P</kbd></button>
        <button className="btn small" disabled={busy} onClick={() => act(now, "skip")} title="Not now (S)">Skip <kbd>S</kbd></button>
        {asking
          ? <button className="btn small primary" onClick={() => navigate(now.ref!)} title="Answer it here">Answer</button>
          : <button className="btn small primary" disabled={busy} onClick={() => act(now, "done")} title="Done (D)">Done <kbd>D</kbd></button>}
      </div>
    </div>
  ) : (
    <div className="now-card calm">
      <span className="zlabel">Now</span>
      <strong className="now-title">Clear water.</strong>
      <span className="muted now-context">Nothing is waiting on you. Add something, or take a breath.</span>
    </div>
  );

  const row = (t: Task, i: number, opts: { park?: boolean; unpark?: boolean } = {}) => (
    <div key={t.id} className="flow-row enter">
      <span className="mono muted" style={{ width: 18, fontSize: 12 }}>{i}</span>
      <button className="flow-title" onClick={() => act(t, opts.unpark ? "unpark" : "focus")} title={opts.unpark ? "Bring it back" : "Do this now"}>{t.title}</button>
      <span className="muted" style={{ fontSize: 11 }}>{SOURCE[t.source]}</span>
      {opts.park ? <button className="icon-btn" onClick={() => act(t, "park")} aria-label={`Park ${t.title}`} title="Park"><Icon name="park" size={14} /></button> : null}
    </div>
  );

  const addBox = (
    <form className="add-task" onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <Icon name="plus" size={14} />
      <label htmlFor="flow-add" className="sr">Add a task</label>
      <input id="flow-add" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a task" autoComplete="off" />
    </form>
  );

  if (!open) {
    return (
      <Zone id="flow" chip={chip}>
        {nowCard}
        {flow?.next.length ? (
          <>
            <span className="zlabel">Next</span>
            <div className="stack" style={{ gap: 4 }}>{flow.next.map((t, i) => row(t, i + 2))}</div>
          </>
        ) : null}
        <div className="zfoot">
          {flow?.parked.length ? <button className="link-btn" onClick={() => navigate("/flow")}>{flow.parked.length} parked</button> : <span>0 parked</span>}
          <span>·</span>
          <span>{currents.length ? `${currents.length} hire${currents.length === 1 ? "" : "s"} working` : "hires quiet"}</span>
          <span className="spacer" />
          <button className={`hint${deep.on ? " on" : ""}`} onClick={() => setDeep(!deep.on)} aria-pressed={deep.on} title={deep.shared ? "Only errors reach you, here and on the desktop" : "Only errors show here"}>
            {deep.on ? "end deep work" : "deep work"}
          </button>
        </div>
        {addBox}
      </Zone>
    );
  }

  return (
    <Zone id="flow" chip={chip}>
      <div className="room-cols">
        <div className="stack" style={{ gap: 12 }}>
          {ask ? <AskCard issueId={ask.issue} interactionId={ask.interaction} /> : nowCard}
          {flow?.next.length ? <><span className="zlabel">Next</span><div className="stack" style={{ gap: 4 }}>{flow.next.map((t, i) => row(t, i + 2, { park: true }))}</div></> : null}
          {flow?.later.length ? <><span className="zlabel">Later</span><div className="stack" style={{ gap: 4 }}>{flow.later.map((t, i) => row(t, i + 5, { park: true }))}</div></> : null}
          {addBox}
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <span className="zlabel">Currents</span>
          {currents.length ? currents.map((h) => (
            <button key={h.id} className="current" onClick={() => navigate(`/team/${h.id}`)}>
              <span className="lane" aria-hidden="true" />
              <span><strong>{shortName(h.label)}</strong> <span className="muted">{h.title && !/[\\/]/.test(h.title) ? h.title : "working"}</span></span>
            </button>
          )) : <span className="muted" style={{ fontSize: 13 }}>No hire is working right now.</span>}
          <span className="zlabel">Parked</span>
          {flow?.parked.length ? <div className="stack" style={{ gap: 4 }}>{flow.parked.map((t, i) => row(t, i + 1, { unpark: true }))}</div> : <span className="muted" style={{ fontSize: 13 }}>Nothing parked.</span>}
          <span className="zlabel">Done today</span>
          {flow?.done.length ? (
            <div className="stack" style={{ gap: 4 }}>
              {flow.done.map((t) => <div key={t.id} className="flow-row done"><Icon name="check" size={14} /><span className="flow-title">{t.title}</span></div>)}
            </div>
          ) : <span className="muted" style={{ fontSize: 13 }}>Nothing yet. The first one counts the most.</span>}
          <div className="zfoot">
            <button className={`hint${deep.on ? " on" : ""}`} onClick={() => setDeep(!deep.on)} aria-pressed={deep.on}>{deep.on ? "end deep work" : "start deep work"}</button>
            <span className="muted">{deep.on ? (deep.shared ? "Only errors reach you, here and on the desktop." : "Only errors show here.") : "Quiets everything but real emergencies."}</span>
          </div>
        </div>
      </div>
    </Zone>
  );
}
