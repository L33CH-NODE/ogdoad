// Everything the control center shows, loaded once and kept live: Flow and Money (through the app's
// stream), the team (through Horos's), SOPHIA's replies (her task's comments), and the lines this
// session adds itself. Zones read it from context, so one change updates every zone that cares.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, getAppInfo, type AppInfo, type Artifact, type FlowView, type HireInfo, type InvoiceSummary, type Overview, type Panel, type Recipe, type RosterEntry, type Signal, type SophiaInfo, type VaultStatus } from "../lib/api";
import { useHoros, useNotifications, useTeam } from "../lib/horos";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";

export interface SophiaReply { id: string; body: string; at: string }
/** A panel recipe SOPHIA sent back in a reply, waiting for the operator to look at it. */
export interface SophiaRecipe extends Recipe { replyId: string; at: string }

/** Recipes in a reply: JSON in a fenced block tagged ogdoad-recipe. Anything that doesn't parse is skipped. */
export function recipesIn(reply: SophiaReply): SophiaRecipe[] {
  const out: SophiaRecipe[] = [];
  for (const m of reply.body.matchAll(/```ogdoad-recipe\s*([\s\S]*?)```/g)) {
    try {
      const r = JSON.parse(m[1]);
      if (typeof r.title === "string" && typeof r.sql === "string" && r.chart && typeof r.chart.type === "string") out.push({ title: r.title, sql: r.sql, chart: r.chart, replyId: reply.id, at: reply.at });
    } catch {
      // Not a recipe after all.
    }
  }
  return out;
}

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
  panels: Panel[] | null;
  reloadPanels: () => void;
  /** Recipes SOPHIA has sent, newest first. */
  sophiaRecipes: SophiaRecipe[];
  /** Ask SOPHIA for a panel: she gets the request and the tables' shape, never a row. */
  askPanel: (request: string) => Promise<void>;
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
  const panels = useLive<Panel[]>("/ogdoad/dashboards");

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
      api.get<{ items: Array<{ id: string; body: string; createdAt: string; authorId: string | null }> }>(`/nous/v1/tasks/${sophia.taskId}/messages?limit=12`)
        .then((r) => alive && setReplies(r.items.filter((c) => c.authorId).map((c) => ({ id: c.id, body: c.body, at: c.createdAt }))), () => {});
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
  const sophiaRecipes = useMemo(() => replies.flatMap(recipesIn), [replies]);

  const askPanel = useCallback(async (request: string) => {
    if (!sophia) {
      say("Ogdoad", "SOPHIA isn't set up yet, so there's no one to ask. You can write a panel yourself in Dashboards.", "warn");
      return;
    }
    const { text } = await api.get<{ text: string }>("/ogdoad/dashboards/schema");
    const body = [
      `Dashboard request from the operator: "${request.trim()}"`,
      "",
      "Please reply with one panel recipe, as JSON in a fenced code block tagged ogdoad-recipe, like this:",
      "```ogdoad-recipe",
      '{"title": "Owed to you", "sql": "SELECT SUM(total - paid) AS owed FROM invoices WHERE status = \'issued\'", "chart": {"type": "stat", "y": ["owed"], "format": "aud"}}',
      "```",
      "The query runs on the operator's machine (SQLite), over these tables only. You won't see any rows, and you don't need to:",
      text,
      "",
      "chart.type is bar, line, stat or table. x is the column along the bottom (bar, line). y lists the numeric columns to draw. format is aud, number, hours or percent. Amounts are dollars.",
    ].join("\n");
    const r = await api.post<{ held?: { id: string } }>(`/nous/v1/tasks/${sophia.taskId}/messages`, { body, requestId: crypto.randomUUID() });
    if (r?.held) {
      say("Ogdoad", "That request names someone, so it's held: check it in Flow before it goes.", "warn");
      return navigate(`/flow/check/${r.held.id}`);
    }
    say("you", `asked SOPHIA for a panel: ${request.trim()}`);
    setAskedAt(new Date().toISOString());
  }, [sophia, say]);

  const value: CenterData = {
    info, vault,
    flow: flow.data, reloadFlow: flow.reload,
    overview: overview.data, invoices: invoices.data,
    team, roster, sophia, sophiaReply,
    signals, unread, markRead,
    artifacts: artifacts.data,
    panels: panels.data, reloadPanels: panels.reload, sophiaRecipes, askPanel,
    deep: { ...deep, held: Math.max(deep.held, heldHere) }, setDeep, say,
    markAsked: () => setAskedAt(new Date().toISOString()),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
