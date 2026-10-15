-- Markets: the operator's watchlist, the last price seen for each, and daily closes, so a panel can put
-- prices next to the books. Prices are public; the watchlist is the operator's own, and it stays here.

CREATE TABLE market_watchlist (
  -- the symbol as shown: BTC, BHP.AX, ^AXJO, AUDUSD, GOLD
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL
);

CREATE TABLE market_quotes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  market TEXT NOT NULL,
  currency TEXT NOT NULL,
  price REAL NOT NULL,
  prev_close REAL,
  change_pct REAL,
  source TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE market_daily (
  id TEXT NOT NULL,
  day TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (id, day)
);

-- The starting watchlist (kept in step with STARTING_WATCHLIST in server/markets/instruments.ts).
INSERT INTO market_watchlist (id, position, added_at) VALUES
  ('BTC', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('ETH', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('SOL', 2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('^AXJO', 3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('BHP.AX', 4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('CBA.AX', 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('CSL.AX', 6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('^GSPC', 7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('^IXIC', 8, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('NVDA', 9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('AAPL', 10, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('MSFT', 11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('AUDUSD', 12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ('GOLD', 13, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
