// VIII. Dashboards: panels made for the operator. Each is a recipe, a saved query over the curated
// tables plus a chart spec, never pasted numbers, and any panel shows its query on request. Ogdoad
// ships two. The operator writes more here, or asks SOPHIA, who writes the query from the tables'
// shape alone: it runs here, and she never sees a row.

import { useEffect, useMemo, useState } from "react";

import { Icon } from "../components/icons";
import { api, type ChartSpec, type Panel, type PanelResult, type Recipe } from "../lib/api";
import { navigate } from "../lib/router";
import { Chart } from "./Chart";
import { useZoom, Zone } from "./ControlCenter";
import { useCenter, type SophiaRecipe } from "./data";

const who = (p: { madeBy: string }) => (p.madeBy === "Ogdoad" ? "built in" : p.madeBy === "you" ? "yours" : `by ${p.madeBy}`);
const sawWhat = (p: { madeBy: string }) =>
  p.madeBy === "you" || p.madeBy === "Ogdoad" ? "It ran here, on the curated tables. Nothing left this machine." : `${p.madeBy} wrote the query from the tables' shape. It ran here; ${p.madeBy} never saw a row.`;

function PanelFigure({ p, tall, onRemove }: { p: Panel; tall: boolean; onRemove?: () => void }) {
  const [query, setQuery] = useState(false);
  return (
    <figure className="panel">
      <figcaption className="panel-cap">
        <strong>{p.title}</strong>{tall ? <span className="muted"> · {who(p)}</span> : null}
        <span className="spacer" />
        <button className={`hint${query ? " on" : ""}`} onClick={() => setQuery(!query)} aria-pressed={query} title="Every panel shows its query">query</button>
        {onRemove ? <button className="icon-btn" onClick={onRemove} aria-label={`Take down ${p.title}`} title="Take it down"><Icon name="close" size={13} /></button> : null}
      </figcaption>
      {query ? (
        <div className="stack" style={{ gap: 6 }}>
          <pre className="panel-sql">{p.sql}</pre>
          <span className="muted" style={{ fontSize: 11.5 }}>{p.chart.type}{p.chart.x ? ` · x ${p.chart.x}` : ""}{p.chart.y?.length ? ` · y ${p.chart.y.join(", ")}` : ""}{p.chart.format ? ` · ${p.chart.format}` : ""}. {sawWhat(p)}</span>
        </div>
      ) : <Chart spec={p.chart} result={p.result} tall={tall} label={p.title} />}
    </figure>
  );
}

const seenKey = "ogdoad.recipes.seen";
const readSeen = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(seenKey) ?? "[]");
  } catch {
    return [];
  }
};

function Editor({ start, onDone }: { start: (Recipe & { madeBy?: string }) | null; onDone: () => void }) {
  const { reloadPanels, say } = useCenter();
  const [r, setR] = useState<Recipe>(start ?? { title: "", sql: "SELECT client, SUM(total) AS invoiced\nFROM invoices WHERE status = 'issued'\nGROUP BY client ORDER BY invoiced DESC", chart: { type: "bar", x: "client", y: ["invoiced"], format: "aud" } });
  const [preview, setPreview] = useState<PanelResult | null>(null);
  const [schema, setSchema] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (start) setR(start);
    setPreview(null);
  }, [start]);
  const set = (chart: Partial<ChartSpec>) => setR((x) => ({ ...x, chart: { ...x.chart, ...chart } }));
  const run = async (recipe: Recipe = r) => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.post<PanelResult>("/ogdoad/dashboards/preview", recipe));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (start) void run(start);
  }, [start]);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/ogdoad/dashboards", { ...r, madeBy: start?.madeBy ?? "you" });
      say("you", `pinned a panel: ${r.title}`, "good");
      reloadPanels();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const columns = preview?.ok ? preview.columns : [];
  const numeric = preview?.ok ? columns.filter((_, i) => preview.rows.some((row) => typeof row[i] === "number")) : [];

  return (
    <div className="panel stack editor" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong style={{ fontSize: 15 }}>{start?.madeBy && start.madeBy !== "you" ? `${start.madeBy} sent a panel` : "A new panel"}</strong>
        <button className="link-btn" style={{ fontSize: 12 }} onClick={() => (schema ? setSchema(null) : api.get<{ text: string }>("/ogdoad/dashboards/schema").then((s) => setSchema(s.text), () => {}))}>{schema ? "hide the tables" : "what a panel can read"}</button>
      </div>
      {schema ? <pre className="panel-sql">{schema}</pre> : null}
      <label className="field">Title<input className="input" value={r.title} onChange={(e) => setR((x) => ({ ...x, title: e.target.value }))} placeholder="What it shows" /></label>
      <label className="field">Query (SQLite, read only)
        <textarea className="input mono" rows={5} value={r.sql} onChange={(e) => setR((x) => ({ ...x, sql: e.target.value }))} spellCheck={false} />
      </label>
      <div className="row" style={{ gap: 10 }}>
        <label className="field" style={{ minWidth: 110 }}>Chart
          <select className="input" value={r.chart.type} onChange={(e) => set({ type: e.target.value as ChartSpec["type"] })}>
            {["bar", "line", "stat", "table"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 110 }}>Along the bottom
          <select className="input" value={r.chart.x ?? ""} onChange={(e) => set({ x: e.target.value || undefined })}>
            <option value="">none</option>
            {(columns.length ? columns : r.chart.x ? [r.chart.x] : []).map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field" style={{ minWidth: 110 }}>Shown as
          <select className="input" value={r.chart.format ?? "number"} onChange={(e) => set({ format: e.target.value as ChartSpec["format"] })}>
            {["aud", "number", "hours", "percent"].map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
      </div>
      {numeric.length ? (
        <div className="row" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Draw</span>
          {numeric.map((c) => {
            const on = r.chart.y?.includes(c) ?? false;
            return <button key={c} className={`hint${on ? " on" : ""}`} aria-pressed={on} onClick={() => set({ y: on ? r.chart.y!.filter((x) => x !== c) : [...(r.chart.y ?? []), c] })}>{c}</button>;
          })}
        </div>
      ) : null}
      {preview ? <div className="preview"><Chart spec={r.chart} result={preview} label={r.title || "preview"} /></div> : null}
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn small" onClick={onDone}>Not now</button>
        <button className="btn small" disabled={busy} onClick={() => void run()}>Run it</button>
        <button className="btn small primary" disabled={busy || !r.title.trim() || !preview?.ok} onClick={() => void add()} title={preview?.ok ? "" : "Run it first"}>Pin it</button>
      </div>
    </div>
  );
}

export function DashboardsZone() {
  const { panels, reloadPanels, sophiaRecipes, askPanel, say } = useCenter();
  const open = useZoom() === "dashboards";
  const [seen, setSeen] = useState<string[]>(readSeen);
  const [editing, setEditing] = useState<(Recipe & { madeBy?: string }) | null | "new">(null);
  const [asking, setAsking] = useState("");
  const list = panels ?? [];

  // SOPHIA's newest recipe that isn't pinned yet and hasn't been set aside.
  const incoming: SophiaRecipe | null = useMemo(
    () => sophiaRecipes.find((r) => !seen.includes(`${r.replyId}:${r.title}`) && !list.some((p) => p.sql.trim() === r.sql.trim())) ?? null,
    [sophiaRecipes, seen, list],
  );
  const setAside = (r: SophiaRecipe) => {
    const next = [...seen, `${r.replyId}:${r.title}`].slice(-200);
    setSeen(next);
    try {
      localStorage.setItem(seenKey, JSON.stringify(next));
    } catch {}
  };
  const remove = async (p: Panel) => {
    await api.del(`/ogdoad/dashboards/${p.id}`).then(reloadPanels, (err) => say("Ogdoad", (err as Error).message, "bad"));
  };
  const ask = async () => {
    const text = asking.trim();
    if (!text) return;
    setAsking("");
    await askPanel(text).catch((err) => say("Ogdoad", `Couldn't reach SOPHIA: ${(err as Error).message}`, "bad"));
  };
  const chip = <span className="chip quiet">{list.length} panel{list.length === 1 ? "" : "s"}</span>;

  const incomingTile = incoming ? (
    <div className="panel incoming enter">
      <span className="zlabel" style={{ color: "var(--primary)" }}>SOPHIA sent a panel</span>
      <strong style={{ fontSize: 14 }}>{incoming.title}</strong>
      <span className="muted" style={{ fontSize: 12 }}>Written from the tables' shape. It runs here when you look.</span>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn small primary" onClick={() => { setEditing({ ...incoming, madeBy: "SOPHIA" }); navigate("/dashboards"); }}>Look at it</button>
        <button className="btn small" onClick={() => setAside(incoming)}>Set it aside</button>
      </div>
    </div>
  ) : null;

  if (!open) {
    return (
      <Zone id="dashboards" chip={chip}>
        <div className="dash-grid">
          {list.slice(0, 1).map((p) => <PanelFigure key={p.id} p={p} tall={false} />)}
          {incomingTile}
          {!incoming ? (
            <button className="panel ask" onClick={() => navigate("/dashboards")}>
              <Icon name="chart" size={18} />
              <span>A panel of your own</span>
              <span className="muted">Write one, or ask SOPHIA. She writes the query; it runs here, and she never sees the numbers.</span>
            </button>
          ) : null}
        </div>
      </Zone>
    );
  }

  return (
    <Zone id="dashboards" chip={chip}>
      <div className="stack" style={{ gap: 14 }}>
        <form className="ask-bar" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <span className="orb small" aria-hidden="true" />
          <label htmlFor="dash-ask" className="sr">Ask SOPHIA for a panel</label>
          <input id="dash-ask" value={asking} onChange={(e) => setAsking(e.target.value)} placeholder="Ask SOPHIA for a panel: hours by participant this month, money owed by client…" autoComplete="off" />
          <button className="btn small" type="submit" disabled={!asking.trim()}>Ask</button>
          <button className="btn small primary" type="button" onClick={() => setEditing("new")}><Icon name="plus" size={14} /> Write one</button>
        </form>
        {editing ? <Editor start={editing === "new" ? null : editing} onDone={() => { if (editing !== "new" && editing && incoming) setAside(incoming); setEditing(null); }} /> : incomingTile}
        <div className="dash-grid open">
          {list.map((p) => <PanelFigure key={p.id} p={p} tall onRemove={() => void remove(p)} />)}
        </div>
      </div>
    </Zone>
  );
}
