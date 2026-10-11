// The membrane's check: something the operator wrote for the team named someone (or hinted at who), so
// it waits here, shown exactly as the team would get it. The membrane and its model only suggest; the
// operator decides. Every marked piece can be clicked and decided on its own (keep the stand-in, use
// the real words, write something else, stand a find in), what goes can be edited outright, and only
// what's approved leaves, exactly as it reads. Putting a real detail back is allowed, knowingly: the
// card names each one, and approving takes a second yes. If the books moved since the operator looked,
// the card shows the new version instead.

import { useEffect, useState, type ReactNode } from "react";

import { TOKEN_SOURCE } from "../../shared/standins";
import { api, type Check, type CheckPiece, type MembraneChange, type MembraneFlag } from "../lib/api";
import { ago } from "../lib/format";

const WHERE: Record<string, string> = { cloud: "a cloud model", local: "on this machine", either: "cloud or local", unknown: "not sure where" };
const FLAG: Record<string, string> = { age: "an age", condition: "a health condition", place: "a place" };

export type CheckOutcome = { kind: "sent"; result: unknown } | { kind: "kept" } | { kind: "dropped" };

/** A piece of what goes: plain words, a stand-in, something flagged, or a real detail the operator wrote back. */
type Seg =
  | { t: "text"; s: string }
  | { t: "token"; s: string; original?: string; why?: string }
  | { t: "flag"; s: string; flag: MembraneFlag }
  | { t: "exposed"; s: string; change: MembraneChange };

function segmentsOf(p: CheckPiece, links: Check["links"]): Seg[] {
  const src = p.edited ? p.text : p.real;
  const marks: Array<{ start: number; end: number; seg: Seg }> = [];
  if (p.edited) {
    for (const e of p.exposed ?? []) marks.push({ start: e.start, end: e.end, seg: { t: "exposed", s: src.slice(e.start, e.end), change: e } });
    for (const m of src.matchAll(new RegExp(TOKEN_SOURCE, "g"))) marks.push({ start: m.index!, end: m.index! + m[0].length, seg: { t: "token", s: m[0], original: links[m[0]]?.real } });
  } else {
    for (const c of p.changes) marks.push({ start: c.start, end: c.end, seg: { t: "token", s: c.token, original: c.original, why: c.why } });
    for (const f of p.flags) marks.push({ start: f.start, end: f.end, seg: { t: "flag", s: src.slice(f.start, f.end), flag: f } });
  }
  marks.sort((a, b) => a.start - b.start);
  const out: Seg[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue;
    if (m.start > at) out.push({ t: "text", s: src.slice(at, m.start) });
    out.push(m.seg);
    at = m.end;
  }
  if (at < src.length) out.push({ t: "text", s: src.slice(at) });
  return out;
}
const joined = (segs: Seg[]) => segs.map((s) => s.s).join("");

export function CheckCard({ id, initial, onDone }: { id: string; initial?: Check; onDone?: (outcome: CheckOutcome) => void }) {
  const [check, setCheck] = useState<Check | null | undefined>(initial);
  // Editing the operator's own words (the membrane reads them again), or what goes (sent as written).
  const [editing, setEditing] = useState<{ what: "real" | "out"; texts: string[] } | null>(null);
  const [picked, setPicked] = useState<{ piece: number; seg: number } | null>(null);
  const [writing, setWriting] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
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
        <strong>{check ? (check.state === "sent" ? "Approved and sent." : check.state === "kept" ? "Kept here as a note." : "Denied: not sent.") : "That isn't held any more."}</strong>
      </div>
    );
  }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fresh = (c: Check) => {
    setCheck(c);
    setPicked(null);
    setWriting(null);
    setConfirming(false);
  };
  /** What goes, written by the operator: every piece, with one changed. */
  const writeOut = (texts: string[] | null) => run(async () => {
    fresh(await api.post<Check>(`/ogdoad/membrane/held/${check.id}/outgoing`, { pieces: texts }));
    setEditing(null);
  });
  const replaceSeg = (pi: number, si: number, s: string) => {
    const segs = segmentsOf(check.pieces[pi], check.links);
    segs[si] = { t: "text", s };
    void writeOut(check.pieces.map((p, i) => (i === pi ? joined(segs) : p.text)));
  };
  const standIn = (text: string, kind: string) => run(async () => fresh(await api.post<Check>(`/ogdoad/membrane/held/${check.id}/standin`, { text, kind })));
  const recheck = (texts: string[]) => run(async () => {
    fresh(await api.post<Check>(`/ogdoad/membrane/held/${check.id}/edit`, { pieces: texts }));
    setEditing(null);
    setNote(null);
  });
  const approve = (confirm: boolean) => run(async () => {
    const r = await api.post<{ sent: unknown } | { changed: Check }>(`/ogdoad/membrane/held/${check.id}/send`, { digest: check.digest, confirm });
    if ("changed" in r) {
      fresh(r.changed);
      setNote("It changed since you looked (your books did), so here's what would go now. Look again, then approve.");
      return;
    }
    setCheck({ ...check, state: "sent" });
    onDone?.({ kind: "sent", result: r.sent });
  });
  const close = (what: "keep" | "drop") => run(async () => {
    await api.post(`/ogdoad/membrane/held/${check.id}/${what}`);
    setCheck({ ...check, state: what === "keep" ? "kept" : "dropped" });
    onDone?.(what === "keep" ? { kind: "kept" } : { kind: "dropped" });
  });

  const edited = check.pieces.some((p) => p.edited);
  const exposed = check.pieces.flatMap((p) => p.exposed ?? []);
  const subs = check.pieces.flatMap((p) => p.changes);
  const hints = check.pieces.flatMap((p) => p.flags);
  const sel = picked ? segmentsOf(check.pieces[picked.piece], check.links)[picked.seg] : null;

  /** What a clicked piece can become: the operator's choices, never the model's. */
  const choices = (): ReactNode => {
    if (!picked || !sel || sel.t === "text") return null;
    const { piece, seg } = picked;
    const write = (
      <button type="button" className="btn small" disabled={busy} onClick={() => setWriting(sel.t === "token" ? "" : sel.s)}>Write something else</button>
    );
    let about: ReactNode;
    let actions: ReactNode;
    if (sel.t === "token") {
      about = sel.original ? <><code>{sel.s}</code> stands for <strong>{sel.original}</strong>{sel.why ? <span className="muted"> ({sel.why})</span> : null}.</> : <><code>{sel.s}</code> isn't anyone in your books.</>;
      actions = <>
        <button type="button" className="btn small" onClick={() => setPicked(null)}>Keep the stand-in</button>
        {sel.original ? <button type="button" className="btn small" disabled={busy} onClick={() => replaceSeg(piece, seg, sel.original!)}>Use the real words</button> : null}
        {write}
      </>;
    } else if (sel.t === "flag") {
      about = <><strong>{sel.s}</strong> <span className="muted">· {FLAG[sel.flag.kind] ?? sel.flag.why}</span></>;
      actions = <>
        {sel.flag.standIn ? <button type="button" className="btn small" disabled={busy} onClick={() => void standIn(sel.s, sel.flag.standIn!)} title="A stand-in here, and from now on">Stand it in</button> : null}
        <button type="button" className="btn small" onClick={() => setPicked(null)}>Leave it as written</button>
        {write}
      </>;
    } else {
      about = <><strong>{sel.s}</strong> is real: {sel.change.why}. The membrane would send <code>{sel.change.token}</code>.</>;
      actions = <>
        <button type="button" className="btn small" disabled={busy} onClick={() => replaceSeg(piece, seg, sel.change.token)}>Stand it in</button>
        <button type="button" className="btn small" onClick={() => setPicked(null)}>Leave the real words</button>
        {write}
      </>;
    }
    return (
      <div className="seg-choice" role="group" aria-label="Decide this piece">
        <span>{about}</span>
        {writing === null ? <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{actions}</div> : (
          <form className="row" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (writing.trim()) replaceSeg(piece, seg, writing.trim()); }}>
            <label className="sr" htmlFor={`seg-${check.id}`}>Write it as</label>
            <input id={`seg-${check.id}`} className="input small" style={{ flex: 1, minWidth: 0 }} value={writing} onChange={(e) => setWriting(e.target.value)} placeholder="the participant, their plan manager…" autoFocus />
            <button className="btn small primary" type="submit" disabled={busy || !writing.trim()}>Use it</button>
            <button className="btn small" type="button" onClick={() => setWriting(null)}>Cancel</button>
          </form>
        )}
      </div>
    );
  };

  return (
    <div className={`now-card check-card${check.warn || exposed.length ? " warn" : ""}`} role="group" aria-label="Check what goes out">
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
          <span className="muted" style={{ fontSize: 12 }}>{editing.what === "out" ? "What goes, as the team will get it. It's sent exactly as you write it." : "Your own words. The membrane reads them again."}</span>
          {check.pieces.map((p, i) => (
            <label key={p.label} className="field">
              <span>{p.label}</span>
              <textarea className="input" rows={p.label === "Name" || p.label === "Part" ? 1 : 4} value={editing.texts[i]} onChange={(e) => setEditing({ ...editing, texts: editing.texts.map((x, k) => (k === i ? e.target.value : x)) })} />
            </label>
          ))}
          <div className="row" style={{ gap: 8 }}>
            {editing.what === "out"
              ? <button className="btn small primary" disabled={busy} onClick={() => void writeOut(editing.texts)}>{busy ? "Saving…" : "Use this"}</button>
              : <button className="btn small primary" disabled={busy} onClick={() => void recheck(editing.texts)}>{busy ? "Checking…" : "Check it again"}</button>}
            <button className="btn small" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {check.pieces.filter((p) => p.text.trim()).map((p) => {
            const pi = check.pieces.indexOf(p);
            return (
              <div key={p.label} className="stack" style={{ gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>{check.pieces.length > 1 ? `${p.label}, as the team gets it` : "As the team gets it"}{p.edited ? ", written by you" : ""}. Click a marked piece to decide it.</span>
                <div className="check-text">
                  {segmentsOf(p, check.links).map((s, si) => s.t === "text" ? <span key={si}>{s.s}</span> : (
                    <button key={si} type="button" aria-pressed={picked?.piece === pi && picked.seg === si}
                      className={`seg seg-${s.t}${s.t === "flag" ? ` f-${s.flag.kind}` : ""}${picked?.piece === pi && picked.seg === si ? " on" : ""}`}
                      onClick={() => { setWriting(null); setPicked(picked?.piece === pi && picked.seg === si ? null : { piece: pi, seg: si }); }}>
                      {s.s}
                    </button>
                  ))}
                </div>
                {picked?.piece === pi ? choices() : null}
              </div>
            );
          })}
          {!edited && subs.length ? (
            <ul className="check-list" aria-label="Stood in">
              {subs.map((c, i) => <li key={i}><span className="real">{c.original}</span> <span className="muted">→</span> <code>{c.token}</code> <span className="muted">· {c.why}</span></li>)}
            </ul>
          ) : null}
          {!edited && hints.length ? (
            <ul className="check-list hints" aria-label="Worth a look">
              {hints.map((f, i) => <li key={i}><span className="real">{f.text}</span> <span className="muted">· {FLAG[f.kind] ?? f.why}</span></li>)}
            </ul>
          ) : null}
          {exposed.length ? (
            <div className="notice warn" style={{ fontSize: 13 }}>
              <span>You've written back {exposed.length === 1 ? "a real detail" : `${exposed.length} real details`}: {exposed.map((e) => e.original).join(", ")}. That's your call: approving sends {exposed.length === 1 ? "it" : "them"} as written.</span>
            </div>
          ) : null}
          {check.warn ? <div className="notice warn" style={{ fontSize: 13 }}><span>Together, these hints could point to one person. Change the words if they don't need to be there.</span></div> : null}

          {confirming ? (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>Send {exposed.length === 1 ? "this real detail" : `these ${exposed.length} real details`} to {check.reaches.map((r) => r.who).join(", ") || "the team"}?</span>
              <button className="btn small danger" disabled={busy} onClick={() => void approve(true)}>{busy ? "Sending…" : "Yes, approve"}</button>
              <button className="btn small" disabled={busy} onClick={() => setConfirming(false)}>Not yet</button>
            </div>
          ) : (
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn small primary" disabled={busy} onClick={() => (exposed.length ? setConfirming(true) : void approve(false))}>{busy ? "Sending…" : check.warn ? "Approve anyway" : "Approve"}</button>
              <button className="btn small" disabled={busy} onClick={() => setEditing({ what: "out", texts: check.pieces.map((p) => p.text) })}>Edit what goes</button>
              <button className="btn small" disabled={busy} onClick={() => setEditing({ what: "real", texts: check.pieces.map((p) => p.real) })}>Change your words</button>
              {check.canKeep ? <button className="btn small" disabled={busy} onClick={() => void close("keep")} title="A note in the room, for your eyes only">Keep it here</button> : null}
              <button className="btn small link" disabled={busy} onClick={() => void close("drop")}>Deny</button>
            </div>
          )}
          <span className="muted" style={{ fontSize: 11.5 }}>
            The membrane only suggests. You decide, and only what you approve leaves, exactly as it reads.
            {edited ? <> <button type="button" className="link-btn" disabled={busy} onClick={() => void writeOut(null)}>Back to the membrane's version</button></> : null}
          </span>
        </>
      )}
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}
