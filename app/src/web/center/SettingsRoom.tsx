// Settings: not a zone, a room the command line opens ("go settings"). Your key (what's encrypted,
// what isn't yet, changing the password), what the cloud has seen, and Money's business details.

import { useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../components/icons";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";
import { SettingsPage } from "../pages/Settings";
import { useCenter } from "./data";

function KeyCard() {
  const { vault, info } = useCenter();
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (info?.practice) return null;
  const change = async () => {
    setBusy(true);
    try {
      await api.post("/ogdoad/vault/password", { oldPassword, newPassword });
      setNote({ ok: true, text: "Changed. Your recovery phrase still works as before." });
      setOld("");
      setNew("");
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack" aria-label="Your key">
      <div className="row"><Icon name="shield" /><h3>Your key</h3><span className="spacer" /><span className="chip paid">vault open</span></div>
      <p className="muted" style={{ margin: 0 }}>
        Ogdoad's own data (Money, Flow, shifts and their notes, dashboards, the calendar's login, and the PDFs it keeps) is encrypted with your key and opens only with your password or recovery phrase. Not yet covered: the borrowed engine's database (the hires' tasks and comments), until it moves into an encrypted container. It locks itself after {vault?.lockMinutes ?? 30} idle minutes.
      </p>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void change(); }}>
        <label className="field">Current password<input className="input" type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" /></label>
        <label className="field">New password<input className="input" type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" /></label>
        <div className="row" style={{ alignSelf: "end" }}><button className="btn" disabled={busy || !oldPassword || newPassword.length < 10}>{busy ? "Changing…" : "Change password"}</button></div>
      </form>
      {note ? <p className={note.ok ? "muted" : "error-text"} role="status" style={{ margin: 0 }}>{note.text}</p> : null}
      <Backups />
    </section>
  );
}

interface BackupList { practice: boolean; dir: string; list: Array<{ stamp: string; at: string; bytes: number; withKeys: boolean }> }

/** The books' backups: encrypted copies with the vault's keys beside them. */
function Backups() {
  const { data, reload } = useLive<BackupList>("/ogdoad/backups");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!data || data.practice) return null;
  const last = data.list[0];
  const now = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/ogdoad/backups");
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 6, borderTop: "1px solid var(--edge)", paddingTop: 12 }}>
      <div className="row">
        <strong style={{ fontSize: 14 }}>Backups</strong>
        <span className="muted" style={{ fontSize: 13 }}>{last ? `last ${ago(last.at)}, ${data.list.length} kept` : "none yet"}</span>
        <span className="spacer" />
        <button className="btn small" disabled={busy} onClick={() => void now()}>{busy ? "Backing up…" : "Back up now"}</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        Every hour while Ogdoad is open, a copy of your books goes to <span className="mono">{data.dir}</span>, still encrypted with your key, with the vault's wrapped keys beside it. The last day's copies are kept, then one a day for a month. Keep a copy off this machine too (a USB stick, or your home box): a copy on the same disk doesn't survive the disk.
      </p>
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
    </div>
  );
}

interface Crossing { id: number; at: string; who: string; via: string; where: "cloud" | "local" | "either" | "unknown"; what: string }

/** Everything that left for a hire, newest first: who got it, through what, and whether that's the cloud. */
function CrossingsCard() {
  const { data } = useLive<Crossing[]>("/ogdoad/crossings", ["crossing"]);
  const list = data ?? [];
  const cloud = list.filter((c) => c.where === "cloud").length;
  return (
    <section className="card stack" aria-label="What the cloud has seen" id="crossings">
      <div className="row"><Icon name="send" /><h3>What the cloud has seen</h3><span className="spacer" /><span className={`chip ${cloud ? "warn-chip" : "paid"}`}>{cloud} to a cloud model</span></div>
      <p className="muted" style={{ margin: 0 }}>
        Every message, answer and panel request you send a hire is noted here as it leaves: who got it, through which harness, and whether that harness runs in the cloud. Panels a hire writes run here, so the hire sees the tables' shape, never the rows. Your books, notes and clients' details only leave in what you write yourself.
      </p>
      {list.length ? (
        <ul className="crossings">
          {list.slice(0, 30).map((c) => (
            <li key={c.id}>
              <span className="mono muted">{ago(c.at)}</span>
              <span className={`chip quiet ${c.where === "cloud" ? "t-warn" : c.where === "local" ? "t-good" : ""}`}>{c.who} · {c.via}{c.where === "cloud" ? " · cloud" : c.where === "local" ? " · local" : ""}</span>
              <span className="crossing-what">{c.what}</span>
            </li>
          ))}
        </ul>
      ) : <span className="muted" style={{ fontSize: 13 }}>Nothing has left yet.</span>}
    </section>
  );
}

/** The graceful shutdown: running work finishes and saves, each hire signs off, then the server stops. */
function ShutdownCard() {
  const { info, team } = useCenter();
  const [armed, setArmed] = useState(false);
  const [state, setState] = useState<"idle" | "stopping" | "off" | "failed">("idle");
  if (info?.practice) return null;
  const working = team.filter((h) => h.role !== "server" && (h.state === "working" || h.state === "blocked")).length;
  const stop = async () => {
    setState("stopping");
    try {
      await api.post("/horos/v1/shutdown", {});
    } catch {
      // The app itself stops partway through; an error here usually just means it already has.
    }
    // Wait for this app to go quiet: that's the last thing to stop before the server.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const up = await fetch("/healthz", { cache: "no-store" }).then((r) => r.ok, () => false);
      if (!up) return setState("off");
    }
    setState("failed");
  };
  if (state !== "idle") {
    // On the page itself, over everything: an opened zone's transform would trap a fixed layer.
    return createPortal(
      <div className="shutdown-veil" role="status" data-modal>
        <div className="stage-card stack" style={{ gap: 12 }}>
          <h2 className="stage-title">{state === "stopping" ? "Shutting down…" : state === "off" ? "Ogdoad is off." : "Still going"}</h2>
          <p className="muted">
            {state === "stopping" ? "Running work is finishing and saving, then each hire signs off, then the server closes its database. A hire waiting on a decision holds this up until it's answered or its wait runs out."
              : state === "off" ? "Everything stopped cleanly, and your books are locked. Start it again with OGDOAD-START on your desktop; your hires come back where they were."
              : "It's taking a while. A hire may be waiting on a decision, or a job may still be running. Horos keeps going, and your desktop alerts say what it's waiting on."}
          </p>
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <section className="card stack" aria-label="Shut Ogdoad down" id="shutdown">
      <div className="row"><Icon name="power" /><h3>Shut Ogdoad down</h3></div>
      <p className="muted" style={{ margin: 0 }}>
        Running work finishes and saves, each hire signs off through its own exit, then the server stops and closes its database cleanly. Start it again with OGDOAD-START on your desktop.
        {working ? ` ${working} hire${working === 1 ? " is" : "s are"} busy right now.` : ""}
      </p>
      <div className="row">
        {armed ? (
          <>
            <button className="btn" onClick={() => setArmed(false)}>Keep it running</button>
            <button className="btn danger" onClick={() => void stop()}>Yes, shut it all down</button>
          </>
        ) : <button className="btn" onClick={() => setArmed(true)}>Shut down…</button>}
      </div>
    </section>
  );
}

export function SettingsRoom() {
  return (
    <section className="zone open settings-room" aria-label="Settings">
      <header className="zhead">
        <span className="znum" aria-hidden="true">∗</span>
        <h2 className="zname">Settings</h2>
        <button className="zbtn" onClick={() => navigate("/")} aria-label="Close Settings" title="Back to everything (Esc)"><Icon name="shrink" size={14} /></button>
      </header>
      <div className="zbody room-page">
        <KeyCard />
        <CrossingsCard />
        <SettingsPage />
        <ShutdownCard />
      </div>
    </section>
  );
}
