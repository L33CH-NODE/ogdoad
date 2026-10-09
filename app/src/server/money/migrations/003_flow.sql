-- Flow: the operator's work as one ranked stream, kept in the same encrypted database as Money.
-- Two kinds of task live here: the operator's own (no key), and work the rest of Ogdoad raises (a
-- draft to issue, a late invoice to chase, bank lines to confirm), keyed by what they're about so
-- they update in place and close themselves once that thing is dealt with.

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('you', 'money', 'bank', 'work', 'team')),
  ref TEXT,
  cents INTEGER,
  due_on TEXT,
  -- 0 calm, 1 soon, 2 pressing, 3 an alarm
  urgency INTEGER NOT NULL DEFAULT 1 CHECK (urgency BETWEEN 0 AND 3),
  -- 1 when other work waits on this (chasing waits on the bank being confirmed, say)
  blocking INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'parked', 'done', 'dropped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  skipped_at TEXT,
  -- the operator pulled it to Now
  focus_at TEXT,
  closed_at TEXT,
  -- 'you', or 'cleared' when what it was about was dealt with some other way
  closed_by TEXT
);

CREATE INDEX tasks_state ON tasks(state);
