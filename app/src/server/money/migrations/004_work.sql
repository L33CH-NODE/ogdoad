-- Work: shifts and shift notes, in the same encrypted database as Money, so a completed shift can
-- become an invoice line without leaving it. Shift notes are health and personal records: Tier 0,
-- local only, never sent to a cloud model.
--
-- Times are the business's own wall clock (settings.timezone): a day plus a start and an end. An end
-- at or before the start means the shift runs past midnight (a sleepover, say).

CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  -- empty means the client's own participant
  participant_name TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  -- the kind of support, as it reads on the invoice line
  support TEXT NOT NULL DEFAULT '',
  rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
  km REAL NOT NULL DEFAULT 0 CHECK (km >= 0),
  km_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (km_rate_cents >= 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'cancelled')),
  -- the draft or invoice it was billed on; a rejected draft or a void invoice frees it again
  invoice_id TEXT REFERENCES invoices(id),
  -- several shifts made at once ("every Tuesday for six weeks") share a series
  series_id TEXT,
  -- for the calendar sync: the event's identity there, and its last-known version
  calendar_uid TEXT UNIQUE,
  calendar_etag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX shifts_day ON shifts(day);
CREATE INDEX shifts_client ON shifts(client_id, day);
CREATE INDEX shifts_invoice ON shifts(invoice_id);

CREATE TABLE shift_notes (
  shift_id TEXT PRIMARY KEY REFERENCES shifts(id) ON DELETE CASCADE,
  -- what happened, and the supports given
  body TEXT NOT NULL DEFAULT '',
  -- goals worked on
  goals TEXT NOT NULL DEFAULT '',
  -- anything to follow up
  follow_up TEXT NOT NULL DEFAULT '',
  incident INTEGER NOT NULL DEFAULT 0,
  incident_detail TEXT NOT NULL DEFAULT '',
  -- when the operator says the incident was reported (the rules on how fast are the regulator's)
  incident_reported_at TEXT,
  -- a draft note can still be finished; a final one is what lets the shift be billed
  final INTEGER NOT NULL DEFAULT 0,
  -- who wrote it: 'you', or a local seat's draft the operator finished
  written_by TEXT NOT NULL DEFAULT 'you',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
