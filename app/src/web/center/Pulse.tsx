// I. Pulse: what's blocked on the operator, most unblocking first. A hire waiting on a decision leads
// (someone is stopped until you answer); then the work Flow ranks as pressing or holding other work up.
// The lead is large and carries the one action that clears it.

import { Octagram } from "../components/Geometry";
import { api, type Task } from "../lib/api";
import { navigate, openRef } from "../lib/router";
import { shortName, useCenter } from "./data";
import { doIt } from "./FlowZone";

interface Item {
  key: string;
  title: string;
  why: string;
  tone: "bad" | "warn" | "info";
  action: string;
  act: () => void;
  score: number;
}

const TONE_VAR = { bad: "var(--bad)", warn: "var(--warn)", info: "var(--c1)" };

export function Pulse() {
  const { flow, team, info, reloadFlow } = useCenter();
  const focus = (t: Task) => {
    api.post(`/ogdoad/flow/${t.id}/focus`).then(reloadFlow, () => {});
    openRef(t.ref ?? "/flow");
  };

  const items: Item[] = [];
  const open = flow ? [flow.now, ...flow.next, ...flow.later].filter((t): t is Task => !!t) : [];
  // A hire whose prompt the watch has read is its card (allow or deny); one it couldn't read is "needs you".
  const watched = new Set(open.filter((t) => t.key?.startsWith("watch:ask:")).map((t) => t.key!.slice("watch:ask:".length).split(":")[0]));
  for (const h of team.filter((x) => x.state === "blocked" && x.role !== "server" && !watched.has(x.id))) {
    items.push({ key: h.id, title: `${shortName(h.label)} needs you`, why: "It's waiting on a decision. Read its screen and answer it.", tone: "warn", action: "Open", act: () => navigate(`/team/${h.id}`), score: 5_000 });
  }
  for (const t of open.filter((x) => x.blocking || x.urgency >= 2)) {
    items.push({ key: t.id, title: t.title, why: t.context, tone: t.urgency >= 3 ? "bad" : t.urgency === 2 ? "warn" : "info", action: doIt(t) ?? (t.ref ? "Do it" : "Focus"), act: () => focus(t), score: t.score ?? 0 });
  }
  items.sort((a, b) => b.score - a.score);
  const [lead, ...rest] = items;
  const working = team.some((h) => h.state === "working");

  return (
    <section className="zone pulse keep" aria-label="Pulse" style={{ gridArea: "pulse" }}>
      <div className="brandmark">
        <span className="mark" style={{ color: "var(--primary)" }}><Octagram size={34} spin={working} /></span>
        <div className="stack" style={{ gap: 2 }}>
          <strong className="wordmark">Ogdoad</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            <span className="live" style={{ color: items.length ? "var(--warn)" : "var(--good)", width: 7, height: 7, marginRight: 7 }} />
            {items.length ? `${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you` : "all clear"}
          </span>
          {info?.practice ? <a className="practice-chip" href={`http://127.0.0.1:${info.realAppPort}/`} title="These are made-up books. Go to your real ones.">practice copy</a> : null}
        </div>
      </div>
      {lead ? (
        <div className="pulse-lead enter" style={{ ["--tone" as string]: TONE_VAR[lead.tone] }} key={lead.key}>
          <span className="pulse-rank mono">1</span>
          <div className="pulse-text">
            <strong>{lead.title}</strong>
            <span className="muted">{lead.why}</span>
          </div>
          <button className="btn primary" onClick={lead.act}>{lead.action}</button>
        </div>
      ) : (
        <div className="pulse-calm enter">
          <strong>Nothing needs you right now.</strong>
          <span className="muted">Everything's moving. Flow has your next thing when you want it.</span>
        </div>
      )}
      {rest.slice(0, 3).map((p, i) => (
        <button key={p.key} className="pulse-item enter" onClick={p.act} style={{ ["--tone" as string]: TONE_VAR[p.tone] }}>
          <span className="pulse-rank-sm mono">{i + 2}</span>
          <span className="pulse-text">
            <strong>{p.title}</strong>
            <span className="muted">{p.why}</span>
          </span>
        </button>
      ))}
    </section>
  );
}
