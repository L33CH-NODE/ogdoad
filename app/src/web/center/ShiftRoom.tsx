// Work's rooms: adding a shift, one shift with its note, and billing what's finished. The note is a
// health and personal record, so it's written here and stays here: the trail and the shelf only ever
// say that a note exists, never what it says.

import { useEffect, useState } from "react";

import { Icon } from "../components/icons";
import { api, type Billable, type Client, type Invoice, type Shift, type ShiftDetail } from "../lib/api";
import { aud, parseAud } from "../lib/format";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";
import { useCenter } from "./data";
import { dayLabel, hm, shiftState, who } from "./workBits";

const AREAS = ["work", "money", "practice"];
const cents = (text: string) => (text.trim() ? parseAud(text) : undefined);

interface Fields { clientId: string; participantName: string; day: string; start: string; end: string; support: string; rate: string; km: string; kmRate: string }

function ShiftFields({ f, set, clients }: { f: Fields; set: (p: Partial<Fields>) => void; clients: Client[] }) {
  const client = clients.find((c) => c.id === f.clientId);
  return (
    <div className="form-grid tight">
      <label className="field">Client
        <select className="input" value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} required>
          <option value="">Pick one</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <label className="field">Participant
        <input className="input" value={f.participantName} onChange={(e) => set({ participantName: e.target.value })} placeholder={client?.participantName || "The client's"} autoComplete="off" />
      </label>
      <label className="field">Day<input className="input" type="date" value={f.day} onChange={(e) => set({ day: e.target.value })} required /></label>
      <div className="row" style={{ gap: 10 }}>
        <label className="field" style={{ flex: 1 }}>Start<input className="input" type="time" step={900} value={f.start} onChange={(e) => set({ start: e.target.value })} required /></label>
        <label className="field" style={{ flex: 1 }}>End<input className="input" type="time" step={900} value={f.end} onChange={(e) => set({ end: e.target.value })} required /></label>
      </div>
      <label className="field">Kind of support<input className="input" value={f.support} onChange={(e) => set({ support: e.target.value })} placeholder="As last time" autoComplete="off" /></label>
      <label className="field">Rate an hour<input className="input" inputMode="decimal" value={f.rate} onChange={(e) => set({ rate: e.target.value })} placeholder="As last time" /></label>
      <div className="row" style={{ gap: 10 }}>
        <label className="field" style={{ flex: 1 }}>Travel km<input className="input" inputMode="decimal" value={f.km} onChange={(e) => set({ km: e.target.value })} placeholder="0" /></label>
        <label className="field" style={{ flex: 1 }}>A km<input className="input" inputMode="decimal" value={f.kmRate} onChange={(e) => set({ kmRate: e.target.value })} placeholder="As last time" /></label>
      </div>
    </div>
  );
}

function body(f: Fields) {
  return {
    clientId: f.clientId, participantName: f.participantName, day: f.day, start: f.start, end: f.end,
    support: f.support.trim() || undefined, rateCents: cents(f.rate), km: f.km.trim() ? Number(f.km) : 0, kmRateCents: cents(f.kmRate),
  };
}

export function AddShift({ today, onAdded }: { today: string; onAdded: (s: Shift) => void }) {
  const clients = useLive<Client[]>("/ogdoad/money/clients", ["money", "practice"]).data ?? [];
  const [f, setF] = useState<Fields>({ clientId: "", participantName: "", day: today, start: "09:00", end: "12:00", support: "", rate: "", km: "", kmRate: "" });
  const [repeat, setRepeat] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<Shift[]>("/ogdoad/work/shifts", { ...body(f), repeatWeeks: repeat });
      onAdded(made[0]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <strong style={{ fontSize: 17 }}>Add a shift</strong>
      <ShiftFields f={f} set={(p) => setF((x) => ({ ...x, ...p }))} clients={clients} />
      <label className="field">Repeat
        <select className="input" value={repeat} onChange={(e) => setRepeat(Number(e.target.value))}>
          <option value={0}>Just this once</option>
          {[1, 2, 3, 5, 7, 11, 25].map((n) => <option key={n} value={n}>Every week, {n + 1} weeks in all</option>)}
        </select>
      </label>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn small" onClick={() => navigate("/work")}>Cancel</button>
        <button type="submit" className="btn small primary" disabled={busy || !f.clientId}>{busy ? "Adding…" : repeat ? `Add ${repeat + 1} shifts` : "Add the shift"}</button>
      </div>
    </form>
  );
}

function NoteEditor({ s, onSaved }: { s: ShiftDetail; onSaved: () => void }) {
  const { say } = useCenter();
  const n = s.noteText;
  const [text, setText] = useState({ body: n?.body ?? "", goals: n?.goals ?? "", followUp: n?.followUp ?? "", incident: n?.incident ?? false, incidentDetail: n?.incidentDetail ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText({ body: n?.body ?? "", goals: n?.goals ?? "", followUp: n?.followUp ?? "", incident: n?.incident ?? false, incidentDetail: n?.incidentDetail ?? "" }), [s.id]);
  const dirty = !n || text.body !== n.body || text.goals !== n.goals || text.followUp !== n.followUp || text.incident !== n.incident || text.incidentDetail !== n.incidentDetail;

  const save = async (final: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/ogdoad/work/shifts/${s.id}/note`, { ...text, final });
      say("you", final ? `finished the note for ${who(s)}'s shift` : `saved a draft note for ${who(s)}'s shift`, "good");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reported = async () => {
    await api.post(`/ogdoad/work/shifts/${s.id}/incident-reported`).then(onSaved, (err) => setError((err as Error).message));
  };

  return (
    <form className="stack note-editor" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void save(true); }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="zlabel">Shift note</span>
        <span className="muted" style={{ fontSize: 12 }}>{n ? (n.final ? "finished" : "draft") : "not written yet"}</span>
      </div>
      <label className="field">What happened, and the support given
        <textarea className="input" rows={5} value={text.body} onChange={(e) => setText((t) => ({ ...t, body: e.target.value }))} placeholder="Where you went, what you did together, how it went" />
      </label>
      <label className="field">Goals worked on
        <textarea className="input" rows={2} value={text.goals} onChange={(e) => setText((t) => ({ ...t, goals: e.target.value }))} />
      </label>
      <label className="field">To follow up
        <textarea className="input" rows={2} value={text.followUp} onChange={(e) => setText((t) => ({ ...t, followUp: e.target.value }))} />
      </label>
      <label className="check">
        <input type="checkbox" checked={text.incident} onChange={(e) => setText((t) => ({ ...t, incident: e.target.checked }))} />
        Something happened that may need reporting (an incident)
      </label>
      {text.incident ? (
        <div className="notice warn stack" style={{ gap: 8 }}>
          <label className="field" style={{ color: "var(--fg)" }}>What happened, when, who was involved, and what you did
            <textarea className="input" rows={3} value={text.incidentDetail} onChange={(e) => setText((t) => ({ ...t, incidentDetail: e.target.value }))} />
          </label>
          <span className="muted" style={{ fontSize: 12.5 }}>Check the NDIS Commission's current rules on what has to be reported and how fast. Ogdoad doesn't set the deadline.</span>
          {n?.incident && !dirty ? (
            n.incidentReportedAt
              ? <span style={{ fontSize: 13, color: "var(--good)" }}><Icon name="check" size={14} /> Marked reported {new Date(n.incidentReportedAt).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}</span>
              : <button type="button" className="btn small" style={{ alignSelf: "flex-start" }} onClick={() => void reported()}>I've reported it</button>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn small" disabled={busy || !dirty} onClick={() => void save(false)}>Save as draft</button>
        <button type="submit" className="btn small primary" disabled={busy || s.phase === "ahead" || (!dirty && !!n?.final)} title={s.phase === "ahead" ? "Finish it after the shift" : undefined}>
          {n?.final ? "Save changes" : "Finish the note"}
        </button>
      </div>
    </form>
  );
}

export function ShiftRoom({ id, onDay }: { id: string; onDay: (day: string) => void }) {
  const { data: s, error, reload } = useLive<ShiftDetail>(`/ogdoad/work/shifts/${id}`, AREAS);
  const clients = useLive<Client[]>("/ogdoad/money/clients", ["money", "practice"]).data ?? [];
  const [editing, setEditing] = useState<Fields | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (s) onDay(s.day);
  }, [s?.id]);
  useEffect(() => setEditing(null), [id]);
  if (error) return <p className="muted">{error}</p>;
  if (!s) return <p className="muted">Opening the shift…</p>;
  const st = shiftState(s);
  const act = (action: string) => api.post(`/ogdoad/work/shifts/${s.id}/${action}`).then(reload, (err) => setProblem((err as Error).message));
  const saveEdit = async () => {
    try {
      await api.put(`/ogdoad/work/shifts/${s.id}`, body(editing!));
      setEditing(null);
      reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  return (
    <div className="panel stack enter" key={s.id} style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 4 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <strong style={{ fontSize: 19 }}>{who(s)}</strong>
          <span className={`chip quiet t-${st.tone}`}>{st.label}</span>
        </div>
        <span className="muted">{s.participantName && s.participantName !== s.clientName ? `${s.clientName} · ` : ""}{dayLabel(s.day, { weekday: "long", day: "numeric", month: "long" })}, {hm(s.start)}–{hm(s.end)} ({Math.round((s.minutes / 60) * 100) / 100} h)</span>
        <span className="muted">{s.support || "Support"} · {aud(s.rateCents)} an hour{s.km ? ` · ${s.km} km at ${aud(s.kmRateCents)}` : ""} · <strong style={{ color: "var(--fg)" }}>{aud(s.cents)}</strong></span>
      </div>
      <div className="row" style={{ gap: 8 }}>
        {s.billed ? <button className="btn small" onClick={() => navigate(`/money/invoices/${s.billed!.invoiceId}`)}>Open {s.billed.number ? `invoice ${s.billed.number}` : "the draft"}</button> : null}
        {!s.billed && s.status !== "cancelled" ? <button className="btn small" onClick={() => setEditing(editing ? null : { clientId: s.clientId, participantName: s.participantName === clients.find((c) => c.id === s.clientId)?.participantName ? "" : s.participantName, day: s.day, start: s.start, end: s.end, support: s.support, rate: (s.rateCents / 100).toFixed(2), km: String(s.km || ""), kmRate: (s.kmRateCents / 100).toFixed(2) })}>{editing ? "Stop editing" : "Change it"}</button> : null}
        {!s.billed ? <button className="btn small" onClick={() => void act(s.status === "cancelled" ? "restore" : "cancel")}>{s.status === "cancelled" ? "Bring it back" : "Cancel the shift"}</button> : null}
      </div>
      {problem ? <p className="error-text" role="alert">{problem}</p> : null}
      {editing ? (
        <form className="stack" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
          <ShiftFields f={editing} set={(p) => setEditing((x) => ({ ...x!, ...p }))} clients={clients} />
          <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn small primary" type="submit">Save the shift</button></div>
        </form>
      ) : null}
      {s.status !== "cancelled" ? <NoteEditor s={s} onSaved={reload} /> : <p className="muted" style={{ margin: 0 }}>Cancelled shifts aren't billed and need no note.</p>}
    </div>
  );
}

export function BillPanel({ billable, focus }: { billable: Billable[]; focus?: string }) {
  const { say } = useCenter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bill = async (b: Billable) => {
    setBusy(b.clientId);
    setError(null);
    try {
      const draft = await api.post<Invoice>("/ogdoad/work/bill", { clientId: b.clientId });
      say("Work", `drafted ${aud(draft.totalCents)} for ${b.clientName} from ${b.shifts} shift${b.shifts === 1 ? "" : "s"}. Check it, then issue it.`, "good");
      navigate(`/money/invoices/${draft.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const rows = billable.filter((b) => b.shifts > 0 || b.waitingOnNotes > 0);
  return (
    <div className="panel stack" style={{ gap: 10 }}>
      <strong style={{ fontSize: 17 }}>Ready to bill</strong>
      <span className="muted" style={{ fontSize: 13, marginTop: -6 }}>Finished shifts with their notes become one draft per client: a line for each shift's hours, and one for its travel.</span>
      {rows.length ? rows.map((b) => (
        <div key={b.clientId} className={`bill-row${b.clientId === focus ? " picked" : ""}`}>
          <div className="stack" style={{ gap: 2, minWidth: 0 }}>
            <strong>{b.clientName}</strong>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {b.shifts ? `${b.shifts} shift${b.shifts === 1 ? "" : "s"} · ${aud(b.cents)} · ${dayLabel(b.from)}${b.to !== b.from ? ` to ${dayLabel(b.to)}` : ""}` : "Nothing ready yet"}
              {b.waitingOnNotes ? <span style={{ color: "var(--warn)" }}> · {b.waitingOnNotes} waiting on {b.waitingOnNotes === 1 ? "its note" : "notes"}</span> : null}
            </span>
          </div>
          {b.shifts ? <button className="btn small primary" disabled={!!busy} onClick={() => void bill(b)}>{busy === b.clientId ? "Drafting…" : "Make the draft"}</button> : null}
        </div>
      )) : <span className="muted" style={{ fontSize: 13 }}>Nothing to bill. Finished shifts land here once their notes are written.</span>}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </div>
  );
}
