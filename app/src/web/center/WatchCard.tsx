// The watch's card: a hire is waiting on a permission prompt, read off its screen and sorted by risk.
// The operator allows it once or denies it (a risky yes takes a second yes), or opens its terminal.
// What their policy would do is shown, so its judgement can be watched before it's trusted with
// anything. And the settings card: answering by the policy, off until the operator turns it on.

import { useEffect, useState } from "react";

import { Icon } from "../components/icons";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";
import { useCenter } from "./data";

type RiskKind = "destructive" | "outward" | "spending" | "investing" | "secrets" | "hiring" | "installs" | "web" | "writes" | "runs" | "reads";
interface WatchAsk {
  id: string; hireId: string; hireLabel: string; harness: string; place: string; title: string | null; action: string; question: string;
  choices: Array<{ keys: string[]; label: string; kind: "yes" | "always" | "no" | "other" }>;
  risk: { kinds: RiskKind[]; reasons: Array<{ kind: RiskKind; why: string }>; high: boolean };
  verdict: { allow: boolean; why: string }; state: "open" | "answered" | "gone"; answer: string | null; answeredBy: string | null; createdAt: string; updatedAt: string;
}

const KIND: Record<RiskKind, string> = {
  destructive: "deletes", outward: "sends out", spending: "spends", investing: "invests", secrets: "secrets", hiring: "starts agents",
  installs: "installs", web: "web", writes: "changes files", runs: "runs a command", reads: "reads",
};
const FLOOR = new Set<RiskKind>(["destructive", "outward", "spending", "investing", "secrets", "hiring"]);
const WHERE: Record<string, string> = { cloud: "cloud", local: "local", either: "cloud or local" };

export function WatchCard({ id }: { id: string }) {
  const { reloadFlow, say } = useCenter();
  const [ask, setAsk] = useState<WatchAsk | null | undefined>(undefined);
  const [auto, setAuto] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAsk(undefined);
    setConfirming(false);
    api.get<WatchAsk>(`/ogdoad/watch/${encodeURIComponent(id)}`).then(setAsk, () => setAsk(null));
    api.get<{ auto: boolean }>("/ogdoad/watch/settings").then((s) => setAuto(s.auto), () => {});
  }, [id]);

  if (ask === undefined) return <div className="now-card watch-card"><span className="muted">Reading the request…</span></div>;
  if (!ask || ask.state !== "open") {
    return (
      <div className="now-card watch-card calm">
        <strong>{!ask ? "That request isn't known here." : ask.state === "answered" ? `${ask.answer === "deny" ? "Denied" : "Allowed"}${ask.answeredBy === "policy" ? " by your policy" : ""}.` : "It isn't asking that any more."}</strong>
        <button className="link-btn" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/flow")}>Back to Flow</button>
      </div>
    );
  }

  const answer = async (choice: "allow" | "always" | "deny", confirm = false) => {
    setBusy(true);
    setError(null);
    try {
      const after = await api.post<WatchAsk>(`/ogdoad/watch/${encodeURIComponent(ask.id)}/answer`, { choice, confirm });
      say("you", `${choice === "deny" ? "denied" : choice === "always" ? "always allowed" : "allowed"} ${ask.hireLabel}: ${ask.title ?? ask.question}`, choice === "deny" ? "muted" : "c1");
      setAsk(after);
      reloadFlow();
      navigate("/flow");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const has = (k: string) => ask.choices.some((c) => c.kind === k);

  return (
    <div className={`now-card watch-card${ask.risk.high ? " high" : ""}`} role="group" aria-label={`${ask.hireLabel}'s request`}>
      <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
        <span className="zlabel">The watch</span>
        <span className="muted" style={{ fontSize: 12 }}>asked {ago(ask.createdAt)}</span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 17 }}>{ask.hireLabel} asks</strong>
        <span className="chip quiet">{ask.harness}</span>
        {WHERE[ask.place] ? <span className={`where w-${ask.place}`}>{WHERE[ask.place]}</span> : null}
      </div>
      {ask.title ? <span className="muted" style={{ fontSize: 12.5 }}>{ask.title}</span> : null}
      <pre className="watch-action">{ask.action}</pre>
      <span style={{ fontSize: 13.5 }}>{ask.question}</span>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }} aria-label="What it looks like">
        {ask.risk.kinds.map((k) => <span key={k} className={`chip ${FLOOR.has(k) ? "risk-high" : "quiet"}`}>{KIND[k]}</span>)}
      </div>
      <ul className="check-list" aria-label="Why">
        {ask.risk.reasons.map((r, i) => <li key={i}><span className="muted">{r.why}</span></li>)}
      </ul>
      <span className="watch-verdict">
        <Icon name="shield" size={14} /> Your policy {ask.verdict.allow ? "would allow this" : "holds this for you"}: {ask.verdict.why}.
        {ask.risk.high ? " Whatever it says, this kind always waits for you." : !auto ? " Answering is off, so it only suggests." : ""}
      </span>

      {confirming ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>Let {ask.hireLabel} do something that {ask.risk.kinds.filter((k) => FLOOR.has(k)).map((k) => KIND[k]).join(", ")}?</span>
          <button className="btn small danger" disabled={busy} onClick={() => void answer("allow", true)}>{busy ? "Answering…" : "Yes, allow it"}</button>
          <button className="btn small" disabled={busy} onClick={() => setConfirming(false)}>Not yet</button>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {has("yes") ? <button className="btn small primary" disabled={busy} onClick={() => (ask.risk.high ? setConfirming(true) : void answer("allow"))}>Allow once</button> : null}
          <button className="btn small" disabled={busy} onClick={() => void answer("deny")}>Deny</button>
          {has("always") && !ask.risk.high ? <button className="btn small link" disabled={busy} onClick={() => void answer("always")} title="It won't ask again for this kind of thing">Always allow</button> : null}
          <button className="btn small link" onClick={() => navigate(`/team/${ask.hireId}`)}>Open its terminal</button>
        </div>
      )}
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <span className="muted" style={{ fontSize: 11.5 }}>Your answer is pressed only while this same request is still on its screen.</span>
    </div>
  );
}

/** Settings › The watch: answering by the policy (off until the operator says), and what was decided lately. */
export function WatchSettingsCard() {
  const { info } = useCenter();
  const { data, reload } = useLive<{ practice: boolean; settings: { auto: boolean }; asks: WatchAsk[] }>("/ogdoad/watch", ["watch"]);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const toggle = async () => {
    setBusy(true);
    await api.put("/ogdoad/watch/settings", { auto: !data.settings.auto }).catch(() => {});
    setBusy(false);
    reload();
  };
  const recent = data.asks.filter((a) => a.state !== "open").slice(0, 8);
  return (
    <section className="card stack" aria-label="The watch" id="watch">
      <div className="row"><Icon name="shield" /><h3>The watch</h3><span className="spacer" /><span className={`chip ${data.settings.auto ? "warn-chip" : "paid"}`}>{data.settings.auto ? "answering by your policy" : "only suggests"}</span></div>
      <p className="muted" style={{ margin: 0 }}>
        When a hire stops to ask permission, the watch reads what it wants to do, sorts it by risk and brings it to you to allow or deny. Your policy (<code>app/src/server/watch/policy.ts</code>) says what you'd allow without being asked. Deleting, sending anything out, spending, investing, secrets and starting agents always wait for you, whatever it says.
      </p>
      {info?.practice ? <span className="muted" style={{ fontSize: 13 }}>The watch runs in your real Ogdoad.</span> : (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={data.settings.auto} disabled={busy} onChange={() => void toggle()} />
          <span>Let the watch answer what my policy allows (it presses "yes, once" for me)</span>
        </label>
      )}
      {recent.length ? (
        <ul className="crossings">
          {recent.map((a) => (
            <li key={a.id}>
              <span className="mono muted">{ago(a.updatedAt)}</span>
              <span className={`chip quiet ${a.answer === "deny" ? "" : a.risk.high ? "t-warn" : "t-good"}`}>{a.hireLabel} · {a.state === "gone" ? "moved on" : `${a.answer === "deny" ? "denied" : a.answer === "always" ? "always allowed" : "allowed"}${a.answeredBy === "policy" ? " by policy" : ""}`}</span>
              <span className="crossing-what">{a.title ? `${a.title}: ` : ""}{a.action.split("\n")[0]}{a.verdict.allow !== (a.answer !== "deny") && a.state === "answered" ? <span className="muted"> (your policy would have {a.verdict.allow ? "allowed" : "held"} it)</span> : null}</span>
            </li>
          ))}
        </ul>
      ) : <span className="muted" style={{ fontSize: 13 }}>Nothing asked yet.</span>}
    </section>
  );
}
