// What can go on the watchlist, and where each one's price comes from. The operator types a symbol
// the way people write it (BTC, BHP.AX, ^AXJO, AUD/USD, GOLD) and it resolves to an instrument: a
// crypto coin streams live from Binance (CoinGecko fills in if Binance is out of reach); shares,
// indices, currencies and commodities come from Yahoo's public chart data.

export type Kind = "crypto" | "stock" | "index" | "fx" | "commodity";

export interface Instrument {
  /** The symbol as shown: BTC, BHP.AX, ^AXJO, AUDUSD, GOLD. */
  id: string;
  name: string;
  kind: Kind;
  /** What the price is in. Crypto is shown in AUD; the rest in what its market trades in. */
  currency: string;
  /** Where it trades, for grouping: Crypto, ASX, US, FX, Commodities, or the exchange's suffix. */
  market: string;
  binance?: string;
  coingecko?: string;
  yahoo?: string;
}

const CRYPTO: Record<string, [name: string, coingecko: string]> = {
  BTC: ["Bitcoin", "bitcoin"],
  ETH: ["Ethereum", "ethereum"],
  SOL: ["Solana", "solana"],
  XRP: ["XRP", "ripple"],
  BNB: ["BNB", "binancecoin"],
  ADA: ["Cardano", "cardano"],
  DOGE: ["Dogecoin", "dogecoin"],
  AVAX: ["Avalanche", "avalanche-2"],
  DOT: ["Polkadot", "polkadot"],
  LINK: ["Chainlink", "chainlink"],
  LTC: ["Litecoin", "litecoin"],
  TRX: ["TRON", "tron"],
  XLM: ["Stellar", "stellar"],
  ATOM: ["Cosmos", "cosmos"],
  NEAR: ["NEAR Protocol", "near"],
  SUI: ["Sui", "sui"],
  TON: ["Toncoin", "the-open-network"],
  HBAR: ["Hedera", "hedera-hashgraph"],
  PEPE: ["Pepe", "pepe"],
  SHIB: ["Shiba Inu", "shiba-inu"],
};

const COMMODITIES: Record<string, [name: string, yahoo: string]> = {
  GOLD: ["Gold", "GC=F"],
  SILVER: ["Silver", "SI=F"],
  OIL: ["Crude oil", "CL=F"],
  COPPER: ["Copper", "HG=F"],
};

const INDICES: Record<string, [name: string, currency: string, market: string]> = {
  "^AXJO": ["S&P/ASX 200", "AUD", "ASX"],
  "^AORD": ["All Ordinaries", "AUD", "ASX"],
  "^GSPC": ["S&P 500", "USD", "US"],
  "^IXIC": ["NASDAQ Composite", "USD", "US"],
  "^DJI": ["Dow Jones", "USD", "US"],
  "^N225": ["Nikkei 225", "JPY", "Japan"],
  "^FTSE": ["FTSE 100", "GBP", "UK"],
  "^HSI": ["Hang Seng", "HKD", "Hong Kong"],
};

const CURRENCIES = new Set(["AUD", "USD", "EUR", "GBP", "JPY", "NZD", "CAD", "CHF", "CNY", "SGD", "HKD", "INR", "KRW"]);

/** Yahoo's suffixes for the exchanges people here are most likely to use. */
const EXCHANGES: Record<string, [market: string, currency: string]> = {
  AX: ["ASX", "AUD"],
  NZ: ["NZX", "NZD"],
  L: ["London", "GBP"],
  TO: ["Toronto", "CAD"],
  HK: ["Hong Kong", "HKD"],
  T: ["Tokyo", "JPY"],
};

/** A symbol as typed, made into an instrument, or null when it can't be one. */
export function resolveInstrument(input: string): Instrument | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!s || s.length > 16) return null;
  const coin = CRYPTO[s] ?? CRYPTO[s.replace(/-?(AUD|USD|USDT)$/, "")];
  if (coin) {
    const id = CRYPTO[s] ? s : s.replace(/-?(AUD|USD|USDT)$/, "");
    return { id, name: coin[0], kind: "crypto", currency: "AUD", market: "Crypto", binance: `${id}USDT`, coingecko: coin[1] };
  }
  const commodity = COMMODITIES[s] ?? Object.entries(COMMODITIES).find(([, [, y]]) => y === s)?.[1];
  if (commodity) {
    const id = COMMODITIES[s] ? s : Object.entries(COMMODITIES).find(([, [, y]]) => y === s)![0];
    return { id, name: commodity[0], kind: "commodity", currency: "USD", market: "Commodities", yahoo: commodity[1] };
  }
  const fx = /^([A-Z]{3})\/?([A-Z]{3})(=X)?$/.exec(s);
  if (fx && CURRENCIES.has(fx[1]) && CURRENCIES.has(fx[2]) && fx[1] !== fx[2]) {
    return { id: `${fx[1]}${fx[2]}`, name: `${fx[1]}/${fx[2]}`, kind: "fx", currency: fx[2], market: "FX", yahoo: `${fx[1]}${fx[2]}=X` };
  }
  if (/^\^[A-Z0-9.]{1,10}$/.test(s)) {
    const known = INDICES[s];
    return { id: s, name: known?.[0] ?? s, kind: "index", currency: known?.[1] ?? "USD", market: known?.[2] ?? "Index", yahoo: s };
  }
  if (/^[A-Z0-9][A-Z0-9-]{0,9}(\.[A-Z]{1,3})?$/.test(s)) {
    const [, suffix] = s.split(".");
    const ex = suffix ? EXCHANGES[suffix] : undefined;
    return { id: s, name: s, kind: "stock", currency: ex?.[1] ?? (suffix ? "" : "USD"), market: ex?.[0] ?? (suffix ? suffix : "US"), yahoo: s };
  }
  return null;
}

/** The watchlist a new Ogdoad starts with (the operator's picks on 2026-10-15): crypto majors, the ASX, US markets, FX and gold. */
export const STARTING_WATCHLIST = ["BTC", "ETH", "SOL", "^AXJO", "BHP.AX", "CBA.AX", "CSL.AX", "^GSPC", "^IXIC", "NVDA", "AAPL", "MSFT", "AUDUSD", "GOLD"];
