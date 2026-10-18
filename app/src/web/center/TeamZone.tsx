// III. Team: the hires as a constellation on the octagram, SOPHIA at its heart. Eight seats, one on each
// point of the two squares. Working hires are linked to the core with a moving thread, a hire waiting on
// you glows amber, resting ones dim. The servers that carry them sit on a line below. Opened, pick a
// hire to watch its terminal live and answer it; SOPHIA's room opens on your conversation with her.

import { useEffect, useState } from "react";

import { api, isHeld, type Check, type HireInfo, type MaybeHeld } from "../lib/api";
import { navigate, usePath } from "../lib/router";
import { CheckCard } from "./CheckCard";
import { useZoom, Zone } from "./ControlCenter";
import { Conversation } from "./Conversation";
import { HireForm } from "./HireForm";
import { TaskList, TaskRoom, useTeamTasks } from "./TeamTasks";
import { shortName, useCenter } from "./data";
import { COLOR, WORD } from "./presence";
import { NewRoom, RoomList, RoomView } from "./Rooms";

interface Person { id: string; name: string; harness: string; state: string; kept: boolean; title?: string }

const SEAT_R = 70;
const seat = (i: number) => {
  const a = (-90 + i * 45) * (Math.PI / 180);
  return { x: SEAT_R * Math.cos(a), y: SEAT_R * Math.sin(a) };
};

function useTeamView() {
  const { team, roster, sophia } = useCenter();
  const live = new Map(team.map((h) => [h.id, h]));
  const isServer = (h: HireInfo) => h.role === "server" || (!h.role && /server|ollama/i.test(h.label));
  const people: Person[] = [
    ...roster.filter((r) => r.role !== "server").map((r) => {
      const h = live.get(r.id);
      return { id: r.id, name: shortName(r.label ?? r.harness), harness: r.harness, state: h && h.state !== "exited" ? h.state : "resting", kept: true, title: h?.title };
    }),
    ...team.filter((h) => !isServer(h) && !roster.some((r) => r.id === h.id) && h.state !== "exited").map((h) => ({ id: h.id, name: shortName(h.label), harness: h.harness, state: h.state, kept: false, title: h.title })),
  ];
  const core = people.find((p) => p.id === sophia?.hireId) ?? people.find((p) => /sophia/i.test(p.name)) ?? null;
  const seats = people.filter((p) => p !== core).slice(0, 8);
  const systems = roster.filter((r) => r.role === "server").map((r) => {
    const h = live.get(r.id);
    const up = !!h && h.state !== "exited";
    return { id: r.id, name: shortName(r.label ?? r.harness).replace(/^Ogdoad /, ""), word: up ? "up" : r.onDemand ? "on call" : "down", tone: up ? "var(--good)" : r.onDemand ? "var(--muted)" : "var(--bad)" };
  });
  return { people, core, seats, systems };
}

function Constellation({ core, seats, selected }: { core: Person | null; seats: Person[]; selected?: string }) {
  return (
    <svg className="constellation" viewBox="-100 -100 200 200" role="group" aria-label="The team">
      <defs>
        <radialGradient id="core-grad" cx="0.36" cy="0.32" r="0.8">
          <stop offset="0" stopColor="oklch(0.93 0.06 300)" />
          <stop offset="0.58" stopColor="var(--primary)" />
          <stop offset="1" stopColor="oklch(0.32 0.14 288)" />
        </radialGradient>
      </defs>
      <circle r="94" className="orbit" />
      <circle r={SEAT_R} className="orbit dashed" />
      <circle r="36" className="orbit" />
      <g className="octagram-slow">
        <rect x={-SEAT_R / Math.SQRT2} y={-SEAT_R / Math.SQRT2} width={SEAT_R * Math.SQRT2} height={SEAT_R * Math.SQRT2} className="square" />
        <rect x={-SEAT_R / Math.SQRT2} y={-SEAT_R / Math.SQRT2} width={SEAT_R * Math.SQRT2} height={SEAT_R * Math.SQRT2} className="square" transform="rotate(45)" />
      </g>
      {Array.from({ length: 8 }, (_, i) => {
        const p = seats[i];
        const { x, y } = seat(i);
        if (!p) return <circle key={`open${i}`} cx={x} cy={y} r="2.4" className="open-seat"><title>An open seat</title></circle>;
        return <line key={`l${p.id}`} x1="0" y1="0" x2={x} y2={y} className={`thread${p.state === "working" ? " on" : ""}${p.state === "blocked" ? " ask" : ""}`} />;
      })}
      <g className={`core-node${core ? ` s-${core.state}` : ""}`} role="button" tabIndex={0} aria-label={core ? `SOPHIA, ${WORD[core.state] ?? core.state}` : "SOPHIA isn't hired yet"}
        onClick={() => core && navigate(`/team/${core.id}`)} onKeyDown={(e) => e.key === "Enter" && core && navigate(`/team/${core.id}`)}>
        <circle r="17" className="core-halo" />
        <circle r="13" fill="url(#core-grad)" className="core" />
        <text y="27" className="n-name">SOPHIA</text>
        <text y="34" className="n-state" style={{ fill: core ? COLOR[core.state] : "var(--muted)" }}>{core ? WORD[core.state] ?? core.state : "not hired yet"}</text>
      </g>
      {seats.map((p, i) => {
        const { x, y } = seat(i);
        return (
          <g key={p.id} className={`seat s-${p.state}${selected === p.id ? " picked" : ""}`} transform={`translate(${x} ${y})`} role="button" tabIndex={0}
            aria-label={`${p.name}, ${WORD[p.state] ?? p.state}`} onClick={() => navigate(`/team/${p.id}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/team/${p.id}`)}>
            <title>{`${p.name} · ${p.harness}`}</title>
            <circle r="9" className="ring" style={{ stroke: COLOR[p.state] ?? "var(--idle)" }} />
            <circle r="2.6" style={{ fill: COLOR[p.state] ?? "var(--idle)" }} className={p.state === "working" || p.state === "blocked" ? "beat" : ""} />
            <text y="17" className="n-name">{p.name}</text>
            <text y="24" className="n-state" style={{ fill: COLOR[p.state] ?? "var(--muted)" }}>{WORD[p.state] ?? p.state}</text>
          </g>
        );
      })}
    </svg>
  );
}

function HireRoom({ person }: { person: Person }) {
  const { sophia } = useCenter();
  const talkable = sophia?.hireId === person.id ? sophia.taskId : null;
  const [view, setView] = useState<"talk" | "screen">(talkable ? "talk" : "screen");
  useEffect(() => setView(talkable ? "talk" : "screen"), [person.id, talkable]);
  const [lines, setLines] = useState<string[] | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [held, setHeld] = useState<Check | null>(null);
  const [sure, setSure] = useState(false);
  const running = person.state !== "resting";
  useEffect(() => {
    setLines(null);
    if (!running || view !== "screen") return;
    let alive = true;
    const load = () => api.get<{ lines: string[] }>(`/horos/v1/hires/${person.id}/screen?lines=60`).then((r) => alive && setLines(r.lines), () => alive && setLines([]));
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [person.id, running, view]);

  const run = (p: Promise<unknown>, done: string) => p.then(() => setNote(done), (e) => setNote((e as Error).message)).finally(() => setTimeout(() => setNote(null), 5000));
  // Waiting on a decision, a hire takes keys, not a new prompt: what you type is pressed as-is, and
  // Enter stays its own button so a choice is never confirmed by accident.
  const asking = person.state === "blocked";
  const send = () => {
    if (!text.trim()) return;
    if (asking) void run(api.post(`/horos/v1/hires/${person.id}/keys`, { keys: [text] }), `Pressed ${text}.`);
    else {
      void api.post<MaybeHeld<unknown>>(`/horos/v1/hires/${person.id}/prompt`, { text }).then((r) => {
        if (isHeld(r)) setHeld(r.held);
        else setNote("Sent to its terminal.");
      }, (e) => setNote((e as Error).message)).finally(() => setTimeout(() => setNote(null), 5000));
    }
    setText("");
  };
  const key = (k: string) => void run(api.post(`/horos/v1/hires/${person.id}/keys`, { keys: [k] }), `Pressed ${k}.`);

  return (
    <div className="stack hire-room" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <strong style={{ fontSize: 18 }}>{person.name}</strong>
        <span className="chip quiet">{person.harness}</span>
        <span className="chip" style={{ color: COLOR[person.state] }}>{WORD[person.state] ?? person.state}</span>
        <span className="spacer" />
        {talkable ? (
          <div className="seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected={view === "talk"} className={view === "talk" ? "on" : ""} onClick={() => setView("talk")}>Conversation</button>
            <button role="tab" aria-selected={view === "screen"} className={view === "screen" ? "on" : ""} onClick={() => setView("screen")}>Terminal</button>
          </div>
        ) : null}
        {person.kept && !running ? <button className="btn small primary" onClick={() => run(api.post(`/horos/v1/roster/${person.id}/wake`), "Waking it.")}>Wake</button> : null}
        {person.kept && running ? (
          sure
            ? <button className="btn small danger" onClick={() => { setSure(false); void run(api.post(`/horos/v1/roster/${person.id}/restart`), "Restarting it the proper way."); }}>Restart it now</button>
            : <button className="btn small" onClick={() => setSure(true)}>Restart</button>
        ) : null}
      </div>
      {talkable && view === "talk" ? <Conversation taskId={talkable} name={person.name} /> : running ? (
        <>
          <pre className="screen" aria-label={`${person.name}'s terminal`}>{lines === null ? "Reading its screen…" : lines.join("\n").trimEnd() || "(the screen is empty)"}</pre>
          <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); send(); }}>
            <label htmlFor="hire-say" className="sr">Type to {person.name}</label>
            <input id="hire-say" className="input" style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={asking ? `Answer ${person.name}: the keys to press (1, 2, y…)` : `Type to ${person.name}'s terminal`} autoComplete="off" />
            <button className="btn small" type="submit" disabled={!text.trim()}>{asking ? "Press" : "Send"}</button>
            {["up", "down", "enter", "esc"].map((k) => <button key={k} type="button" className="btn small" onClick={() => key(k)} aria-label={`Press ${k}`}>{{ up: "↑", down: "↓", enter: "Enter", esc: "Esc" }[k]}</button>)}
          </form>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>Resting. It wakes by itself when work is assigned to it{person.kept ? ", or wake it now" : ""}.</p>}
      {held ? <CheckCard key={held.id} id={held.id} initial={held} onDone={(o) => { setHeld(null); setNote(o.kind === "sent" ? "Sent to its terminal, as checked." : "Not sent."); }} /> : null}
      {note ? <span className="muted" role="status" style={{ fontSize: 13 }}>{note}</span> : null}
    </div>
  );
}

function TeamRoom({ people, core, seats, selectedId, taskId, hiring, chip, systemsRow }: { people: Person[]; core: Person | null; seats: Person[]; selectedId?: string; taskId?: string; hiring: boolean; chip: React.ReactNode; systemsRow: React.ReactNode }) {
  const { tasks, nameOf } = useTeamTasks();
  const task = taskId ? tasks?.find((t) => t.id === taskId) ?? null : null;
  const selected = taskId || hiring ? null : people.find((p) => p.id === selectedId) ?? core ?? people[0] ?? null;
  return (
    <Zone id="team" chip={chip}>
      <div className="room-cols">
        <div className="stack" style={{ gap: 12 }}>
          <div className="constellation-wrap big"><Constellation core={core} seats={seats} selected={selected?.id} /></div>
          <div className="row" style={{ justifyContent: "space-between" }}>{systemsRow}<button className="btn small" onClick={() => navigate("/team/hire")}>Hire someone</button></div>
          <RoomList />
          <TaskList tasks={tasks} nameOf={nameOf} picked={taskId} />
        </div>
        {hiring ? <HireForm />
          : task ? <TaskRoom task={task} nameOf={nameOf} />
          : taskId ? <p className="muted">{tasks === null ? "Opening the task…" : "That task isn't there any more."}</p>
          : selected ? <HireRoom person={selected} /> : <p className="muted">No hires yet. SOPHIA comes first: <span className="mono">npx ogdoad sophia</span> asks who she should be, and briefs her.</p>}
      </div>
    </Zone>
  );
}

export function TeamZone() {
  const open = useZoom() === "team";
  const parts = usePath().split("/").filter(Boolean);
  const taskId = parts[1] === "task" ? parts[2] : undefined;
  const roomId = parts[1] === "room" ? parts[2] : undefined;
  const hiring = parts[1] === "hire";
  const selectedId = taskId || hiring || roomId ? undefined : parts[1];
  const { people, core, seats, systems } = useTeamView();
  const working = people.filter((p) => p.state === "working").length;
  const waiting = people.filter((p) => p.state === "blocked").length;
  const chip = <span className="chip quiet">{working} working{waiting ? ` · ${waiting} need${waiting === 1 ? "s" : ""} you` : ""}</span>;
  const systemsRow = systems.length ? (
    <div className="systems" aria-label="Servers">
      {systems.map((s) => <span key={s.id} className="sys"><span className="dot" style={{ background: s.tone }} />{s.name}<span className="muted"> {s.word}</span></span>)}
    </div>
  ) : null;

  if (!open) {
    return (
      <Zone id="team" chip={chip}>
        <div className="constellation-wrap"><Constellation core={core} seats={seats} /></div>
        {systemsRow}
      </Zone>
    );
  }
  // A project room takes the whole zone: the conversation needs the width.
  if (roomId) return <Zone id="team" chip={chip}>{roomId === "new" ? <NewRoom /> : <RoomView id={roomId} />}</Zone>;
  return <TeamRoom people={people} core={core} seats={seats} selectedId={selectedId} taskId={taskId} hiring={hiring} chip={chip} systemsRow={systemsRow} />;
}
