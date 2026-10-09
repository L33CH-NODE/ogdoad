// The floating shell: the glass sidebar (where to go, who's working), the main space, the bell,
// and SOPHIA's bar at the bottom.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { api, getAppInfo, type AppInfo, type HireInfo } from "../lib/api";
import { ago } from "../lib/format";
import { useNotifications, useTeam } from "../lib/horos";
import { linkProps, usePath } from "../lib/router";
import { Icon, Mark, type IconName } from "./icons";

const NAV: Array<{ to: string; label: string; icon: IconName }> = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/money", label: "Money", icon: "money" },
  { to: "/money/clients", label: "Clients", icon: "clients" },
  { to: "/money/bank", label: "Bank", icon: "bank" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

const STATE_COLOR: Record<string, string> = { working: "var(--c1)", blocked: "var(--warn)", idle: "var(--idle)", done: "var(--good)", starting: "var(--muted)", exited: "var(--idle)" };
const STATE_WORD: Record<string, string> = { working: "working", blocked: "needs you", idle: "idle", done: "finished", starting: "starting", exited: "resting" };

function active(path: string, to: string): boolean {
  if (to === "/") return path === "/";
  if (to === "/money") return path === "/money" || path.startsWith("/money/invoices");
  return path === to || path.startsWith(`${to}/`);
}

function TeamNow({ team }: { team: HireInfo[] }) {
  const people = team.filter((h) => !/server|ollama/i.test(h.label));
  if (!people.length) return null;
  return (
    <div className="stack" style={{ gap: 2 }}>
      <div className="section-label">Team now</div>
      {people.map((h) => (
        <div key={h.id} className="row" style={{ minHeight: 44, padding: "0 12px", gap: 12, flexWrap: "nowrap" }}>
          <span className={h.state === "working" || h.state === "blocked" ? "live" : ""} style={{ color: STATE_COLOR[h.state] ?? "var(--idle)", width: 8, height: 8, borderRadius: "50%", background: STATE_COLOR[h.state], display: "inline-block", flex: "0 0 auto" }} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{h.label.replace(/ - .*$/, "")}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: STATE_COLOR[h.state] ?? "var(--muted)" }}>{STATE_WORD[h.state] ?? h.state}</span>
        </div>
      ))}
    </div>
  );
}

const SKINS = [
  { id: "ogdoad", label: "Ogdoad" },
  { id: "ogdoad-dark", label: "Dark" },
  { id: "cyberpunk-uv", label: "Ultraviolet" },
];

function SkinPicker() {
  const [skin, setSkin] = useState(() => document.documentElement.dataset.skin ?? "ogdoad-dark");
  const pick = (id: string) => {
    document.documentElement.dataset.skin = id;
    try {
      localStorage.setItem("ogdoad.skin", id);
    } catch {}
    setSkin(id);
  };
  return (
    <div className="tabs" role="group" aria-label="Skin">
      {SKINS.map((s) => (
        <button key={s.id} type="button" aria-pressed={skin === s.id} onClick={() => pick(s.id)}>{s.label}</button>
      ))}
    </div>
  );
}

function Bell() {
  const { items, unread, markRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const dot = { error: "var(--bad)", warn: "var(--warn)", info: "var(--c1)", pulse: "var(--idle)" };
  return (
    <div className="bell" ref={ref}>
      <button className="btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) markRead(); }}>
        <Icon name="bell" />
        {unread ? <span className="badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div className="bell-panel float enter" role="dialog" aria-label="Notifications">
          {items.length ? items.map((n) => (
            <div key={n.id} className="note">
              <span className="dot" style={{ background: dot[n.level] }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{n.title}</div>
                {n.body ? <div className="muted" style={{ fontSize: 13 }}>{n.body}</div> : null}
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{ago(n.at)}</div>
              </div>
            </div>
          )) : <div className="note muted">Nothing yet. Horos tells you here when anything happens in the team.</div>}
        </div>
      ) : null}
    </div>
  );
}

interface SophiaInfo { companyId: string; companyName: string; taskId: string }

function SophiaBar() {
  const [sophia, setSophia] = useState<SophiaInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    api.get<SophiaInfo | null>("/ogdoad/sophia").then(setSophia, () => {});
  }, []);
  const send = async () => {
    const text = draft.trim();
    if (!text || !sophia) return;
    setStatus("Sending…");
    try {
      // A comment on her task wakes her, the same way the setup cards do.
      await api.post(`/api/issues/${sophia.taskId}/comments`, { body: text, clientRequestId: crypto.randomUUID() });
      setDraft("");
      setStatus("Sent. SOPHIA answers on her task; open it from Home.");
    } catch (err) {
      setStatus(`Couldn't send: ${(err as Error).message}`);
    }
    setTimeout(() => setStatus(null), 6000);
  };
  return (
    <div className="composer-dock">
      <div className="stack" style={{ alignItems: "center", gap: 8, width: "100%" }}>
        {status ? <div className="float enter" style={{ pointerEvents: "auto", borderRadius: 14, padding: "8px 14px", fontSize: 13 }} role="status">{status}</div> : null}
        <form className="composer float" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <span className="orb" aria-hidden="true" />
          <label htmlFor="sophia-ask" className="sr">Message SOPHIA</label>
          <input id="sophia-ask" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off"
            placeholder={sophia ? "Message SOPHIA, or describe a dashboard you want…" : "SOPHIA isn't set up yet"} disabled={!sophia} />
          <button className="send" type="submit" aria-label="Send to SOPHIA" disabled={!sophia || !draft.trim()}><Icon name="send" /></button>
        </form>
      </div>
    </div>
  );
}

function PracticeRibbon({ info }: { info: AppInfo }) {
  return (
    <div className="practice-ribbon" role="note">
      <strong>Practice copy</strong>
      <span>Made-up books: try anything, nothing here is real.</span>
      <a href={`http://127.0.0.1:${info.realAppPort}/`}>Your real books</a>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePath();
  const team = useTeam();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    getAppInfo().then((i) => {
      setInfo(i);
      document.documentElement.dataset.practice = i.practice ? "1" : "0";
      document.title = i.practice ? "Ogdoad (practice)" : "Ogdoad";
    });
  }, []);
  return (
    <div className="shell">
      {info?.practice ? <PracticeRibbon info={info} /> : null}
      <nav className="side float" aria-label="Main">
        <div className="brand">
          <span className="brand-mark"><Mark /></span>
          <div className="stack" style={{ gap: 0 }}>
            <strong style={{ fontSize: 15 }}>Ogdoad</strong>
            <span className="muted" style={{ fontSize: 12 }}>{team.filter((h) => h.state === "blocked").length ? "someone needs you" : "all clear"}</span>
          </div>
        </div>
        <div className="nav">
          {NAV.map((n) => (
            <a key={n.to} {...linkProps(n.to)} aria-current={active(path, n.to) ? "page" : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </a>
          ))}
        </div>
        <TeamNow team={team} />
        <div style={{ padding: "0 4px" }}><SkinPicker /></div>
      </nav>
      <main className="main">
        {children}
      </main>
      <div className="bell-dock"><Bell /></div>
      <SophiaBar />
    </div>
  );
}
