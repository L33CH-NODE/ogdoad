-- The calendar Work syncs with: the operator's own CalDAV calendar (Radicale, Baïkal, Nextcloud on a
-- home box, over the tailnet). Off until the operator sets it up. The password sits in this encrypted
-- database and is never sent back to the UI. Events carry stand-ins and times only, unless the
-- operator chooses to show names.

CREATE TABLE calendar (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  kind TEXT NOT NULL DEFAULT 'none' CHECK (kind IN ('none', 'caldav')),
  -- the calendar collection, e.g. http://homebox:5232/me/shifts/
  url TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  show_names INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO calendar (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- What was last sent for each shift, so only changes go out again.
ALTER TABLE shifts ADD COLUMN calendar_hash TEXT;
