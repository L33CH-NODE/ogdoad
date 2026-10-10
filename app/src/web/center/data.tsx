// Everything the control center shows, loaded once and kept live: Flow and Money (through the app's
// stream), the team (through Horos's), SOPHIA's replies (her task's comments), and the lines this
// session adds itself. Zones read it from context, so one change updates every zone that cares.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, getAppInfo, type AppInfo, type Artifact, type FlowView, type HireInfo, type InvoiceSummary, type Month, type Overview, type RosterEntry, type Signal, type SophiaInfo, type VaultStatus } from "../lib/api";
import { useHoros, useNotifications, useTeam } from "../lib/horos";
import { useLive } from "../lib/live";

export interface SophiaReply { id: string; body: string; at: string }

export interface CenterData {
  info: AppInfo | null;
  vault: VaultStatus | null;
  flow: FlowView | null;
  reloadFlow: () => void;
  overview: Overview | null;
  invoices: InvoiceSummary[] | null;
  team: HireInfo[];
  roster: RosterEntry[];
  sophia: SophiaInfo | null;
  sophiaReply: SophiaReply | null;
  signals: Signal[];
  unread: number;
  markRead: () => void;
  artifacts: Artifact[] | null;
  monthly: Month[] | null;
  deep: { on: boolean; held: number; shared: boolean };
  setDeep: (on: boolean) => void;
  /** Put a line in Signals for this session (what you typed, what Ogdoad answered). */
  say: (who: string, text: string, tone?: Signal["tone"]) => void;
  /** When SOPHIA was last messaged from here, so her next reply can be shown. */
  markAsked: () => void;
}

const Ctx = createContext<CenterData | null>(null);

export function useCenter(): CenterData {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCenter outside the control center");
  return c;
}

/** Short names: "SOPHIA - Claude Code" reads as "SOPHIA". */
export const shortName = (label: string) => label.replace(/ - .*$/, "").replace(/ \(.*\)$/, "");

const TONE = { error: "bad", warn: "warn", info: "c1", pulse: "muted" } as const;

export function CenterProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  useEffect(() => {
    getAppInfo().then((i) => {
      setInfo(i);
      document.documentElement.dataset.practice = i.practice ? "1" : "0";
      document.title = i.practice ? "Ogdoad (practice)" : "Ogdoad";
    });
    api.get<VaultStatus>("/ogdoad/vault").then(setVault, () => {});
  }, []);

  const flow = useLive<FlowView>("/ogdoad/flow");
  const overview = useLive<Overview>("/ogdoad/money/overview", ["money", "work", "practice"]);
  const invoices = useLive<InvoiceSummary[]>("/ogdoad/money/invoices", ["money", "work", "practice"]);
  const moneySignals = useLive<Signal[]>("/ogdoad/signals?limit=60");
  const artifacts = useLive<Artifact[]>("/ogdoad/artifacts", ["money", "work", "practice"]);
  const monthly = useLive<Month[]>("/ogdoad/monthly", ["money", "work", "practice"]);

  const team = useTeam();
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const loadRoster = useCallback(() => api.get<RosterEntry[]>("/horos/v1/roster").then(setRoster, () => {}), []);
  useEffect(() => void loadRoster(), [loadRoster]);
  useHoros(["hire_spawned", "hire_restored", "status_changed"], () => void loadRoster());
  const { items: notes, unread, markRead } = useNotifications();

  // Deep work lives in Horos when it can (so desktop alerts go quiet too), else just on this screen.
  const [deep, setDeepState] = useState({ on: false, held: 0, shared: false });
  useEffect(() => {
    api.get<{ on: boolean; held: number }>("/horos/v1/quiet").then((q) => setDeepState({ ...q, shared: true }), () => {
      try {
        setDeepState({ on: localStorage.getItem("ogdoad.deep") === "1", held: 0, shared: false });
      } catch {}
    });
  }, []);
  const setDeep = useCallback((on: boolean) => {
    setDeepState((d) => ({ ...d, on, held: 0 }));
    api.post<{ on: boolean; held: number }>("/horos/v1/quiet", { on }).then((q) => setDeepState({ ...q, shared: true }), () => {
      try {
        localStorage.setItem("ogdoad.deep", on ? "1" : "0");
      } catch {}
    });
  }, []);
  const deepSince = useRef<string | null>(null);
  useEffect(() => {
    deepSince.current = deep.on ? new Date().toISOString() : null;
  }, [deep.on]);

  // SOPHIA: who she is, and her latest reply on her task.
  const [sophia, setSophia] = useState<SophiaInfo | null>(null);
  const [replies, setReplies] = useState<SophiaReply[]>([]);
  const [askedAt, setAskedAt] = useState<string | null>(null);
  useEffect(() => {
    api.get<SophiaInfo | null>("/ogdoad/sophia").then(setSophia, () => {});
  }, []);
  useEffect(() => {
    if (!sophia) return;
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      api.get<Array<{ id: string; body: string; createdAt: string; authorType?: string; authorAgentId?: string | null }>>(`/api/issues/${sophia.taskId}/comments?order=desc&limit=12`)
        .then((list) => alive && setReplies(list.filter((c) => c.authorAgentId || c.authorType === "agent").map((c) => ({ id: c.id, body: c.body, at: c.createdAt }))), () => {});
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sophia]);

  const [local, setLocal] = useState<Signal[]>([]);
  const say = useCallback((who: string, text: string, tone: Signal["tone"] = "primary") => {
    setLocal((l) => [{ id: `l${Date.now()}${Math.random()}`, at: new Date().toISOString(), who, text, tone, kind: "session" }, ...l].slice(0, 30));
  }, []);

  const { signals, heldHere } = useMemo(() => {
    const names = new Map(team.map((h) => [h.id, shortName(h.label)]));
    const fromHoros: Signal[] = notes.map((n) => ({ id: `h${n.id}`, at: n.at, who: n.hireId ? names.get(n.hireId) ?? "Horos" : "Horos", text: n.title, tone: TONE[n.level], kind: n.kind }));
    const fromSophia: Signal[] = replies.map((r) => ({ id: `s${r.id}`, at: r.at, who: "SOPHIA", text: r.body.replace(/\s+/g, " ").slice(0, 240), tone: "primary", kind: "sophia" }));
    let all = [...(moneySignals.data ?? []), ...fromHoros, ...fromSophia, ...local].sort((a, b) => b.at.localeCompare(a.at));
    // Deep work: anything calmer than an error waits until you're back.
    let held = 0;
    if (deep.on && deepSince.current) {
      const kept = all.filter((s) => s.at < deepSince.current! || s.tone === "bad" || s.kind === "session");
      held = all.length - kept.length;
      all = kept;
    }
    return { signals: all.slice(0, 80), heldHere: held };
  }, [moneySignals.data, notes, replies, local, team, deep.on]);

  const sophiaReply = askedAt ? replies.find((r) => r.at > askedAt) ?? null : null;

  const value: CenterData = {
    info, vault,
    flow: flow.data, reloadFlow: flow.reload,
    overview: overview.data, invoices: invoices.data,
    team, roster, sophia, sophiaReply,
    signals, unread, markRead,
    artifacts: artifacts.data, monthly: monthly.data,
    deep: { ...deep, held: Math.max(deep.held, heldHere) }, setDeep, say,
    markAsked: () => setAskedAt(new Date().toISOString()),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
