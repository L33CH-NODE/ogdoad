// The way in. First launch: a guided arrival that makes the operator's key (a login and password, and a
// 24-word recovery phrase proven to be on paper). After that: the lock, until they unlock. Only then
// does the control center appear. The practice copy has no vault and walks straight in.

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, ApiError, type VaultStatus } from "../lib/api";
import { Halo, Octagram } from "./Geometry";

export function VaultGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.get<VaultStatus>("/ogdoad/vault").then(setStatus, (e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener("ogdoad:locked", refresh);
    return () => window.removeEventListener("ogdoad:locked", refresh);
  }, [refresh]);

  if (error) return <Stage><p className="error-text">{error}</p></Stage>;
  if (!status) return <Stage><p className="muted">Opening…</p></Stage>;
  if (status.practice || status.unlocked) return <>{children}</>;
  if (!status.exists) return <Onboarding onDone={refresh} />;
  return <Lock status={status} onUnlocked={refresh} />;
}

function Stage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="stage">
      <Halo />
      <div className={`stage-card enter${wide ? " wide" : ""}`}>{children}</div>
    </div>
  );
}

function strengthOf(pw: string): { pct: number; word: string; tone: string } {
  if (!pw) return { pct: 0, word: "", tone: "var(--muted)" };
  const score = (pw.length >= 10 ? 1 : 0) + (pw.length >= 14 ? 1 : 0) + (/[0-9]/.test(pw) && /[a-z]/i.test(pw) ? 1 : 0) + (/[^a-z0-9]/i.test(pw) ? 1 : 0);
  return [
    { pct: 15, word: "too short", tone: "var(--bad)" }, { pct: 35, word: "weak", tone: "var(--bad)" }, { pct: 60, word: "fair", tone: "var(--warn)" },
    { pct: 82, word: "good", tone: "var(--good)" }, { pct: 100, word: "strong", tone: "var(--good)" },
  ][pw.length < 10 ? 0 : score];
}

type Step = "welcome" | "key" | "phrase" | "confirm" | "arrive";
const STEPS: Step[] = ["welcome", "key", "phrase", "confirm", "arrive"];

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("welcome");
  const [login, setLogin] = useState("operator");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [phrase, setPhrase] = useState<string[]>([]);
  const [check, setCheck] = useState<number[]>([]);
  const [wrote, setWrote] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strength = strengthOf(password);

  const go = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const makeKey = () => go(async () => {
    if (password !== again) throw new Error("The two passwords don't match.");
    const r = await api.post<{ phrase: string; check: number[] }>("/ogdoad/vault/prepare", { login, password });
    setPhrase(r.phrase.split(" "));
    setCheck(r.check);
    setStep("phrase");
  });

  const confirm = () => go(async () => {
    await api.post("/ogdoad/vault/confirm", { words: answers });
    setPassword("");
    setAgain("");
    setPhrase([]);
    setStep("arrive");
  });

  const index = STEPS.indexOf(step);
  return (
    <Stage wide={step === "phrase"}>
      <div className="steps" aria-label={`Step ${index + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => <span key={s} className={`step${i < index ? " done" : i === index ? " here" : ""}`} />)}
      </div>

      {step === "welcome" ? (
        <div className="stack" style={{ gap: 16 }}>
          <span className="mark"><Octagram size={44} /></span>
          <h1>Your business, run from here.</h1>
          <p className="muted">Ogdoad is a control center for a business run with AI hires. Everything it keeps stays on this machine, encrypted with a key only you hold. First, let's make that key.</p>
          <div className="row"><span className="spacer" /><button className="btn primary" onClick={() => setStep("key")}>Make my key</button></div>
        </div>
      ) : null}

      {step === "key" ? (
        <form className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void makeKey(); }}>
          <h2 className="stage-title">Make your key</h2>
          <p className="muted">Your login and password unlock Ogdoad on this machine. They're checked here and never sent anywhere; there's no account with anyone.</p>
          <label className="field">Login<input className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" /></label>
          <label className="field">Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus /></label>
          <div className="row" style={{ gap: 10 }}>
            <div className="meter" style={{ flex: 1, height: 6 }}><div style={{ width: `${strength.pct}%`, background: strength.tone }} /></div>
            <span style={{ fontSize: 12, fontWeight: 600, color: strength.tone, minWidth: 60 }}>{strength.word}</span>
          </div>
          <label className="field">The same password again<input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>At least 10 characters. A few unrelated words make a strong password that's easy to remember.</p>
          {error ? <p className="error-text" role="alert">{error}</p> : null}
          <div className="row"><button type="button" className="btn" onClick={() => setStep("welcome")}>Back</button><span className="spacer" /><button className="btn primary" disabled={busy || password.length < 10 || !login.trim()}>{busy ? "Making it…" : "Next"}</button></div>
        </form>
      ) : null}

      {step === "phrase" ? (
        <div className="stack" style={{ gap: 14 }}>
          <h2 className="stage-title">Your recovery phrase</h2>
          <p className="muted">These 24 words unlock Ogdoad if you ever forget your password. Write them on paper, in order, and keep it somewhere safe. Anyone with them can unlock your data. Without them or your password, nobody can.</p>
          <ol className="words">
            {phrase.map((w, i) => <li key={i}><span>{i + 1}</span>{w}</li>)}
          </ol>
          <label className="row" style={{ gap: 10, cursor: "pointer" }}><input type="checkbox" checked={wrote} onChange={(e) => setWrote(e.target.checked)} style={{ width: 18, height: 18 }} /> I've written them down, in order.</label>
          <div className="row"><span className="spacer" /><button className="btn primary" disabled={!wrote} onClick={() => setStep("confirm")}>Next</button></div>
        </div>
      ) : null}

      {step === "confirm" ? (
        <form className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
          <h2 className="stage-title">Check three of them</h2>
          <p className="muted">From your paper, not from memory. Your key is made once these match.</p>
          {check.map((n, i) => (
            <label key={n} className="field">Word {n}
              <input className="input mono" value={answers[n] ?? ""} autoComplete="off" autoFocus={i === 0} spellCheck={false} onChange={(e) => setAnswers({ ...answers, [n]: e.target.value })} />
            </label>
          ))}
          {error ? <p className="error-text" role="alert">{error}</p> : null}
          <div className="row"><button type="button" className="btn" onClick={() => setStep("phrase")}>See the words again</button><span className="spacer" /><button className="btn primary" disabled={busy}>{busy ? "Making your key…" : "Make my key"}</button></div>
        </form>
      ) : null}

      {step === "arrive" ? (
        <div className="stack" style={{ gap: 16 }}>
          <span className="mark"><Octagram size={44} spin /></span>
          <h2 className="stage-title">Your key is made.</h2>
          <p className="muted">Ogdoad's data is now encrypted with it. It's open for this session, and it locks itself after a while idle; your password opens it again. Your recovery phrase is the only other way in, so keep the paper safe.</p>
          <div className="row"><span className="spacer" /><button className="btn primary" onClick={onDone}>Enter</button></div>
        </div>
      ) : null}
    </Stage>
  );
}

function Lock({ status, onUnlocked }: { status: VaultStatus; onUnlocked: () => void }) {
  const [mode, setMode] = useState<"password" | "phrase">("password");
  const [login, setLogin] = useState(status.login ?? "");
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "password") await api.post("/ogdoad/vault/unlock", { login, password });
      else await api.post("/ogdoad/vault/recover", { phrase, newPassword });
      onUnlocked();
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stage>
      <form className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <span className="mark"><Octagram size={40} /></span>
        <h2 className="stage-title">Ogdoad is locked</h2>
        {mode === "password" ? (
          <>
            <p className="muted">Your data is encrypted. Your password opens it on this machine.</p>
            <label className="field">Login<input className="input" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" /></label>
            <label className="field">Password<input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></label>
          </>
        ) : (
          <>
            <p className="muted">Forgot your password? Your 24-word recovery phrase opens Ogdoad and sets a new one.</p>
            <label className="field">Recovery phrase<textarea className="input mono" rows={4} value={phrase} onChange={(e) => setPhrase(e.target.value)} spellCheck={false} placeholder="word1 word2 word3 …" /></label>
            <label className="field">New password<input className="input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" /></label>
          </>
        )}
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        <button className="btn primary" disabled={busy}>{busy ? "Opening…" : mode === "password" ? "Unlock" : "Unlock and set the new password"}</button>
        <button type="button" className="btn link" onClick={() => { setMode(mode === "password" ? "phrase" : "password"); setError(null); }}>
          {mode === "password" ? "Use my recovery phrase instead" : "Use my password instead"}
        </button>
      </form>
    </Stage>
  );
}
