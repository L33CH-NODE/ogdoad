-- The watch: what the hires ask permission for, read off their screens, sorted by risk and answered by
-- the operator (or by their policy, for what's plainly safe, once they've turned that on). Each answer
-- is a labelled example for a local decider to learn from later.

CREATE TABLE watch_asks (
  id TEXT PRIMARY KEY,
  hire_id TEXT NOT NULL,
  -- the prompt as read: the same prompt on the same hire's screen is the same ask while it waits
  fingerprint TEXT NOT NULL,
  hire_label TEXT NOT NULL,
  harness TEXT NOT NULL,
  -- cloud, local, either or unknown
  place TEXT NOT NULL,
  title TEXT,
  action TEXT NOT NULL,
  question TEXT NOT NULL,
  -- JSON: the answers the prompt offers, what each presses
  choices TEXT NOT NULL,
  -- JSON: the kinds of risk, and why
  risk TEXT NOT NULL,
  -- JSON: what the operator's policy would do, and why
  verdict TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'gone')),
  -- allow, always or deny
  answer TEXT,
  -- you, or policy
  answered_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX watch_asks_state ON watch_asks(state, created_at);
CREATE INDEX watch_asks_hire ON watch_asks(hire_id, fingerprint);

-- One row: whether the watch may answer what the operator's policy allows (off until they say so).
CREATE TABLE watch_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  auto INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT INTO watch_settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
