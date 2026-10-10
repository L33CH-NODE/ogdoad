// Project rooms, in the Team zone: each project as a live room where the operator and the hires talk.
// A room reads every part's thread at once, shows who is on the job and who is working on which part
// right now, and lets the operator speak to everyone or to one part, mentioning hires to bring them in.
// Until the membrane is built, what's written here reaches the hires as written.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Markdown } from "../components/Markdown";
import { api, type Room, type RoomMember, type RoomPart, type RoomSummary } from "../lib/api";
import { useEngineEvents } from "../lib/engine";
import { ago } from "../lib/format";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";
import { shortName, useCenter } from "./data";
import { COLOR, WORD, presenceOf } from "./presence";
import { STATUS } from "./TeamTasks";

const PROJECT: Record<string, { word: string; tone: string }> = {
  backlog: { word: "later", tone: "" }, planned: { word: "planned", tone: "t-c1" }, in_progress: { word: "under way", tone: "t-primary" },
  completed: { word: "done", tone: "t-good" }, cancelled: { word: "cancelled", tone: "" },
};
const projectWord = (s: string) => PROJECT[s] ?? { word: s.replace(/_/g, " "), tone: "" };
const partWord = (s: string) => STATUS[s] ?? { word: s.replace(/_/g, " "), tone: "" };
const WHERE: Record<string, string> = { cloud: "cloud", local: "local", either: "cloud or local" };

/** Call fn once things settle: a burst of live events becomes one reload. */
function useSoon(fn: () => void, ms = 500): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => ref.current(), ms);
  }, [ms]);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "@Scout" written in the box becomes the engine's mention, which wakes Scout. */
function withMentions(text: string, picked: Record<string, string>): string {
  let out = text;
  for (const [name, id] of Object.entries(picked)) {
    out = out.replace(new RegExp(`(^|[\\s(])@${escapeRe(name)}(?![\\w-])`, "g"), `$1[@${name}](agent://${id})`);
  }
  return out;
}

export function RoomList() {
  const { sophia, team, roster } = useCenter();
  const { data, error, reload } = useLive<{ practice: boolean; rooms: RoomSummary[] }>(sophia ? "/ogdoad/rooms" : null, ["rooms"]);
  const soon = useSoon(reload, 1500);
  useEngineEvents(sophia?.companyId, (e) => e.type === "activity.logged" && e.payload.entityType === "issue" && soon());
  if (!sophia) return null;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="zlabel">Project rooms</span>
        {data && !data.practice ? <button className="btn small" onClick={() => navigate("/team/room/new")}>Open a room</button> : null}
      </div>
      {error ? <span className="muted" style={{ fontSize: 13 }}>The rooms didn't load: {error}</span> : null}
      {data?.rooms.length ? data.rooms.slice(0, 8).map((r) => {
        const st = projectWord(r.status);
        return (
          <button key={r.id} className="week-shift" onClick={() => navigate(`/team/room/${r.id}`)}>
            <span className="room-dots" aria-hidden="true">
              {r.memberHireIds.slice(0, 5).map((h) => {
                const s = presenceOf(h, team, roster);
                return <span key={h} className={`pdot${s === "working" ? " beat" : ""}`} style={{ background: COLOR[s] }} />;
              })}
            </span>
            <span className="week-who">{r.name}<span className="muted"> · {r.openCount} open part{r.openCount === 1 ? "" : "s"} · {ago(r.lastAt)}</span></span>
            <span className={`chip quiet ${st.tone}`}>{st.word}</span>
          </button>
        );
      }) : data ? <span className="muted" style={{ fontSize: 13 }}>No rooms yet. Open one for a job, and the hires on it talk there where you can see.</span> : null}
      {data?.practice ? <span className="muted" style={{ fontSize: 12 }}>The practice copy shows the real team's rooms. Open new ones from your real Ogdoad.</span> : null}
    </div>
  );
}

function useAgents(companyId: string | undefined): RoomMember[] | null {
  const [agents, setAgents] = useState<RoomMember[] | null>(null);
  useEffect(() => {
    if (!companyId) return;
    api.get<Array<{ id: string; name: string; status?: string }> | { items: Array<{ id: string; name: string; status?: string }> }>(`/api/companies/${companyId}/agents`)
      .then((r) => setAgents((Array.isArray(r) ? r : r.items ?? []).filter((a) => a.status !== "terminated").map((a) => ({ agentId: a.id, name: shortName(a.name), hireId: null, harness: null, where: "unknown" as const }))), () => setAgents([]));
  }, [companyId]);
  return agents;
}

export function NewRoom() {
  const { sophia, say } = useCenter();
  const agents = useAgents(sophia?.companyId);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");
  const [lead, setLead] = useState(sophia?.agentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<RoomSummary>("/ogdoad/rooms", { name, brief, leadAgentId: lead || null });
      say("you", `opened a room: ${name}`);
      navigate(`/team/room/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack room-new" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void open(); }}>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn link small" onClick={() => navigate("/team")}>← The team</button>
        <strong style={{ fontSize: 18 }}>Open a room</strong>
      </div>
      <p className="muted" style={{ margin: 0 }}>A room is a project the team works on in the open. The lead gets the brief and can bring others in; you can add parts for other hires, and everyone talks in the room.</p>
      <label className="field">
        <span>What's the job</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Launch the new price page" maxLength={120} autoFocus />
      </label>
      <label className="field">
        <span>The brief</span>
        <textarea className="input" rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What done looks like, what to avoid, by when." />
      </label>
      <label className="field">
        <span>Who leads it</span>
        <select className="input" value={lead} onChange={(e) => setLead(e.target.value)}>
          <option value="">Nobody: I'll run it myself</option>
          {(agents ?? []).map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
        </select>
      </label>
      <div className="notice warn" style={{ fontSize: 13 }}>
        <span>The brief goes to the lead as written, and a cloud hire's provider sees it. Until the membrane is built, leave client names and numbers out.</span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary" type="submit" disabled={busy || !name.trim()}>{busy ? "Opening…" : "Open the room"}</button>
        {error ? <span className="error-text" role="alert">{error}</span> : null}
      </div>
    </form>
  );
}

export function RoomView({ id }: { id: string }) {
  const { sophia, team, roster, info, say } = useCenter();
  const { data: room, error, reload } = useLive<Room>(`/ogdoad/rooms/${id}`, ["rooms"]);
  const soon = useSoon(reload);
  const [lane, setLane] = useState<string | null>(null);
  const mentionRef = useRef<((m: RoomMember) => void) | null>(null);

  // Live: a comment, a task change or a run starting or ending on any of this room's parts.
  useEngineEvents(sophia?.companyId, (e) => {
    if (!room) return;
    const p = e.payload;
    const issueId = e.type === "activity.logged" && p.entityType === "issue" ? String(p.entityId) : e.type === "heartbeat.run.status" ? String(p.issueId ?? "") : "";
    const projectId = typeof p.projectId === "string" ? p.projectId : typeof (p.details as Record<string, unknown> | undefined)?.projectId === "string" ? String((p.details as Record<string, unknown>).projectId) : "";
    if (room.parts.some((x) => x.id === issueId) || projectId === room.id) soon();
  });
  useEffect(() => {
    const t = setInterval(() => !document.hidden && reload(), 20_000);
    return () => clearInterval(t);
  }, [reload]);

  const people = useMemo(() => {
    const m = new Map<string, RoomMember>();
    for (const x of [...(room?.everyone ?? []), ...(room?.members ?? [])]) m.set(x.agentId, x);
    return m;
  }, [room]);

  if (!room) {
    return (
      <div className="stack" style={{ gap: 10 }}>
        <button className="btn link small" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/team")}>← The team</button>
        <p className="muted">{error ? `The room didn't open: ${error}` : "Opening the room…"}</p>
      </div>
    );
  }

  const st = projectWord(room.status);
  const lead = room.leadAgentId ? people.get(room.leadAgentId) : null;
  const nameOf = (agentId: string | null) => (agentId ? people.get(agentId)?.name ?? "An agent" : "you");
  const partOf = (partId: string) => room.parts.find((x) => x.id === partId);
  const counts = new Map<string, number>();
  for (const m of room.messages) if (m.kind === "said") counts.set(m.partId, (counts.get(m.partId) ?? 0) + 1);
  const practice = !!info?.practice;

  return (
    <div className="stack room" style={{ gap: 12 }}>
      <div className="row room-head" style={{ gap: 10 }}>
        <button className="btn link small" onClick={() => navigate("/team")}>← The team</button>
        <strong className="room-name">{room.name}</strong>
        <span className={`chip quiet ${st.tone}`}>{st.word}</span>
        {lead ? <span className="muted" style={{ fontSize: 13 }}>led by {lead.name}</span> : null}
        <span className="spacer" />
        <div className="room-members" aria-label="Who's on this project">
          {room.members.map((m) => {
            const s = presenceOf(m.hireId, team, roster);
            return (
              <button key={m.agentId} type="button" className="member" title={`${m.name}${m.harness ? ` · ${m.harness}` : ""} · ${WORD[s] ?? s}. Click to mention.`} onClick={() => mentionRef.current?.(m)}>
                <span className={`pdot${s === "working" ? " beat" : ""}`} style={{ background: COLOR[s] }} />
                {m.name}
                {WHERE[m.where] ? <span className={`where w-${m.where}`}>{WHERE[m.where]}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      {room.description ? <p className="muted room-brief">{room.description.split(/\n\s*---\s*\n/)[0]}</p> : null}

      <div className="room-grid">
        <div className="stack" style={{ gap: 10, minWidth: 0 }}>
          <Stream room={room} lane={lane} setLane={setLane} nameOf={nameOf} people={people} partOf={partOf} />
          <Composer room={room} lane={lane} people={people} mentionRef={mentionRef} onSent={(text) => { say("you", `in ${room.name}: ${text}`); reload(); }} />
        </div>
        <aside className="stack room-side" aria-label="The parts of this job">
          <span className="zlabel">Parts of the job</span>
          <button type="button" className={`lane-card${lane === null ? " picked" : ""}`} onClick={() => setLane(null)}>
            <span className="lane-title">Everything</span>
            <span className="lane-who">{room.messages.filter((m) => m.kind === "said").length} messages across {room.parts.length} thread{room.parts.length === 1 ? "" : "s"}</span>
          </button>
          {room.parts.map((p) => (
            <Lane key={p.id} part={p} picked={lane === p.id} onPick={() => setLane(lane === p.id ? null : p.id)} count={counts.get(p.id) ?? 0}
              who={p.thread ? "everyone" : p.yours ? "you" : p.agentId ? nameOf(p.agentId) : "nobody yet"}
              state={p.agentId ? presenceOf(people.get(p.agentId)?.hireId, team, roster) : "unknown"}
              working={room.running.some((r) => r.issueId === p.id)} />
          ))}
          {practice ? <span className="muted" style={{ fontSize: 12 }}>Add parts from your real Ogdoad.</span> : <AddPart room={room} everyone={room.everyone} onAdded={reload} />}
        </aside>
      </div>
    </div>
  );
}

function Lane({ part, picked, onPick, count, who, state, working }: { part: RoomPart; picked: boolean; onPick: () => void; count: number; who: string; state: string; working: boolean }) {
  const st = partWord(part.status);
  return (
    <button type="button" className={`lane-card${picked ? " picked" : ""}${working ? " working" : ""}`} onClick={onPick} aria-pressed={picked}>
      <span className="lane-top">
        <span className="mono muted">{part.thread ? "ROOM" : part.identifier ?? ""}</span>
        {part.thread ? null : <span className={`chip quiet ${st.tone}`}>{st.word}</span>}
      </span>
      <span className="lane-title">{part.thread ? "The room" : part.title}</span>
      <span className="lane-who">
        {part.thread ? null : <span className={`pdot${working ? " beat" : ""}`} style={{ background: working ? COLOR.working : COLOR[state] }} />}
        {who} · {count} message{count === 1 ? "" : "s"}{working ? <strong className="live-word"> · working now</strong> : null}
      </span>
    </button>
  );
}

function Stream({ room, lane, setLane, nameOf, people, partOf }: {
  room: Room; lane: string | null; setLane: (id: string | null) => void; nameOf: (id: string | null) => string; people: Map<string, RoomMember>; partOf: (id: string) => RoomPart | undefined;
}) {
  const end = useRef<HTMLDivElement>(null);
  const shown = lane ? room.messages.filter((m) => m.partId === lane) : room.messages;
  const working = room.running.filter((r) => !lane || r.issueId === lane);
  // A body, not an arrow's value: scrollIntoView returns a promise in newer browsers.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [shown.length, lane, working.length]);

  return (
    <div className="thread room-stream" aria-live="polite">
      {shown.length === 0 ? <span className="muted">{lane ? "Nothing said on this part yet." : "Nothing said yet. Say what you need, and mention a hire with @ to bring them in."}</span> : null}
      {shown.map((m) => {
        const part = partOf(m.partId);
        const tag = !lane && part && !part.thread ? (
          <button type="button" className="lane-tag" onClick={() => setLane(m.partId)} title={part.title}>{part.identifier ?? part.title.slice(0, 18)}</button>
        ) : null;
        if (m.kind === "opened") {
          const holder = part?.agentId ? nameOf(part.agentId) : null;
          return (
            <div key={m.id} className="room-event">
              {part?.thread
                ? <span>{m.byYou ? "You" : nameOf(m.agentId)} opened the room{holder ? `, with ${holder} leading` : ""}</span>
                : <span>{m.byYou ? "You" : nameOf(m.agentId)} opened a part: <strong>{m.title}</strong>{holder ? ` for ${holder}` : ""}</span>}
              <span className="muted"> · {ago(m.at)}</span>
            </div>
          );
        }
        const who = m.from === "you" ? null : people.get(m.agentId ?? "");
        return (
          <div key={m.id} className={`msg ${m.from === "you" ? "you" : "them"}`}>
            <span className="msg-who">
              {m.from === "you" ? "you" : who?.name ?? "An agent"}
              {who && WHERE[who.where] ? <span className={`where w-${who.where}`}>{WHERE[who.where]}</span> : null}
              {tag}
              <span> · {ago(m.at)}</span>
            </span>
            <Markdown text={m.body} />
          </div>
        );
      })}
      {working.map((r) => (
        <div key={`${r.agentId}-${r.issueId}`} className="room-working" role="status">
          <span className="typing" aria-hidden="true"><i /><i /><i /></span>
          {nameOf(r.agentId)} is {r.status === "queued" ? "about to start" : "working"} on {partOf(r.issueId)?.thread ? "the room" : partOf(r.issueId)?.title ?? "a part"}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

function Composer({ room, lane, people, mentionRef, onSent }: {
  room: Room; lane: string | null; people: Map<string, RoomMember>; mentionRef: React.MutableRefObject<((m: RoomMember) => void) | null>; onSent: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ q: string; at: number } | null>(null);
  const [hi, setHi] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const caretTo = useRef<number | null>(null);
  const parts = room.parts.filter((p) => !p.thread);

  // After a pick, the caret goes just past the name before the next key lands (a frame later is too late).
  useLayoutEffect(() => {
    const el = box.current;
    if (caretTo.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
  }, [text]);

  // Picking a part on the right points the message at it; "Everything" points it back at the room.
  useEffect(() => setTo(lane && parts.some((p) => p.id === lane) ? lane : ""), [lane]);

  const everyone = room.everyone.length ? room.everyone : [...people.values()];
  const matches = menu ? everyone.filter((m) => m.name.toLowerCase().startsWith(menu.q.toLowerCase())).slice(0, 6) : [];

  const insert = (m: RoomMember, from?: number, caret?: number) => {
    const el = box.current;
    const end = caret ?? el?.selectionStart ?? text.length;
    const start = from ?? end;
    const before = text.slice(0, start);
    const lead = from === undefined && before && !/\s$/.test(before) ? " " : "";
    const next = `${before}${lead}@${m.name} ${text.slice(end)}`;
    const pos = before.length + lead.length + m.name.length + 2;
    caretTo.current = pos;
    setText(next);
    setPicked((p) => ({ ...p, [m.name]: m.agentId }));
    setMenu(null);
  };
  // A member chip adds the name at the end, spaced from what's there.
  mentionRef.current = (m) => insert(m, undefined, text.length);

  const send = async () => {
    const plain = text.trim();
    if (!plain) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/ogdoad/rooms/${room.id}/say`, { body: withMentions(plain, picked), partId: to || undefined });
      setText("");
      setPicked({});
      onSent(plain);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && matches.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setHi((h) => (h + 1) % matches.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setHi((h) => (h - 1 + matches.length) % matches.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), insert(matches[hi], menu.at);
      if (e.key === "Escape") return e.preventDefault(), setMenu(null);
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const target = parts.find((p) => p.id === to);
  const reaches = target ? (target.agentId ? `${people.get(target.agentId)?.name ?? "its hire"}, on this part` : "nobody yet: no hire is on this part") : room.leadAgentId ? `${people.get(room.leadAgentId)?.name ?? "the lead"}, the lead` : "nobody unless you mention them";

  return (
    <form className="stack" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="row" style={{ gap: 8 }}>
        <label htmlFor="room-to" className="muted" style={{ fontSize: 12.5 }}>Say it in</label>
        <select id="room-to" className="input small" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">the room</option>
          {parts.map((p) => <option key={p.id} value={p.id}>{p.identifier ? `${p.identifier} · ` : ""}{p.title.length > 48 ? `${p.title.slice(0, 47)}…` : p.title}</option>)}
        </select>
      </div>
      <div className="reply-box" style={{ position: "relative" }}>
        {menu && matches.length ? (
          <div className="mention-menu" role="listbox" aria-label="Mention someone">
            {matches.map((m, i) => (
              <button key={m.agentId} type="button" role="option" aria-selected={i === hi} className={i === hi ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); insert(m, menu.at); }}>
                @{m.name}{WHERE[m.where] ? <span className="muted"> · {WHERE[m.where]}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        <label htmlFor="room-say" className="sr">Message the room</label>
        <textarea id="room-say" ref={box} className="input" rows={2} value={text} placeholder="Say something. Type @ to bring a hire in (Ctrl+Enter sends)"
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            const caret = e.target.selectionStart ?? v.length;
            const m = /(^|\s)@([\w-]*)$/.exec(v.slice(0, caret));
            setMenu(m ? { q: m[2], at: caret - m[2].length - 1 } : null);
            setHi(0);
          }}
          onKeyDown={onKey} onBlur={() => setTimeout(() => setMenu(null), 150)} />
        <button className="btn small primary" type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      </div>
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <span className="muted" style={{ fontSize: 11.5 }}>Reaches {reaches}{Object.keys(picked).length ? `, and ${Object.keys(picked).map((n) => `@${n}`).join(", ")}` : ""}. Each is noted in "What the cloud has seen".</span>
    </form>
  );
}

function AddPart({ room, everyone, onAdded }: { room: Room; everyone: RoomMember[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>Add a part</button>;
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/ogdoad/rooms/${room.id}/parts`, { title, brief, agentId: who || null });
      setTitle("");
      setBrief("");
      setWho("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack add-part" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this part is" aria-label="What this part is" maxLength={240} autoFocus />
      <textarea className="input" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Its brief (optional)" aria-label="Its brief" />
      <select className="input" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who takes it">
        <option value="">Nobody yet</option>
        {everyone.map((m) => <option key={m.agentId} value={m.agentId}>{m.name}{WHERE[m.where] ? ` (${WHERE[m.where]})` : ""}</option>)}
      </select>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn small primary" type="submit" disabled={busy || !title.trim()}>{busy ? "Adding…" : "Add it"}</button>
        <button className="btn small" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error ? <span className="error-text" role="alert" style={{ fontSize: 12.5 }}>{error}</span> : null}
      <span className="muted" style={{ fontSize: 11.5 }}>Its hire is woken with the brief and told who else is on the job.</span>
    </form>
  );
}
