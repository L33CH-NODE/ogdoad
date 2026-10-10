-- The membrane: what leaves for the team carries stand-ins, never real identities. The map from each
-- stand-in back to what it stands for lives here, in the encrypted books, and nowhere else: never in
-- the engine's database, never in a message.

CREATE TABLE standins (
  -- C-4821, EMAIL-2210, ...: what the team sees
  token TEXT PRIMARY KEY,
  -- who (a client, participant or contact), me (the business itself), email, phone, address, abn,
  -- ndis, bank, tfn, medicare, card, dob
  kind TEXT NOT NULL,
  -- what it stands for, as it reads
  real TEXT NOT NULL,
  -- the same, normalised for lookup (lower case, digits only for numbers)
  norm TEXT NOT NULL,
  -- 'books' when it came from Money or Work, 'pattern' when a pattern found it
  source TEXT NOT NULL,
  -- the client it belongs to, when known
  ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (kind, norm)
);

-- Held on the way out: a message or a brief that needs the operator's look before it leaves. The text
-- is what the operator wrote (real details and all), so it stays here, encrypted, until it's sent with
-- stand-ins, kept local, or dropped.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  -- say (a message on a task or in a room), open (a new room's brief), part (a new part's brief),
  -- prompt (typed into a hire's terminal), hire (a new hire's first message)
  kind TEXT NOT NULL CHECK (kind IN ('say', 'open', 'part', 'prompt', 'hire')),
  -- the room (engine project) it's for, when it's for a room; null for one not opened yet
  project_id TEXT,
  -- what the route was asked: the operator's own words and where they go, as JSON
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'held' CHECK (state IN ('held', 'sent', 'kept', 'dropped')),
  -- once sent: the engine's id for what was made (a comment's task, a project, a part)
  result_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX outbox_state ON outbox(state);

-- Kept local: said in a room for the operator's own eyes. Never posted to the engine.
CREATE TABLE room_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  part_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX room_notes_project ON room_notes(project_id, created_at);
