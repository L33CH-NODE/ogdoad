// The Markets board's data: one live stream for the whole page, opened while something shows prices
// and closed when nothing does, or when the tab is hidden (the server then stops its feeds: nothing
// runs for a page nobody is looking at). Plus a symbol's history over a range, and price formatting.

import { useEffect, useState, useSyncExternalStore } from "react";

import { api } from "./api";

export type Kind = "crypto" | "stock" | "index" | "fx" | "commodity";
export type Range = "1D" | "1W" | "1M" | "1Y";
export const RANGES: Range[] = ["1D", "1W", "1M", "1Y"];

export interface Instrument { id: string; name: string; kind: Kind; currency: string; market: string }

export interface Quote {
  id: string; name: string; kind: Kind; market: string; currency: string;
  price: number; prevClose: number | null; changePct: number | null;
  dayHigh: number | null; dayLow: number | null; yearHigh: number | null; yearLow: number | null;
  spark: number[]; at: number; source: "yahoo" | "binance" | "coingecko" | "frankfurter"; live: boolean; open: boolean;
}

export interface History { id: string; range: Range; currency: string; points: Array<[number, number]>; source: string }

interface State { watchlist: Instrument[]; quotes: Record<string, Quote>; connected: boolean; error: string | null }

let state: State = { watchlist: [], quotes: {}, connected: false, error: null };
const subscribers = new Set<() => void>();
let source: EventSource | null = null;
let users = 0;

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const s of subscribers) s();
}

function connect(): void {
  if (source || document.hidden) return;
  source = new EventSource("/ogdoad/markets/stream");
  source.addEventListener("open", () => set({ connected: true, error: null }));
  source.addEventListener("error", () => set({ connected: false }));
  source.addEventListener("snapshot", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { watchlist: Instrument[]; quotes: Quote[] };
    set({ watchlist: d.watchlist, quotes: Object.fromEntries(d.quotes.map((q) => [q.id, q])), connected: true });
  });
  source.addEventListener("quote", (e) => {
    const { quote } = JSON.parse((e as MessageEvent).data) as { quote: Quote };
    set({ quotes: { ...state.quotes, [quote.id]: quote } });
  });
  source.addEventListener("tick", (e) => {
    const t = JSON.parse((e as MessageEvent).data) as { id: string; price: number; changePct: number | null; at: number };
    const q = state.quotes[t.id];
    if (q) set({ quotes: { ...state.quotes, [t.id]: { ...q, price: t.price, changePct: t.changePct, at: t.at, live: true } } });
  });
  source.addEventListener("watchlist", () => void reload());
}

function disconnect(): void {
  source?.close();
  source = null;
  set({ connected: false });
}

async function reload(): Promise<void> {
  try {
    const d = await api.get<{ watchlist: Instrument[]; quotes: Quote[] }>("/ogdoad/markets");
    set({ watchlist: d.watchlist, quotes: Object.fromEntries(d.quotes.map((q) => [q.id, q])), error: null });
  } catch (err) {
    set({ error: (err as Error).message });
  }
}

const onVisibility = () => (document.hidden ? disconnect() : users > 0 && connect());

/** The watchlist and its prices, live while the component is on screen. */
export function useMarkets(): State & { add: (symbol: string) => Promise<void>; order: (ids: string[]) => Promise<void> } {
  useEffect(() => {
    if (users++ === 0) {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("ogdoad:locked", disconnect);
      void reload();
      connect();
    }
    return () => {
      if (--users === 0) {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("ogdoad:locked", disconnect);
        disconnect();
      }
    };
  }, []);
  const snap = useSyncExternalStore((fn) => (subscribers.add(fn), () => subscribers.delete(fn)), () => state);
  return {
    ...snap,
    add: async (symbol) => {
      await api.post("/ogdoad/markets/watchlist", { symbol });
      await reload();
    },
    order: async (ids) => {
      await api.put("/ogdoad/markets/watchlist", { ids });
      await reload();
    },
  };
}

/** A symbol's path over a range; the day's path refreshes every minute while shown. */
export function useHistory(id: string | null, range: Range): { history: History | null; error: string | null; loading: boolean } {
  const [got, setGot] = useState<{ key: string; history: History | null; error: string | null }>({ key: "", history: null, error: null });
  const key = `${id}:${range}`;
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = () => api.get<History>(`/ogdoad/markets/history?id=${encodeURIComponent(id)}&range=${range}`)
      .then((h) => alive && setGot({ key, history: h, error: null }), (err) => alive && setGot((g) => ({ key, history: g.key === key ? g.history : null, error: (err as Error).message })));
    void load();
    const t = range === "1D" ? setInterval(() => !document.hidden && void load(), 60_000) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [key]);
  return { history: got.key === key ? got.history : null, error: got.key === key ? got.error : null, loading: got.key !== key };
}

// --- formatting ---------------------------------------------------------------------------------

const SYMBOL: Record<string, string> = { AUD: "$", USD: "US$", EUR: "€", GBP: "£", JPY: "¥", NZD: "NZ$", CAD: "C$", HKD: "HK$" };

/** Enough decimals to see it move: 2 for most prices, more for small ones and currencies. */
export function priceDigits(price: number, kind?: Kind): number {
  if (kind === "fx") return 4;
  const a = Math.abs(price);
  if (a >= 1) return 2;
  if (a >= 0.01) return 4;
  return 8;
}

export function fmtPrice(price: number, currency: string, kind?: Kind): string {
  const d = priceDigits(price, kind);
  const n = price.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d });
  if (kind === "fx" || kind === "index") return n;
  return `${SYMBOL[currency] ?? `${currency} `}${n}`;
}

/** "+1.25%", "−0.73%" (a true minus sign, so the columns line up). */
export function fmtPct(pct: number | null | undefined): string {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return "–";
  const r = Math.round(pct * 100) / 100;
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r).toFixed(2)}%`;
}

export const KIND_LABEL: Record<Kind, string> = { crypto: "Crypto", stock: "Share", index: "Index", fx: "Currency", commodity: "Commodity" };
