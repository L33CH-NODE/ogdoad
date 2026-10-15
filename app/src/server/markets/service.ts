// Markets: the watchlist's prices, kept fresh only while someone is looking. The first viewer starts
// the feeds (Yahoo polled each minute, Binance's live crypto stream, the AUD rate), and a short while
// after the last one leaves they stop: nothing runs in the background, and nothing keeps itself alive.
// Each provider that's told the watchlist is noted once a day in the crossings log.

import { MoneyError, type Money } from "../money/service.js";
import { resolveInstrument, type Instrument, type Kind } from "./instruments.js";
import {
  binance24hUrl, binanceKlinesUrl, binanceStreamUrl, coingeckoChartUrl, coingeckoPriceUrl, FRANKFURTER_USD, parseBinance24h, parseBinanceKlines,
  parseBinanceTick, parseCoinGeckoChart, parseCoinGeckoPrice, parseFrankfurterAud, parseYahooChart, PROVIDERS, yahooUrl,
  type Fetcher, type Points, type Provider, type Range, type Reading,
} from "./sources.js";

export interface Quote {
  id: string;
  name: string;
  kind: Kind;
  market: string;
  currency: string;
  price: number;
  prevClose: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  yearHigh: number | null;
  yearLow: number | null;
  /** Today's path, oldest first, for the sparkline (at most 60 points). */
  spark: number[];
  /** When the price was set, in ms. */
  at: number;
  source: Provider;
  /** Streaming right now (crypto, over Binance's live feed). */
  live: boolean;
  /** The exchange is in its regular session (shares and indices); crypto never closes. */
  open: boolean;
}

export interface History { id: string; range: Range; currency: string; points: Points; source: Provider }

export type MarketEvent =
  | { type: "quote"; quote: Quote }
  | { type: "tick"; id: string; price: number; changePct: number | null; at: number }
  | { type: "watchlist"; ids: string[] }
  | { type: "closed" };

/** What Binance's live stream looks like to this service: Node's WebSocket fits, and so does a test's fake. */
export interface StreamLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  close(): void;
}

export interface MarketDeps {
  fetch: Fetcher;
  /** Opens Binance's live stream. Without it, crypto is polled with everything else. */
  openStream?: ((url: string) => StreamLike) | null;
  now?: () => number;
  /** How often Yahoo and the crypto fallbacks are polled. */
  pollMs?: number;
  /** How long the feeds keep running after the last viewer leaves. */
  graceMs?: number;
}

const MAX_WATCHLIST = 40;
const SPARK_POINTS = 60;
const SAVE_EVERY_MS = 60_000;
const RATE_FRESH_MS = 10 * 60_000;
const HISTORY_TTL: Record<Range, number> = { "1D": 5 * 60_000, "1W": 30 * 60_000, "1M": 3 * 3600_000, "1Y": 12 * 3600_000 };
const STREAM_RETRY_MS = [5_000, 15_000, 60_000, 5 * 60_000];

/** At most n points, evenly picked, always ending on the latest. */
export function thin(values: number[], n: number): number[] {
  if (values.length <= n) return values;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(values[Math.round((i * (values.length - 1)) / (n - 1))]);
  return out;
}

/** Fetch JSON from a public source: a browser-like agent, a time limit, and an error for anything but 2xx. */
export const fetchJson: Fetcher = async (url) => {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Ogdoad markets)", accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
};

/** Node's own WebSocket, when this Node has one. */
export const nodeStream = typeof (globalThis as any).WebSocket === "function" ? (url: string) => new (globalThis as any).WebSocket(url) as StreamLike : null;

export class Markets {
  private readonly listeners = new Set<(e: MarketEvent) => void>();
  private readonly quotes = new Map<string, Quote>();
  private readonly cache = new Map<string, { until: number; history: History }>();
  private readonly saved = new Map<string, number>();
  private readonly told = new Map<string, Set<string>>();
  private running = false;
  private closed = false;
  private poll: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private stream: StreamLike | null = null;
  private streamRetry: NodeJS.Timeout | null = null;
  private streamFails = 0;
  private lastTick = 0;
  private audPerUsd: { rate: number; at: number } | null = null;
  private round: Promise<void> | null = null;

  constructor(private readonly money: Money, private readonly deps: MarketDeps) {
    this.loadSaved();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // --- the watchlist ------------------------------------------------------------------------------

  watchlist(): Instrument[] {
    const rows = this.money.db.prepare("SELECT id FROM market_watchlist ORDER BY position, added_at").all() as Array<{ id: string }>;
    return rows.map((r) => resolveInstrument(r.id)).filter((i): i is Instrument => !!i);
  }

  /** Reorder or trim the watchlist. Every id has to resolve; new ones go through add, which checks them. */
  setWatchlist(ids: string[]): Instrument[] {
    const list: Instrument[] = [];
    for (const raw of ids) {
      const inst = resolveInstrument(String(raw));
      if (!inst) throw new MoneyError("unknown_symbol", `"${raw}" isn't a symbol Ogdoad can follow.`);
      if (!list.some((i) => i.id === inst.id)) list.push(inst);
    }
    if (list.length > MAX_WATCHLIST) throw new MoneyError("too_many", `A watchlist holds up to ${MAX_WATCHLIST} symbols.`);
    const at = new Date(this.now()).toISOString();
    const db = this.money.db;
    db.transaction(() => {
      db.prepare("DELETE FROM market_watchlist").run();
      const put = db.prepare("INSERT INTO market_watchlist (id, position, added_at) VALUES (?, ?, ?)");
      list.forEach((inst, i) => put.run(inst.id, i, at));
      db.prepare(`DELETE FROM market_quotes WHERE id NOT IN (${list.map(() => "?").join(",") || "''"})`).run(...list.map((i) => i.id));
    })();
    for (const id of [...this.quotes.keys()]) if (!list.some((i) => i.id === id)) this.quotes.delete(id);
    this.emit({ type: "watchlist", ids: list.map((i) => i.id) });
    if (this.running) this.restartFeeds();
    return list;
  }

  /** Add a symbol, after checking its source actually has prices for it. */
  async add(symbol: string): Promise<Instrument> {
    const inst = resolveInstrument(symbol);
    if (!inst) throw new MoneyError("unknown_symbol", `"${symbol}" isn't a symbol Ogdoad can follow. Try BTC, BHP.AX, ^AXJO, AUD/USD or GOLD.`);
    const list = this.watchlist();
    if (list.some((i) => i.id === inst.id)) return inst;
    if (inst.yahoo) {
      const got = await this.deps.fetch(yahooUrl(inst.yahoo, "1D")).then(parseYahooChart, () => undefined);
      if (got === undefined) throw new MoneyError("source_down", "Couldn't reach Yahoo to check that symbol. Try again in a minute.");
      if (got === null) throw new MoneyError("unknown_symbol", `Yahoo has no prices for "${inst.yahoo}". ASX shares end in .AX (BHP.AX); indices start with ^ (^AXJO).`);
      this.tell("yahoo", [inst.id]);
      this.setQuote(this.yahooQuote(inst, got.reading, got.points));
    }
    this.setWatchlist([...list.map((i) => i.id), inst.id]);
    return inst;
  }

  // --- viewers ------------------------------------------------------------------------------------

  snapshot(): Quote[] {
    return this.watchlist().map((i) => this.quotes.get(i.id)).filter((q): q is Quote => !!q);
  }

  /** Listen for prices. The first listener starts the feeds; they stop a grace period after the last leaves. */
  subscribe(fn: (e: MarketEvent) => void): () => void {
    if (this.closed) throw new MoneyError("locked", "Ogdoad is locked.");
    this.listeners.add(fn);
    if (this.idle) clearTimeout(this.idle), (this.idle = null);
    if (!this.running) this.start();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size && this.running) {
        this.idle = setTimeout(() => this.stop(), this.deps.graceMs ?? 20_000);
        this.idle.unref?.();
      }
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The books are closing: stop everything and tell every viewer to go. */
  close(): void {
    this.closed = true;
    this.stop();
    this.emit({ type: "closed" });
    this.listeners.clear();
  }

  private emit(e: MarketEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // one viewer's trouble isn't the others'
      }
    }
  }

  private start(): void {
    this.running = true;
    void this.refresh();
    this.poll = setInterval(() => void this.refresh(), this.deps.pollMs ?? 60_000);
    this.poll.unref?.();
    this.openLive();
  }

  private stop(): void {
    this.running = false;
    for (const t of [this.poll, this.idle, this.streamRetry]) if (t) clearTimeout(t);
    this.poll = this.idle = this.streamRetry = null;
    this.closeLive();
  }

  private restartFeeds(): void {
    this.closeLive();
    this.openLive();
    void this.refresh();
  }

  // --- one round of polling -------------------------------------------------------------------------

  /** Fetch everything once. Overlapping asks share the round under way. */
  refresh(): Promise<void> {
    this.round ??= this.doRound().finally(() => (this.round = null));
    return this.round;
  }

  private async doRound(): Promise<void> {
    const list = this.watchlist();
    const coins = list.filter((i) => i.kind === "crypto").map((i) => i.id);
    // Said up front, all at once, so the log has one line per provider rather than one per request.
    this.tell("yahoo", [...list.filter((i) => i.yahoo).map((i) => i.id), ...(coins.length ? ["AUDUSD"] : [])]);
    if (coins.length) this.tell("coingecko", coins);
    await this.ensureRate(list);
    await Promise.allSettled([this.pollYahoo(list), this.pollCrypto(list)]);
  }

  private async ensureRate(list: Instrument[]): Promise<void> {
    if (!list.some((i) => i.kind === "crypto")) return;
    if (this.audPerUsd && this.now() - this.audPerUsd.at < RATE_FRESH_MS) return;
    const yahoo = await this.deps.fetch(yahooUrl("AUDUSD=X", "1D")).then(parseYahooChart, () => null);
    if (yahoo?.reading.price) {
      this.audPerUsd = { rate: 1 / yahoo.reading.price, at: this.now() };
      return;
    }
    const ecb = await this.deps.fetch(FRANKFURTER_USD).then(parseFrankfurterAud, () => null);
    if (ecb) {
      this.tell("frankfurter", ["AUD"]);
      this.audPerUsd = { rate: ecb, at: this.now() };
    }
  }

  private async pollYahoo(list: Instrument[]): Promise<void> {
    const shares = list.filter((i) => i.yahoo);
    if (!shares.length) return;
    // A few at a time: Yahoo is generous, but there's no need to lean on it.
    for (let i = 0; i < shares.length; i += 4) {
      await Promise.allSettled(shares.slice(i, i + 4).map(async (inst) => {
        const got = parseYahooChart(await this.deps.fetch(yahooUrl(inst.yahoo!, "1D")));
        if (!got) return;
        this.setQuote(this.yahooQuote(inst, got.reading, got.points));
        if (inst.id === "AUDUSD" && got.reading.price) this.audPerUsd = { rate: 1 / got.reading.price, at: this.now() };
      }));
    }
  }

  private yahooQuote(inst: Instrument, r: Reading, points: Points): Quote {
    const now = this.now();
    const spark = points.map((p) => p[1]);
    if (spark.at(-1) !== r.price) spark.push(r.price);
    return {
      id: inst.id, name: inst.kind === "stock" && r.name ? r.name : inst.name, kind: inst.kind, market: inst.market, currency: r.currency ?? inst.currency,
      price: r.price, prevClose: r.prevClose, changePct: r.changePct,
      dayHigh: r.dayHigh ?? null, dayLow: r.dayLow ?? null, yearHigh: r.yearHigh ?? null, yearLow: r.yearLow ?? null,
      spark: thin(spark, SPARK_POINTS), at: r.at ?? now, source: "yahoo", live: false,
      open: !!r.session && now >= r.session[0] && now < r.session[1],
    };
  }

  private async pollCrypto(list: Instrument[]): Promise<void> {
    const coins = list.filter((i) => i.kind === "crypto");
    if (!coins.length) return;
    // Prices come over the live stream when it's up; otherwise from Binance, or CoinGecko if Binance is out of reach.
    if (!this.liveNow()) await this.pollCryptoPrices(coins);
    // Then today's path for each sparkline (cached for a few minutes).
    await Promise.allSettled(coins.map(async (inst) => {
      const h = await this.history(inst.id, "1D");
      const q = this.quotes.get(inst.id);
      if (q && h.points.length) this.setQuote({ ...q, spark: thin([...h.points.map((p) => p[1]), q.price], SPARK_POINTS) });
    }));
  }

  private async pollCryptoPrices(coins: Instrument[]): Promise<void> {
    const rate = this.audPerUsd?.rate;
    const tickers = rate ? await this.deps.fetch(binance24hUrl(coins.map((c) => c.binance!))).then(parseBinance24h, () => null) : null;
    if (tickers?.size) {
      this.tell("binance", coins.map((c) => c.id));
      for (const inst of coins) {
        const t = tickers.get(inst.binance!);
        if (t) this.setQuote(this.cryptoQuote(inst, scale(t, rate!), "binance", false));
      }
      return;
    }
    const gecko = await this.deps.fetch(coingeckoPriceUrl(coins.map((c) => c.coingecko!))).then(parseCoinGeckoPrice, () => null);
    if (!gecko?.size) return;
    this.tell("coingecko", coins.map((c) => c.id));
    for (const inst of coins) {
      const r = gecko.get(inst.coingecko!);
      if (r) this.setQuote(this.cryptoQuote(inst, r, "coingecko", false));
    }
  }

  private cryptoQuote(inst: Instrument, r: Reading, source: Provider, live: boolean): Quote {
    const before = this.quotes.get(inst.id);
    return {
      id: inst.id, name: inst.name, kind: "crypto", market: inst.market, currency: "AUD",
      price: r.price, prevClose: r.prevClose, changePct: r.changePct,
      dayHigh: r.dayHigh ?? before?.dayHigh ?? null, dayLow: r.dayLow ?? before?.dayLow ?? null, yearHigh: before?.yearHigh ?? null, yearLow: before?.yearLow ?? null,
      spark: before?.spark ?? [], at: r.at ?? this.now(), source, live, open: true,
    };
  }

  /** Keep a quote (and every minute or so, write it down). announce: send viewers the whole quote; a live tick sends its own lighter event. */
  private setQuote(q: Quote, announce = true): void {
    this.quotes.set(q.id, q);
    if (announce) this.emit({ type: "quote", quote: q });
    const last = this.saved.get(q.id) ?? 0;
    if (this.now() - last < SAVE_EVERY_MS) return;
    this.saved.set(q.id, this.now());
    this.money.db.prepare(`INSERT INTO market_quotes (id, name, kind, market, currency, price, prev_close, change_pct, source, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, market = excluded.market, currency = excluded.currency, price = excluded.price,
      prev_close = excluded.prev_close, change_pct = excluded.change_pct, source = excluded.source, at = excluded.at`)
      .run(q.id, q.name, q.kind, q.market, q.currency, q.price, q.prevClose, q.changePct, q.source, new Date(q.at).toISOString());
  }

  private loadSaved(): void {
    const ids = new Set(this.watchlist().map((i) => i.id));
    const rows = this.money.db.prepare("SELECT * FROM market_quotes").all() as any[];
    for (const r of rows) {
      if (!ids.has(r.id)) continue;
      this.quotes.set(r.id, {
        id: r.id, name: r.name, kind: r.kind, market: r.market, currency: r.currency, price: r.price, prevClose: r.prev_close, changePct: r.change_pct,
        dayHigh: null, dayLow: null, yearHigh: null, yearLow: null, spark: [], at: Date.parse(r.at), source: r.source, live: false, open: false,
      });
    }
  }

  // --- Binance's live stream ------------------------------------------------------------------------

  private liveNow(): boolean {
    return !!this.stream && this.now() - this.lastTick < 30_000;
  }

  private openLive(): void {
    const coins = this.watchlist().filter((i) => i.kind === "crypto");
    if (!coins.length || !this.deps.openStream || this.stream) return;
    let s: StreamLike;
    try {
      s = this.deps.openStream(binanceStreamUrl(coins.map((c) => c.binance!)));
    } catch {
      return this.retryLive();
    }
    this.tell("binance", coins.map((c) => c.id));
    this.stream = s;
    const bySymbol = new Map(coins.map((c) => [c.binance!, c]));
    s.onmessage = (e) => {
      const t = parseBinanceTick(String(e.data));
      const inst = t && bySymbol.get(t.symbol);
      const rate = this.audPerUsd?.rate;
      if (!t || !inst || !rate) return;
      this.streamFails = 0;
      this.lastTick = this.now();
      const r = scale({ price: t.price, prevClose: t.open, changePct: t.open ? ((t.price - t.open) / t.open) * 100 : null, dayHigh: t.high, dayLow: t.low, at: t.at }, rate);
      const q = this.cryptoQuote(inst, r, "binance", true);
      this.setQuote(q, false);
      this.emit({ type: "tick", id: q.id, price: q.price, changePct: q.changePct, at: q.at });
    };
    s.onclose = () => {
      if (this.stream !== s) return;
      this.stream = null;
      for (const q of this.quotes.values()) if (q.live) this.quotes.set(q.id, { ...q, live: false });
      if (this.running) this.retryLive();
    };
    s.onerror = () => {
      try {
        s.close();
      } catch {}
    };
  }

  private retryLive(): void {
    if (!this.running || this.streamRetry) return;
    const wait = STREAM_RETRY_MS[Math.min(this.streamFails++, STREAM_RETRY_MS.length - 1)];
    this.streamRetry = setTimeout(() => {
      this.streamRetry = null;
      if (this.running) this.openLive();
    }, wait);
    this.streamRetry.unref?.();
  }

  private closeLive(): void {
    const s = this.stream;
    this.stream = null;
    if (s) {
      s.onclose = s.onmessage = s.onerror = null;
      try {
        s.close();
      } catch {}
    }
  }

  // --- history --------------------------------------------------------------------------------------

  /** A watchlist symbol's path over a range, cached for a while. A year's closes are kept for panels. */
  async history(id: string, range: Range): Promise<History> {
    const inst = this.watchlist().find((i) => i.id === id);
    if (!inst) throw new MoneyError("not_watched", `${id} isn't on the watchlist.`);
    const key = `${id}:${range}`;
    const hit = this.cache.get(key);
    if (hit && hit.until > this.now()) return hit.history;
    let history: History | null = null;
    if (inst.kind === "crypto") {
      const gecko = await this.deps.fetch(coingeckoChartUrl(inst.coingecko!, range)).then(parseCoinGeckoChart, () => []);
      if (gecko.length) {
        this.tell("coingecko", [inst.id]);
        history = { id, range, currency: "AUD", points: gecko, source: "coingecko" };
      } else {
        const rate = this.audPerUsd?.rate;
        const klines = rate ? await this.deps.fetch(binanceKlinesUrl(inst.binance!, range)).then(parseBinanceKlines, () => []) : [];
        if (klines.length) {
          this.tell("binance", [inst.id]);
          history = { id, range, currency: "AUD", points: klines.map(([t, c]) => [t, c * rate!]), source: "binance" };
        }
      }
    } else {
      const got = await this.deps.fetch(yahooUrl(inst.yahoo!, range)).then(parseYahooChart, () => null);
      if (got) {
        this.tell("yahoo", [inst.id]);
        history = { id, range, currency: got.reading.currency ?? inst.currency, points: got.points, source: "yahoo" };
      }
    }
    if (!history) {
      if (hit) return hit.history;
      throw new MoneyError("source_down", `Couldn't fetch ${id}'s prices just now. Try again in a minute.`);
    }
    this.cache.set(key, { until: this.now() + HISTORY_TTL[range], history });
    if (range === "1Y" || range === "1M") this.keepCloses(id, history.points);
    return history;
  }

  /** Daily closes go into the books' market_daily, so a panel can chart a price next to the money. */
  private keepCloses(id: string, points: Points): void {
    const byDay = new Map<string, number>();
    for (const [t, v] of points) byDay.set(new Date(t).toISOString().slice(0, 10), v);
    const put = this.money.db.prepare("INSERT INTO market_daily (id, day, close) VALUES (?, ?, ?) ON CONFLICT(id, day) DO UPDATE SET close = excluded.close");
    this.money.db.transaction(() => {
      for (const [day, close] of byDay) put.run(id, day, close);
    })();
  }

  // --- the crossings log ----------------------------------------------------------------------------

  /**
   * Note that symbols went out to a provider: one entry per provider a day, listing what it was asked for,
   * and another only when a symbol it hasn't been told today goes out (a new one on the watchlist).
   */
  private tell(provider: Provider, ids: string[]): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const key = `${provider}|${day}`;
    let told = this.told.get(key);
    if (!told) {
      // What this provider was already told today, from the log (the app may have restarted since).
      told = new Set<string>();
      const rows = this.money.db.prepare("SELECT detail FROM events WHERE kind = 'crossing' AND subject_id = ? AND at >= ?").all(`market:${provider}`, day) as Array<{ detail: string }>;
      for (const r of rows) {
        try {
          for (const s of JSON.parse(r.detail).symbols ?? []) told.add(s);
        } catch {}
      }
      this.told.set(key, told);
    }
    const fresh = [...new Set(ids)].filter((id) => !told.has(id)).sort();
    if (!fresh.length) return;
    for (const id of fresh) told.add(id);
    const detail = JSON.stringify({ who: PROVIDERS[provider], via: "market data", where: "cloud", what: `prices for ${fresh.join(", ")} (your watchlist; nothing from the books)`, symbols: fresh });
    this.money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'crossing', ?, ?)").run(new Date(this.now()).toISOString(), `market:${provider}`, detail);
  }
}

/** A USD reading in AUD. */
function scale(r: Reading, audPerUsd: number): Reading {
  const s = (v: number | null | undefined) => (typeof v === "number" ? v * audPerUsd : null);
  return { ...r, price: r.price * audPerUsd, prevClose: s(r.prevClose), dayHigh: s(r.dayHigh), dayLow: s(r.dayLow) };
}
