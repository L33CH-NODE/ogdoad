-- Money: invoices, clients, payments and the accounts they are paid into. Integer cents throughout.
-- Dates are ISO 'YYYY-MM-DD' text; timestamps are ISO 8601 text in UTC.

CREATE TABLE payment_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'business')),
  bank_name TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL,
  bsb TEXT NOT NULL,
  account_number TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row: the business itself.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT NOT NULL DEFAULT '',
  abn TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  gst_registered INTEGER NOT NULL DEFAULT 0,
  number_prefix TEXT NOT NULL DEFAULT '',
  number_width INTEGER NOT NULL DEFAULT 5 CHECK (number_width BETWEEN 1 AND 12),
  next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number > 0),
  default_terms_days INTEGER NOT NULL DEFAULT 14 CHECK (default_terms_days >= 0),
  default_account_id TEXT REFERENCES payment_accounts(id),
  timezone TEXT NOT NULL DEFAULT 'Australia/Brisbane',
  footer_note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
INSERT INTO settings (id, updated_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  participant_name TEXT NOT NULL DEFAULT '',
  ndis_number TEXT NOT NULL DEFAULT '',
  terms_days INTEGER CHECK (terms_days >= 0),
  pay_to_account_id TEXT REFERENCES payment_accounts(id),
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'import')),
  external_ref TEXT UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'rejected', 'issued', 'void')),
  number TEXT UNIQUE,
  issue_date TEXT,
  due_date TEXT,
  service_from TEXT,
  service_to TEXT,
  terms_days INTEGER NOT NULL CHECK (terms_days >= 0),
  currency TEXT NOT NULL DEFAULT 'AUD',
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes TEXT NOT NULL DEFAULT '',
  -- NDIS: one plan-manager client can be invoiced for several participants, so these sit on the
  -- invoice; empty means "use the client's".
  participant_name TEXT NOT NULL DEFAULT '',
  ndis_number TEXT NOT NULL DEFAULT '',
  pay_to_account_id TEXT REFERENCES payment_accounts(id),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'agent', 'import')),
  external_ref TEXT UNIQUE,
  pdf_path TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Issued and void invoices carry their number and dates; drafts don't have them yet.
  CHECK (status NOT IN ('issued', 'void') OR (number IS NOT NULL AND issue_date IS NOT NULL AND due_date IS NOT NULL))
);
CREATE INDEX invoices_client ON invoices(client_id);
CREATE INDEX invoices_status ON invoices(status);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cents INTEGER NOT NULL CHECK (unit_cents >= 0),
  line_cents INTEGER NOT NULL CHECK (line_cents >= 0),
  service_date TEXT
);
CREATE INDEX invoice_lines_invoice ON invoice_lines(invoice_id, position);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on TEXT,
  account_id TEXT REFERENCES payment_accounts(id),
  matched_by TEXT NOT NULL CHECK (matched_by IN ('bank', 'import', 'manual')),
  evidence TEXT NOT NULL DEFAULT '',
  external_ref TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX payments_invoice ON payments(invoice_id);

-- The trail: who did what, when.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX events_subject ON events(subject_id);
