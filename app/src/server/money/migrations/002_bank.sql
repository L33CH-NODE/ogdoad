-- Money in: bank statement lines that matter to the books. From the personal account, only lines that
-- pay an invoice are kept (personal spending never enters this database); from the business account,
-- every credit is kept so unexplained business income shows up for review.

CREATE TABLE bank_lines (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES payment_accounts(id),
  posted_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL,
  -- account + date + amount + description + running balance: importing the same statement again skips it.
  fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('matched', 'suggested', 'unmatched', 'ignored')),
  -- JSON: candidate invoice groups for a suggestion, e.g. [["id1"], ["id2", "id3"]]
  candidates TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  -- 'paid_twice': this credit looks like a second payment of an invoice that was already paid.
  flag TEXT NOT NULL DEFAULT '',
  imported_at TEXT NOT NULL
);
CREATE INDEX bank_lines_status ON bank_lines(status);

-- Which payments a bank line accounts for (one credit can pay several invoices).
CREATE TABLE bank_line_payments (
  bank_line_id TEXT NOT NULL REFERENCES bank_lines(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  PRIMARY KEY (bank_line_id, payment_id)
);
