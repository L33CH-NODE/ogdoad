// The free, keyless market sources, each as a URL builder plus a parser. Parsers take the source's JSON
// and return plain numbers, so they're tested on captured responses without touching the network.
// What leaves this machine is only symbols (the watchlist); nothing from the books ever goes out.

import type { Instrument } from "./instruments.js";

export type Range = "1D" | "1W" | "1M" | "1Y";
export const RANGES: Range[] = ["1D", "1W", "1M", "1Y"];

/** [time in ms, price] pairs, oldest first. */
export type Points = Array<[number, number]>;

export interface Reading {
  price: number;
  prevClose: number | null;
  changePct: number | null;
  name?: string;
  currency?: string;
  dayHigh?: number | null;
  dayLow?: number | null;
  yearHigh?: number | null;
  yearLow?: number | null;
  /** The exchange's regular session right now: [start, end] in ms. */
  session?: [number, number] | null;
  /** When the source says the price was set, in ms. */
  at?: number;
}

export type Fetcher = (url: string) => Promise<unknown>;

/** Who each source is, as the operator's crossings log names it. */
export const PROVIDERS = {
  yahoo: "Yahoo Finance",
  binance: "Binance",
  coingecko: "CoinGecko",
  frankfurter: "Frankfurter (ECB rates)",
} as const;
export type Provider = keyof typeof PROVIDERS;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (price: number, prev: number | null) => (prev ? ((price - prev) / prev) * 100 : null);

// --- Yahoo: shares, indices, currencies, commodities --------------------------------------------

const YAHOO_RANGE: Record<Range, [range: string, interval: string]> = { "1D": ["1d", "5m"], "1W": ["5d", "30m"], "1M": ["1mo", "1d"], "1Y": ["1y", "1d"] };

export function yahooUrl(symbol: string, range: Range = "1D"): string {
  const [r, i] = YAHOO_RANGE[range];
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${r}&interval=${i}`;
}

/** A Yahoo chart response: the latest reading and the path it drew. Null when Yahoo has no such symbol. */
export function parseYahooChart(json: any): { reading: Reading; points: Points } | null {
  const r = json?.chart?.result?.[0];
  const m = r?.meta;
  const price = num(m?.regularMarketPrice);
  if (!m || price === null) return null;
  // Yahoo's own change for the day is the one to trust: an index's previousClose can be a session stale
  // (the ASX 200's was, on 2026-10-15). The close the day is measured from is worked back from it.
  const yahooPct = num(m.regularMarketChangePercent);
  const prev = yahooPct !== null && yahooPct > -100 ? price / (1 + yahooPct / 100) : num(m.previousClose) ?? num(m.chartPreviousClose);
  const ts: unknown[] = Array.isArray(r.timestamp) ? r.timestamp : [];
  const closes: unknown[] = r.indicators?.quote?.[0]?.close ?? [];
  const points: Points = [];
  ts.forEach((t, i) => {
    const c = num(closes[i]);
    if (typeof t === "number" && c !== null) points.push([t * 1000, c]);
  });
  const period = m.currentTradingPeriod?.regular;
  return {
    reading: {
      price,
      prevClose: prev,
      changePct: yahooPct ?? pct(price, prev),
      name: typeof m.longName === "string" ? m.longName : typeof m.shortName === "string" ? m.shortName : undefined,
      currency: typeof m.currency === "string" ? m.currency : undefined,
      dayHigh: num(m.regularMarketDayHigh),
      dayLow: num(m.regularMarketDayLow),
      yearHigh: num(m.fiftyTwoWeekHigh),
      yearLow: num(m.fiftyTwoWeekLow),
      session: period && num(period.start) !== null && num(period.end) !== null ? [period.start * 1000, period.end * 1000] : null,
      at: num(m.regularMarketTime) !== null ? m.regularMarketTime * 1000 : undefined,
    },
    points,
  };
}

// --- Binance: crypto, live ----------------------------------------------------------------------

export function binance24hUrl(symbols: string[]): string {
  return `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
}

/** Binance's 24-hour tickers, by symbol: the last price and the price 24 hours ago, in USDT. */
export function parseBinance24h(json: unknown): Map<string, Reading> {
  const out = new Map<string, Reading>();
  if (!Array.isArray(json)) return out;
  for (const t of json) {
    const price = num(t?.lastPrice);
    const open = num(t?.openPrice);
    if (typeof t?.symbol !== "string" || price === null) continue;
    out.set(t.symbol, { price, prevClose: open, changePct: num(t.priceChangePercent) ?? pct(price, open), dayHigh: num(t.highPrice), dayLow: num(t.lowPrice), at: num(t.closeTime) ?? undefined });
  }
  return out;
}

export function binanceStreamUrl(symbols: string[]): string {
  return `wss://stream.binance.com:9443/stream?streams=${symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/")}`;
}

/** One message from Binance's combined mini-ticker stream: the symbol, its last price and its price 24 hours ago. */
export function parseBinanceTick(raw: string): { symbol: string; price: number; open: number | null; high: number | null; low: number | null; at: number } | null {
  try {
    const d = JSON.parse(raw)?.data ?? JSON.parse(raw);
    const price = num(d?.c);
    if (d?.e !== "24hrMiniTicker" || typeof d.s !== "string" || price === null) return null;
    return { symbol: d.s, price, open: num(d.o), high: num(d.h), low: num(d.l), at: num(d.E) ?? Date.now() };
  } catch {
    return null;
  }
}

const BINANCE_KLINES: Record<Range, [interval: string, limit: number]> = { "1D": ["15m", 96], "1W": ["2h", 84], "1M": ["8h", 90], "1Y": ["1d", 365] };

export function binanceKlinesUrl(symbol: string, range: Range): string {
  const [interval, limit] = BINANCE_KLINES[range];
  return `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
}

/** Binance candles as [close time, close], in USDT. */
export function parseBinanceKlines(json: unknown): Points {
  if (!Array.isArray(json)) return [];
  const out: Points = [];
  for (const k of json) {
    const t = num(k?.[6]);
    const c = num(k?.[4]);
    if (t !== null && c !== null) out.push([t, c]);
  }
  return out;
}

// --- CoinGecko: crypto in AUD, the fallback and the AUD history ---------------------------------

export function coingeckoPriceUrl(ids: string[]): string {
  return `https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(",")}&vs_currencies=aud&include_24hr_change=true&include_last_updated_at=true`;
}

export function parseCoinGeckoPrice(json: any): Map<string, Reading> {
  const out = new Map<string, Reading>();
  for (const [id, v] of Object.entries(json ?? {})) {
    const price = num((v as any)?.aud);
    if (price === null) continue;
    const change = num((v as any)?.aud_24h_change);
    out.set(id, { price, prevClose: change !== null ? price / (1 + change / 100) : null, changePct: change, at: num((v as any)?.last_updated_at) !== null ? (v as any).last_updated_at * 1000 : undefined });
  }
  return out;
}

const COINGECKO_DAYS: Record<Range, string> = { "1D": "1", "1W": "7", "1M": "30", "1Y": "365" };

export function coingeckoChartUrl(id: string, range: Range): string {
  return `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=aud&days=${COINGECKO_DAYS[range]}`;
}

export function parseCoinGeckoChart(json: any): Points {
  const prices = json?.prices;
  if (!Array.isArray(prices)) return [];
  return prices.filter((p: unknown) => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null).map((p: number[]) => [p[0], p[1]] as [number, number]);
}

// --- Frankfurter: the AUD rate, when Yahoo's isn't to hand -------------------------------------

export const FRANKFURTER_USD = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD";

/** How many Australian dollars one US dollar buys. */
export function parseFrankfurterAud(json: any): number | null {
  return num(json?.rates?.AUD);
}

/** The instruments a source serves, from a watchlist. */
export const servedBy = {
  yahoo: (list: Instrument[]) => list.filter((i) => i.yahoo),
  crypto: (list: Instrument[]) => list.filter((i) => i.kind === "crypto"),
};
