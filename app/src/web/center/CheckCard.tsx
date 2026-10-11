// The membrane's check: something the operator wrote for the team named someone (or hinted at who), so
// it waits here, shown exactly as the team would get it. Each stand-in is marked, with what it replaced;
// each hint is listed. Send it as shown, change the words and look again, keep a room message here as a
// note, or don't send it. What's sent is exactly what was shown: if the books moved in between, the
// card shows the new version instead.

import { useEffect, useState, type ReactNode } from "react";

import { api, type Check, type CheckPiece } from "../lib/api";
import { ago } from "../lib/format";

const WHERE: Record<string, string> = { cloud: "a cloud model", local: "on this machine", either: "cloud or local", unknown: "not sure where" };
const FLAG: Record<string, string> = { age: "an age", condition: "a health condition", place: "a place" };

export type CheckOutcome = { kind: "sent"; result: unknown } | { kind: "kept" } | { kind: "dropped" };

/** The outgoing text, with every stand-in and every hint marked where it sits. */
function Outgoing({ piece }: { piece: CheckPiece }) {
  const marks = [
    ...piece.changes.map((c) => ({ start: c.start, end: c.end, node: <mark className="sub" title={`${c.original}: ${c.why}`}>{c.token}</mark> })),
    ...piece.flags.map((f) => ({ start: f.start, end: f.end, node: <mark className={`hint-mark f-${f.kind}`} title={f.why}>{piece.real.slice(f.start, f.end)}</mark> })),
  ].sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let at = 0;
  marks.forEach((m, i) => {
    if (m.start < at) return;
    out.push(piece.real.slice(at, m.start), <span key={i}>{m.node}</span>);
    at = m.end;
  });
  out.push(piece.real.slice(at));
  return <div className="check-text">{out}</div>;
}

export function CheckCard({ id, initial, onDone }: { id: string; initial?: Check; onDone?: (outcome: CheckOutcome) => void }) {
  const [check, setCheck] = useState<Check | null | undefined>(initial);
  const [editing, setEditing] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial?.id === id) return setCheck(initial);
    setCheck(undefined);
    api.get<Check>(`/ogdoad/membrane/held/${id}`).then(setCheck, () => setCheck(null));
  }, [id]);

  if (check === undefined) return <div className="now-card check-card"><span className="muted">Opening what's held…</span></div>;
  if (!check || check.state !== "held") {
    return (
      <div className="now-card check-card calm">
        <strong>{check ? (check.state === "sent" ? "Already sent." : check.state === "kept" ? "Kept here as a note." : "Not sent.") : "That isn't held any more."}</strong>
      </div>
    );
  }

  const act = async (what: "send" | "keep" | "drop") => {
    setBusy(true);
    setError(null);
    try {
      if (what === "send") {
        const r = await api.post<{ sent: unknown } | { changed: Check }>(`/ogdoad/membrane/held/${check.id}/send`, { digest: check.digest });
        if ("changed" in r) {
          setCheck(r.changed);
          setNote("It changed since you looked (your books did), so here's what would go now. Look again, then send.");
          return;
        }
        onDone?.({ kind: "sent", result: r.sent });
      } else {
        await api.post(`/ogdoad/membrane/held/${check.id}/${what}`);
        onDone?.(what === "keep" ? { kind: "kept" } : { kind: "dropped" });
      }
      setCheck({ ...check, state: what === "send" ? "sent" : what === "keep" ? "kept" : "dropped" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // A detail only the local model caught: the operator says it's private, so it's stood in, now and next time.
  const standIn = async (text: string, kind: string) => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await api.post<Check>(`/ogdoad/membrane/held/${check.id}/standin`, { text, kind }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const recheck = async () => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await api.post<Check>(`/ogdoad/membrane/held/${check.id}/edit`, { pieces: editing }));
      setEditing(null);
      setNote(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const subs = check.pieces.flatMap((p) => p.changes);
  const hints = check.pieces.flatMap((p) => p.flags);
  return (
    <div className={`now-card check-card${check.warn ? " warn" : ""}`} role="group" aria-label="Check what goes out">
      <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
        <span className="zlabel">Check what goes out</span>
        <span className="muted" style={{ fontSize: 12 }}>held {ago(check.createdAt)}</span>
      </div>
      <span className="check-where">
        For {check.where}
        {check.reaches.length ? <>. Reaches {check.reaches.map((r, i) => <span key={i}>{i ? ", " : ""}<strong>{r.who}</strong> <span className={`where w-${r.where}`}>{r.via}, {WHERE[r.where]}</span></span>)}</> : null}
      </span>
      {check.notes.map((n) => <div key={n} className="notice warn" style={{ fontSize: 13 }}><span>{n}</span></div>)}
      {note ? <div className="notice" style={{ fontSize: 13 }}><span>{note}</span></div> : null}

      {editing ? (
        <div className="stack" style={{ gap: 8 }}>
          {check.pieces.map((p, i) => (
            <label key={p.label} className="field">
              <span>{p.label}</span>
              <textarea className="input" rows={p.label === "Name" || p.label === "Part" ? 1 : 4} value={editing[i]} onChange={(e) => setEditing(editing.map((x, k) => (k === i ? e.target.value : x)))} />
            </label>
          ))}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn small primary" disabled={busy} onClick={() => void recheck()}>{busy ? "Checking…" : "Check it again"}</button>
            <button className="btn small" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {check.pieces.filter((p) => p.real.trim()).map((p) => (
            <div key={p.label} className="stack" style={{ gap: 4 }}>
              {check.pieces.length > 1 ? <span className="muted" style={{ fontSize: 12 }}>{p.label}, as the team gets it</span> : <span className="muted" style={{ fontSize: 12 }}>As the team gets it</span>}
              <Outgoing piece={p} />
            </div>
          ))}
          {subs.length ? (
            <ul className="check-list" aria-label="Stood in">
              {subs.map((c, i) => <li key={i}><span className="real">{c.original}</span> <span className="muted">→</span> <code>{c.token}</code> <span className="muted">· {c.why}</span></li>)}
            </ul>
          ) : null}
          {hints.length ? (
            <ul className="check-list hints" aria-label="Worth a look">
              {hints.map((f, i) => (
                <li key={i}>
                  <span className="real">{f.text}</span> <span className="muted">· {FLAG[f.kind] ?? f.why}</span>
                  {f.kind === "model" && f.standIn ? <button type="button" className="btn small link" disabled={busy} onClick={() => void standIn(f.text, f.standIn!)} title="Give it a stand-in, here and from now on">Stand it in</button> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {check.warn ? <div className="notice warn" style={{ fontSize: 13 }}><span>Together, these hints could point to one person. Change the words if they don't need to be there.</span></div> : null}
          {!check.hold ? <span className="muted" style={{ fontSize: 13 }}>Nothing needs standing in any more.</span> : null}
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn small primary" disabled={busy} onClick={() => void act("send")}>{busy ? "Sending…" : check.warn ? "Send anyway" : "Send as shown"}</button>
            <button className="btn small" disabled={busy} onClick={() => setEditing(check.pieces.map((p) => p.real))}>Change it</button>
            {check.canKeep ? <button className="btn small" disabled={busy} onClick={() => void act("keep")} title="A note in the room, for your eyes only">Keep it here</button> : null}
            <button className="btn small link" disabled={busy} onClick={() => void act("drop")}>Don't send</button>
          </div>
        </>
      )}
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}
