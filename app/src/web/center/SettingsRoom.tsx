// Settings: not a zone, a room the command line opens ("go settings"). Money's business details and
// accounts, and your key: what's encrypted, what isn't yet, and changing the password.

import { useState } from "react";

import { Icon } from "../components/icons";
import { api } from "../lib/api";
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
        Ogdoad's own data (Money, Flow, and the PDFs it keeps) is encrypted with your key and opens only with your password or recovery phrase. Not yet covered: the borrowed engine's database (SOPHIA's tasks and comments in the classic view), until it moves into an encrypted container. It locks itself after {vault?.lockMinutes ?? 30} idle minutes.
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
        <SettingsPage />
      </div>
    </section>
  );
}
