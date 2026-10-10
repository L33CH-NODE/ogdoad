// Settings: not a zone, a room the command line opens ("go settings"). Your key (what's encrypted,
// what isn't yet, changing the password), what the cloud has seen, and Money's business details.

import { useState } from "react";

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
    </section>
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
      </div>
    </section>
  );
}
