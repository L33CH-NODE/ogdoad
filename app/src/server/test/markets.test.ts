// Markets on made-up books and a made-up network: symbols resolve the way people type them, each
// source's response is read right, crypto comes out in AUD, the feeds run only while someone watches,
// each provider told the watchlist is in the crossings log once a day, and panels can read prices.

import { test } from "node:test";
import assert from "node:assert/strict";

import { signals } from "../center.js";
import { Dashboards } from "../dash/recipes.js";
import { resolveInstrument, STARTING_WATCHLIST } from "../markets/instruments.js";
import { Markets, thin, type MarketEvent, type StreamLike } from "../markets/service.js";
import {
  parseBinance24h, parseBinanceKlines, parseBinanceTick, parseCoinGeckoChart, parseCoinGeckoPrice, parseFrankfurterAud, parseYahooChart,
} from "../markets/sources.js";
import { openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";

const NOW = Date.parse("2026-10-15T01:00:00Z");

function yahoo(price: number, prev: number, opts: { name?: string; currency?: string; closes?: number[]; session?: [number, number] } = {}) {
  const closes = opts.closes ?? [prev, (prev + price) / 2, price];
  const [start, end] = opts.session ?? [NOW - 3600_000, NOW + 3600_000];
  return {
    chart: {
      result: [{
        meta: {
          currency: opts.currency ?? "AUD", regularMarketPrice: price, previousClose: prev, chartPreviousClose: prev, longName: opts.name, shortName: opts.name,
          regularMarketChangePercent: ((price - prev) / prev) * 100, regularMarketTime: NOW / 1000, regularMarketDayHigh: price * 1.01, regularMarketDayLow: price * 0.99,
          fiftyTwoWeekHigh: price * 1.3, fiftyTwoWeekLow: price * 0.7, currentTradingPeriod: { regular: { start: start / 1000, end: end / 1000 } },
        },
        timestamp: closes.map((_, i) => NOW / 1000 - (closes.length - i) * 300),
        indicators: { quote: [{ close: closes }] },
      }],
      error: null,
    },
  };
}
const yahooMissing = { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } };

/** A made-up network: answers by URL, counts every call, and can be told a host is down. */
function network(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const down = new Set<string>();
  const quotes: Record<string, unknown> = {
    "AUDUSD=X": yahoo(0.64, 0.65, { currency: "USD", name: "AUD/USD" }),
    "^AXJO": yahoo(8719.7, 8783.9, { name: "S&P/ASX 200 [XJO]" }),
    "BHP.AX": yahoo(45.1, 44.5, { name: "BHP Group Limited" }),
    "GC=F": yahoo(4100, 4080, { currency: "USD", name: "Gold Dec 26" }),
    ...overrides,
  };
  const fetch = async (url: string) => {
    calls.push(url);
    const host = new URL(url).host;
    if (down.has(host)) throw new Error(`${host} answered 503`);
    const y = /\/v8\/finance\/chart\/([^?]+)\?range=([^&]+)/.exec(url);
    if (y) return quotes[decodeURIComponent(y[1])] ?? yahooMissing;
    if (url.includes("/ticker/24hr")) {
      return [
        { symbol: "BTCUSDT", lastPrice: "80000.00", openPrice: "82000.00", priceChangePercent: "-2.439", highPrice: "83000", lowPrice: "79500", closeTime: NOW },
        { symbol: "ETHUSDT", lastPrice: "2400.00", openPrice: "2300.00", priceChangePercent: "4.348", highPrice: "2450", lowPrice: "2290", closeTime: NOW },
      ];
    }
    if (url.includes("/klines")) return [[NOW - 900_000, "1", "1", "1", "79000", "1", NOW - 1, "1", 1, "1", "1", "0"], [NOW, "1", "1", "1", "80000", "1", NOW, "1", 1, "1", "1", "0"]];
    if (url.includes("/simple/price")) return { bitcoin: { aud: 125000, aud_24h_change: -2.5, last_updated_at: NOW / 1000 }, ethereum: { aud: 3750, aud_24h_change: 4, last_updated_at: NOW / 1000 } };
    if (url.includes("/market_chart")) return { prices: [[NOW - 7200_000, 124000], [NOW - 3600_000, 124500], [NOW, 125000]] };
    if (url.includes("frankfurter")) return { amount: 1, base: "USD", date: "2026-10-14", rates: { AUD: 1.5 } };
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls, down };
}

class FakeStream implements StreamLike {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e?: unknown) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  tick(symbol: string, price: number, open: number) {
    this.onmessage?.({ data: JSON.stringify({ stream: `${symbol.toLowerCase()}@miniTicker`, data: { e: "24hrMiniTicker", E: NOW, s: symbol, c: String(price), o: String(open), h: String(price), l: String(open) } }) });
  }
}

function setup(ids = ["BTC", "ETH", "^AXJO", "BHP.AX"], opts: { stream?: boolean; graceMs?: number; net?: ReturnType<typeof network> } = {}) {
  const money = new Money(openMoneyDb(":memory:"));
  const net = opts.net ?? network();
  const streams: FakeStream[] = [];
  const markets = new Markets(money, {
    fetch: net.fetch, now: () => NOW, pollMs: 3600_000, graceMs: opts.graceMs ?? 3600_000,
    openStream: opts.stream ? (url) => {
      const s = new FakeStream(url);
      streams.push(s);
      return s;
    } : null,
  });
  markets.setWatchlist(ids);
  return { money, markets, net, streams };
}

const crossingsOf = (money: Money) => (money.db.prepare("SELECT subject_id, detail FROM events WHERE kind = 'crossing' ORDER BY id").all() as Array<{ subject_id: string; detail: string }>)
  .map((r) => ({ to: r.subject_id, ...JSON.parse(r.detail) }));

test("symbols resolve the way people type them", () => {
  assert.deepEqual(resolveInstrument("btc"), { id: "BTC", name: "Bitcoin", kind: "crypto", currency: "AUD", market: "Crypto", binance: "BTCUSDT", coingecko: "bitcoin" });
  assert.equal(resolveInstrument("ETH-AUD")?.id, "ETH");
  assert.deepEqual(resolveInstrument("bhp.ax"), { id: "BHP.AX", name: "BHP.AX", kind: "stock", currency: "AUD", market: "ASX", yahoo: "BHP.AX" });
  assert.deepEqual(resolveInstrument("^AXJO"), { id: "^AXJO", name: "S&P/ASX 200", kind: "index", currency: "AUD", market: "ASX", yahoo: "^AXJO" });
  assert.deepEqual(resolveInstrument("AUD/USD"), { id: "AUDUSD", name: "AUD/USD", kind: "fx", currency: "USD", market: "FX", yahoo: "AUDUSD=X" });
  assert.equal(resolveInstrument("GC=F")?.id, "GOLD");
  assert.equal(resolveInstrument("nvda")?.market, "US");
  for (const bad of ["", "hello world!", "DROP TABLE;", "x".repeat(20)]) assert.equal(resolveInstrument(bad), null, bad);
});

test("a new Ogdoad starts with the operator's watchlist, in order", () => {
  const markets = new Markets(new Money(openMoneyDb(":memory:")), { fetch: network().fetch });
  assert.deepEqual(markets.watchlist().map((i) => i.id), STARTING_WATCHLIST);
});

test("each source's response is read right", () => {
  const y = parseYahooChart(yahoo(45.1, 44.5, { name: "BHP Group Limited", closes: [44.5, null as unknown as number, 45.1] }))!;
  assert.equal(y.reading.price, 45.1);
  assert.ok(Math.abs(y.reading.prevClose! - 44.5) < 1e-9);
  // An index whose previousClose is a session stale: the day is measured from Yahoo's own change.
  const stale = yahoo(8719.7, 8783.9);
  stale.chart.result[0].meta.regularMarketChangePercent = -0.094;
  const axjo = parseYahooChart(stale)!.reading;
  assert.equal(axjo.changePct, -0.094);
  assert.ok(Math.abs(axjo.prevClose! - 8727.9) < 0.1);
  assert.equal(y.reading.name, "BHP Group Limited");
  assert.equal(y.points.length, 2, "gaps in the path are skipped");
  assert.deepEqual(y.reading.session, [NOW - 3600_000, NOW + 3600_000]);
  assert.equal(parseYahooChart(yahooMissing), null);

  const t = parseBinanceTick(JSON.stringify({ stream: "btcusdt@miniTicker", data: { e: "24hrMiniTicker", E: 5, s: "BTCUSDT", c: "81000.5", o: "80000", h: "82000", l: "79000" } }))!;
  assert.deepEqual(t, { symbol: "BTCUSDT", price: 81000.5, open: 80000, high: 82000, low: 79000, at: 5 });
  assert.equal(parseBinanceTick("not json"), null);
  assert.equal(parseBinance24h([{ symbol: "ETHUSDT", lastPrice: "2400", openPrice: "2300", priceChangePercent: "4.3" }]).get("ETHUSDT")?.price, 2400);
  assert.deepEqual(parseBinanceKlines([[0, "1", "1", "1", "79000", "1", 99]]), [[99, 79000]]);

  const g = parseCoinGeckoPrice({ bitcoin: { aud: 110, aud_24h_change: 10 } }).get("bitcoin")!;
  assert.equal(g.price, 110);
  assert.ok(Math.abs(g.prevClose! - 100) < 1e-9, "a day ago, worked back from the change");
  assert.deepEqual(parseCoinGeckoChart({ prices: [[1, 2], ["x", 3]] }), [[1, 2]]);
  assert.equal(parseFrankfurterAud({ rates: { AUD: 1.43 } }), 1.43);
  assert.deepEqual(thin([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10]);
});

test("a round fetches each price once: crypto in AUD, shares from Yahoo, the market's session read", async () => {
  const { markets, net } = setup();
  await markets.refresh();
  const q = new Map(markets.snapshot().map((x) => [x.id, x]));
  // 1 USD buys 1/0.64 = 1.5625 AUD.
  assert.equal(q.get("BTC")!.price, 125000);
  assert.equal(q.get("BTC")!.prevClose, 128125);
  assert.equal(q.get("BTC")!.currency, "AUD");
  assert.equal(q.get("BTC")!.source, "binance");
  assert.ok(q.get("BTC")!.spark.length >= 3, "today's path for the sparkline");
  assert.equal(q.get("BHP.AX")!.name, "BHP Group Limited");
  assert.equal(q.get("BHP.AX")!.open, true);
  assert.ok(Math.abs(q.get("^AXJO")!.changePct! - (-0.7311)) < 0.001);
  assert.equal(net.calls.filter((u) => u.includes("/ticker/24hr")).length, 1);
});

test("Binance out of reach: CoinGecko's AUD prices fill in", async () => {
  const net = network();
  net.down.add("api.binance.com");
  const { markets } = setup(["BTC", "ETH"], { net });
  await markets.refresh();
  const btc = markets.snapshot().find((x) => x.id === "BTC")!;
  assert.equal(btc.price, 125000);
  assert.equal(btc.source, "coingecko");
});

test("the feeds run only while someone watches, and the live stream moves prices in AUD", async () => {
  const { markets, net, streams } = setup(["BTC", "BHP.AX"], { stream: true, graceMs: 20 });
  assert.equal(markets.isRunning, false, "nothing runs until someone looks");
  const seen: MarketEvent[] = [];
  const off = markets.subscribe((e) => seen.push(e));
  assert.equal(markets.isRunning, true);
  await markets.refresh();
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /btcusdt@miniTicker/);

  streams[0].tick("BTCUSDT", 81000, 80000);
  const tick = seen.find((e) => e.type === "tick");
  assert.ok(tick && tick.type === "tick");
  assert.equal(tick.price, 81000 * 1.5625);
  assert.equal(tick.changePct, 1.25);
  assert.equal(markets.snapshot().find((x) => x.id === "BTC")!.live, true);

  // While the stream is live, a round doesn't poll Binance for crypto prices.
  const before = net.calls.filter((u) => u.includes("/ticker/24hr")).length;
  await markets.refresh();
  assert.equal(net.calls.filter((u) => u.includes("/ticker/24hr")).length, before);

  off();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(markets.isRunning, false, "stopped a grace period after the last viewer left");
  assert.equal(streams[0].closed, true);
});

test("locking closes the feeds and sends every viewer away", () => {
  const { markets } = setup(["BTC"], { stream: true });
  const seen: MarketEvent[] = [];
  markets.subscribe((e) => seen.push(e));
  markets.close();
  assert.ok(seen.some((e) => e.type === "closed"));
  assert.equal(markets.isRunning, false);
  assert.throws(() => markets.subscribe(() => {}), /locked/);
});

test("each provider told the watchlist is in the crossings log, once a day", async () => {
  const { money, markets } = setup();
  await markets.refresh();
  await markets.refresh();
  const log = crossingsOf(money);
  const byProvider = (to: string) => log.filter((c) => c.to === to);
  assert.equal(byProvider("market:yahoo").length, 1, "one line for Yahoo, not one per request or round");
  assert.match(byProvider("market:yahoo")[0].what, /^prices for AUDUSD, BHP\.AX, \^AXJO \(/, "the AUD rate is said too");
  assert.equal(byProvider("market:coingecko").length, 1, "each coin's history doesn't add a line");
  assert.equal(byProvider("market:binance").length, 1);
  assert.match(byProvider("market:binance")[0].what, /^prices for BTC, ETH \(/);

  // A new symbol is news: one more line, naming only it. And a restarted app remembers what it said today.
  await markets.add("GOLD");
  const again = new Markets(money, { fetch: network().fetch, now: () => NOW });
  await again.refresh();
  const yahooLines = crossingsOf(money).filter((c) => c.to === "market:yahoo");
  assert.equal(yahooLines.length, 2);
  assert.match(yahooLines[1].what, /^prices for GOLD \(/);
  for (const c of log) {
    assert.equal(c.where, "cloud");
    assert.match(c.what, /nothing from the books/);
  }
  // In Signals, a price service is named for what it is, and kept quiet: it got symbols, not the operator's words.
  const line = signals(money).find((s) => s.who === "crossing" && s.text.startsWith("to Binance"));
  assert.ok(line);
  assert.match(line.text, /^to Binance \(market data, a public price service\): prices for BTC, ETH/);
  assert.equal(line.tone, "muted");
});

test("the watchlist: symbols are checked before they're added, and junk is refused", async () => {
  const { money, markets } = setup(["BTC", "BHP.AX"]);
  await assert.rejects(() => markets.add("ZZZZ.AX"), /Yahoo has no prices/);
  await assert.rejects(() => markets.add("not a symbol!"), /isn't a symbol/);
  const added = await markets.add("gold");
  assert.equal(added.id, "GOLD");
  assert.deepEqual(markets.watchlist().map((i) => i.id), ["BTC", "BHP.AX", "GOLD"]);
  assert.equal(markets.snapshot().find((q) => q.id === "GOLD")?.price, 4100, "priced as it's added");

  assert.throws(() => markets.setWatchlist(["BTC", "no;pe"]), /isn't a symbol/);
  await markets.refresh();
  markets.setWatchlist(["GOLD", "BTC", "btc"]);
  assert.deepEqual(markets.watchlist().map((i) => i.id), ["GOLD", "BTC"], "reordered, de-duplicated, BHP.AX gone");
  const kept = money.db.prepare("SELECT id FROM market_quotes ORDER BY id").all() as Array<{ id: string }>;
  assert.ok(!kept.some((r) => r.id === "BHP.AX"), "its last price goes with it");
});

test("history is cached, a year's closes go into the books, and panels can read prices", async () => {
  const { money, markets, net } = setup(["BHP.AX", "BTC"]);
  const year = await markets.history("BHP.AX", "1Y");
  assert.equal(year.source, "yahoo");
  assert.equal(year.points.length, 3);
  const calls = net.calls.length;
  await markets.history("BHP.AX", "1Y");
  assert.equal(net.calls.length, calls, "the second look is cached");
  await assert.rejects(() => markets.history("TSLA", "1D"), /isn't on the watchlist/);

  const btc = await markets.history("BTC", "1M");
  assert.equal(btc.currency, "AUD");
  assert.equal(btc.source, "coingecko");

  await markets.refresh();
  const dash = new Dashboards(money);
  const panel = await dash.preview({ title: "Watchlist", sql: "SELECT symbol, price, change_pct FROM quotes ORDER BY symbol", chart: { type: "table" } });
  assert.ok(panel.ok);
  if (panel.ok) assert.deepEqual(panel.rows.map((r) => r[0]), ["BHP.AX", "BTC"]);
  const closes = await dash.preview({ title: "BHP closes", sql: "SELECT day, close FROM prices WHERE symbol = 'BHP.AX'", chart: { type: "line", x: "day", y: ["close"] } });
  assert.ok(closes.ok && closes.rows.length >= 1);
});
