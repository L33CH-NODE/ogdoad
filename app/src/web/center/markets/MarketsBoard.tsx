// The Markets board in Dashboards: a ticker tape across the top, the focus chart beside a heat grid, a
// tile per symbol (rolling digits, sparkline, a flash when the price ticks), and the watchlist editor.
// The closed Dashboards zone shows only the tape, so the home surface has a pulse.

import { useRef, useState, type FormEvent } from "react";

import { fmtPct, fmtPrice, useMarkets, type Instrument, type Quote } from "../../lib/markets";
import { useFlash, useReducedMotion } from "../../lib/motion";
import { FocusChart } from "./FocusChart";
import { heatLevel } from "./heat";
import { ChangePill, LiveDot, RollingNumber, Sparkline, useWidth } from "./parts";

function TapeItem({ q }: { q: Quote }) {
  const flash = useFlash(q.price);
  return (
    <span className={`tape-item${flash ? ` flash-${flash}` : ""}`}>
      <b>{q.id}</b>
      <span className="mono">{fmtPrice(q.price, q.currency, q.kind)}</span>
      <ChangePill pct={q.changePct} />
    </span>
  );
}

/** Every price on the watchlist, scrolling past. It pauses under the pointer; with reduced motion it just sits there to be scrolled. */
export function TickerTape({ quotes }: { quotes: Quote[] }) {
  const reduced = useReducedMotion();
  if (!quotes.length) return <div className="tape tape-empty"><span className="shimmer" /></div>;
  // Two identical groups, each carrying its own trailing gap: sliding exactly half the track loops without a seam.
  return (
    <div className={`tape${reduced ? " still" : ""}`} aria-label="Watchlist prices">
      <div className="tape-track" style={{ animationDuration: `${Math.max(24, quotes.length * 5)}s` }}>
        <span className="tape-group">{quotes.map((q) => <TapeItem key={q.id} q={q} />)}</span>
        {reduced ? null : <span className="tape-group" aria-hidden="true">{quotes.map((q) => <TapeItem key={`copy-${q.id}`} q={q} />)}</span>}
      </div>
    </div>
  );
}

function QuoteTile({ q, i, selected, onSelect }: { q: Quote; i: number; selected: boolean; onSelect: (id: string) => void }) {
  const flash = useFlash(q.price);
  const box = useRef<HTMLButtonElement>(null);
  const w = useWidth(box);
  return (
    <button ref={box} className={`qtile rise${flash ? ` tick-${flash}` : ""}${selected ? " on" : ""}`} style={{ ["--i" as string]: i }} onClick={() => onSelect(q.id)} aria-pressed={selected}>
      <span className="qtile-top">
        <span className="qtile-sym">{q.id}</span>
        <span className="qtile-mkt">{q.market}</span>
        <span className="spacer" />
        {q.live ? <LiveDot /> : q.kind !== "crypto" ? <span className={`mkt-state${q.open ? " open" : ""}`}>{q.open ? "open" : "closed"}</span> : null}
      </span>
      <span className="qtile-name">{q.name}</span>
      <RollingNumber className="qtile-price" text={fmtPrice(q.price, q.currency, q.kind)} />
      <ChangePill pct={q.changePct} />
      <Sparkline values={q.spark} up={(q.changePct ?? 0) >= 0} width={Math.max(0, w - 26)} />
    </button>
  );
}

function HeatGrid({ quotes, selected, onSelect }: { quotes: Quote[]; selected: string | undefined; onSelect: (id: string) => void }) {
  return (
    <div className="heat" role="list" aria-label="How each moved today">
      {quotes.map((q, i) => {
        const level = heatLevel(q);
        const tone = (q.changePct ?? 0) >= 0 ? "var(--good)" : "var(--bad)";
        return (
          <button key={q.id} role="listitem" className={`heat-cell rise${q.id === selected ? " on" : ""}`} onClick={() => onSelect(q.id)} title={`${q.name}: ${fmtPrice(q.price, q.currency, q.kind)}, ${fmtPct(q.changePct)}`}
            style={{ ["--i" as string]: i, ["--heat" as string]: `${Math.round(8 + level * 62)}%`, ["--tone" as string]: tone }}>
            <b>{q.id}</b>
            <span>{fmtPct(q.changePct)}</span>
          </button>
        );
      })}
    </div>
  );
}

function WatchlistEditor({ watchlist, add, order }: { watchlist: Instrument[]; add: (s: string) => Promise<void>; order: (ids: string[]) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const symbols = text.split(/[,\s]+/).filter(Boolean);
    if (!symbols.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const s of symbols) await add(s);
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const drop = (id: string) => void order(watchlist.filter((w) => w.id !== id).map((w) => w.id)).catch((err) => setError((err as Error).message));
  return (
    <div className="wl-edit enter">
      <div className="wl-chips">
        {watchlist.map((w) => (
          <span key={w.id} className="wl-chip" title={w.name}>
            {w.id}
            <button onClick={() => drop(w.id)} aria-label={`Take ${w.id} off the watchlist`}>×</button>
          </span>
        ))}
      </div>
      <form className="row" style={{ gap: 6 }} onSubmit={(e) => void submit(e)}>
        <label htmlFor="wl-add" className="sr">Add symbols</label>
        <input id="wl-add" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add: DOGE, WES.AX, ^DJI, EUR/AUD, SILVER" autoComplete="off" spellCheck={false} />
        <button className="btn small primary" type="submit" disabled={busy || !text.trim()}>{busy ? "Checking…" : "Add"}</button>
      </form>
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <span className="muted" style={{ fontSize: 11.5 }}>ASX shares end in .AX, indices start with ^, currencies are pairs like AUD/USD. Crypto: BTC, ETH, SOL and the other majors.</span>
    </div>
  );
}

/** The whole board, for the open Dashboards zone. */
export function MarketsBoard() {
  const m = useMarkets();
  const quotes = m.watchlist.map((w) => m.quotes[w.id]).filter((q): q is Quote => !!q);
  const [picked, setPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const focus = quotes.find((q) => q.id === picked) ?? quotes[0];
  const live = quotes.some((q) => q.live);

  return (
    <section className="markets" aria-label="Markets">
      <header className="mk-head">
        <span className="zlabel">Markets</span>
        <span className="mk-state">{live ? <><LiveDot /> live</> : m.connected ? "updating each minute" : m.error ? <span className="error-text">{m.error}</span> : "connecting…"}</span>
        <span className="spacer" />
        <button className={`hint${editing ? " on" : ""}`} aria-pressed={editing} onClick={() => setEditing(!editing)}>Watchlist</button>
      </header>
      <TickerTape quotes={quotes} />
      {editing ? <WatchlistEditor watchlist={m.watchlist} add={m.add} order={m.order} /> : null}
      {focus ? (
        <div className="mk-main">
          <FocusChart q={focus} />
          <HeatGrid quotes={quotes} selected={focus.id} onSelect={setPicked} />
        </div>
      ) : null}
      <div className="mk-tiles">
        {quotes.map((q, i) => <QuoteTile key={q.id} q={q} i={i} selected={q.id === focus?.id} onSelect={setPicked} />)}
      </div>
      <p className="mk-sources muted">
        Live crypto from Binance, priced in AUD; shares, indices, currencies and gold from Yahoo (unofficial, for personal use); CoinGecko and the ECB's rates fill in. They see your watchlist and nothing from your books, and each one is listed in "What the cloud has seen". Panels can read these prices too, as the quotes and prices tables.
      </p>
    </section>
  );
}

/** The closed zone's strip: just the tape. */
export function MarketsStrip() {
  const m = useMarkets();
  return <TickerTape quotes={m.watchlist.map((w) => m.quotes[w.id]).filter((q): q is Quote => !!q)} />;
}
