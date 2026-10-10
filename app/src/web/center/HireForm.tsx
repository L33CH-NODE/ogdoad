// Hiring from the Team zone: pick who (each harness says whether it's a cloud model under your own
// login or runs on this machine), name it, say what it's for, and Horos starts it in a folder of its own.

import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { useCenter } from "./data";

interface Harness { id: string; name: string; privacy: "local" | "cloud" | "either"; vendor: string }
interface Detected { harnesses: Harness[]; localModels: Array<{ runtime: string; name: string; sizeBytes?: number }> }

const WHERE: Record<string, string> = { cloud: "cloud", local: "on this machine", either: "cloud or local" };

export function HireForm() {
  const { info, say } = useCenter();
  const [found, setFound] = useState<Detected | null>(null);
  const [harness, setHarness] = useState("");
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [brief, setBrief] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<Detected>("/horos/v1/detect").then(setFound, (err) => setError((err as Error).message));
  }, []);
  if (info?.practice) return <p className="muted">Hire from your real Ogdoad: the practice copy shares the real team.</p>;
  if (!found) return error ? <p className="error-text">{error}</p> : <p className="muted">Looking for harnesses on this machine…</p>;
  const spec = found.harnesses.find((h) => h.id === harness);
  const models = found.localModels.filter((m) => m.runtime === "ollama");
  const ready = !!spec && (spec.id !== "ollama" || !!model) && !busy;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api.post<{ id: string } | { held: { id: string } }>("/ogdoad/hire", { harness, model, label, brief, keep });
      if ("held" in made) {
        say("Ogdoad", "Its first message names someone, so the hire waits for your check.", "warn");
        return navigate(`/flow/check/${made.held.id}`);
      }
      say("you", `hired ${label || spec!.name} (${spec!.name})`, "good");
      navigate(`/team/${made.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack hire-form" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); if (ready) void go(); }}>
      <strong style={{ fontSize: 18 }}>Hire someone</strong>
      <span className="muted" style={{ fontSize: 13, marginTop: -6 }}>Each hire is a harness on this machine, in a folder of its own. SOPHIA can direct it once it's here.</span>
      <div className="harnesses" role="radiogroup" aria-label="Who">
        {found.harnesses.map((h) => (
          <button type="button" key={h.id} role="radio" aria-checked={harness === h.id} className={`ask-opt${harness === h.id ? " on" : ""}`} onClick={() => setHarness(h.id)}>
            <span className="ask-mark single" aria-hidden="true" />
            <span className="ask-label">{h.name}<span className="muted">{WHERE[h.privacy] ?? h.privacy} · {h.vendor}</span></span>
          </button>
        ))}
        {!found.harnesses.length ? <span className="muted">No harnesses found on this machine.</span> : null}
      </div>
      {spec?.privacy === "cloud" ? <div className="notice warn" style={{ fontSize: 13 }}>It runs under your own {spec.vendor} login, so what it's given goes to {spec.vendor}. What you send it through Ogdoad is noted in "What the cloud has seen".</div> : null}
      {spec?.id === "ollama" ? (
        models.length ? (
          <label className="field">Which local model
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)} required>
              <option value="">Pick one</option>
              {models.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          </label>
        ) : <div className="notice" style={{ fontSize: 13 }}>No local models are on this machine yet. Pulling one is a big download, so it waits for your word: ask SOPHIA, or pull one in Ollama yourself.</div>
      ) : null}
      <label className="field">Its name<input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ledger, Scout, Scribe…" autoComplete="off" /></label>
      <label className="field">What it's for (its first message)
        <textarea className="input" rows={4} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="You keep the books tidy: match bank lines to invoices, and tell me what doesn't match. Never send anything outside the company." />
      </label>
      <label className="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep it: bring it back after a restart</label>
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="btn small" onClick={() => navigate("/team")}>Not now</button>
        <button type="submit" className="btn small primary" disabled={!ready}>{busy ? "Starting it…" : "Hire"}</button>
      </div>
    </form>
  );
}
