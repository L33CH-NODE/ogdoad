# Money

Ogdoad's own invoicing, replacing the operator's old invoicing site. It's built-in, not a Paperclip plugin. Everything lives in one SQLite file on the operator's machine (`~/.ogdoad/money/money.db`), with issued PDFs beside it. That makes it Tier 0 by design: nothing about clients or money leaves the machine.

## Using it

- Open **http://127.0.0.1:3101** (OGDOAD-START starts it). Money and Clients are in the sidebar.
- **Settings** first: the business name, ABN (checked against the ATO's algorithm as you type), contact details, and the accounts you're paid into.
- **Bring the old site across** from Settings: choose its invoice export and the reconciliation tracker. The summary shows counts only, and numbering continues after the highest imported number.
- After deploying a new build: `npm run build` in `app/`, then `horos restart <the app's id>` (see `horos roster`).

## Where it runs

- **The Ogdoad app server** (`app/`, port 3101) serves the new UI and Ogdoad's own APIs, including `/ogdoad/money/*`. It proxies `/api/*` to the Ogdoad server (3100) and `/horos/*` to Horos, adding Horos's token so the browser never holds it. Horos runs the app server as a server, after the Ogdoad server.
- **SQLite through `node:sqlite`.** No extra database. Dashboard recipes are written in SQLite SQL, so money panels can query the same file directly (read-only).
- **Phase 1 is operator-only.** No agent reaches Money yet. The app server listens on 127.0.0.1 and, like the rest of local-trusted Ogdoad, trusts this machine. Phase 2 adds real sessions and the director key; agents come in phase 4.

## Rules that don't bend

- **"Invoice", never "Tax Invoice"**, and no GST line while the business isn't GST-registered. An ABN is required before an invoice can be issued; without one, payers withhold 47%.
- **Numbers are assigned when an invoice is issued**, continuing the old sequence. A rejected draft leaves no gap.
- **An issued invoice is never edited.** Void it and reissue, or credit it.
- **Paid status comes from money actually received** (payments recorded against the invoice), not a ticked box.
- **No chase without a fresh bank check** on the invoice's account. Re-sending invoices that were already paid is how the old double payments happened.
- **Bank details and the ABN live only in the local database**, never in the repo or logs.
- **Two payment accounts, both open forever.** The personal account stays for existing clients. New clients default to the business account, which only ever holds business transactions.

## Data

| Table | Holds |
|---|---|
| `settings` | Business name, ABN, contact details, numbering (prefix, width, next number), default terms, default account, timezone, footer note, GST registration flag. |
| `payment_accounts` | Label, kind (personal / business), bank, account name, BSB, account number, archived. |
| `clients` | Name, contact, email, phone, address, NDIS participant name and number, terms, pay-to account, notes, source (manual / import / agent), external ref. |
| `invoices` | Client, status (draft, rejected, issued, void), number, issue and due dates, service period, terms, totals in cents, notes, pay-to account, source and external ref, PDF path. |
| `invoice_lines` | Description, quantity, unit price in cents, line total. |
| `payments` | Invoice, amount in cents, date received, account, how it was matched (bank row, import, manual), evidence reference. |
| `events` | Who did what when (created, issued, voided, paid, imported), so every change has a trail. |

Money is held in integer cents throughout.

## Importing the old system

Two local files, read in place and never copied anywhere else:

- **The invoicing site's export** (one row per invoice, no line items): invoice ID and number, client number, invoice and issue dates, payment status, client name, contact and address fields, terms, subtotal, total, total paid, balance due, service dates, and custom NDIS fields.
  - Clients are deduplicated by client number.
  - Each invoice gets a single line, "Imported from the previous invoicing system", carrying its total.
- **The reconciliation tracker** (one row per invoice, built from bank matches): amount, paid, balance, days past due, ageing bucket, match method, evidence, chase history. Its paid amounts take precedence over the export's payment status (the export showed about 90 paid invoices as unpaid). Each paid amount becomes a payment, with the match method kept as evidence.
- **Numbering:** the next number continues after the highest imported one.
- **The import is repeatable.** Each record keeps its external ref, so running it again updates in place instead of duplicating.

## The GST threshold meter

**GST turnover** is the value of supplies made in the current month plus the previous 11 months (and, projected, the current month plus the next 11). GST-free NDIS income still counts. The meter sums invoice totals by supply date (service date, falling back to issue date) over that window. It warns at 75% and alerts at 90% of the $75,000 threshold. ATO rules should be re-checked against ato.gov.au before relying on the exact definition.

## Phases

1. **Core:** schema, settings, payment accounts, clients, draft → issue → void, numbering, PDFs, import of the old system, the GST meter, and the Money screen in the new UI.
2. **Money in:** bank statement import (the bank's CSV has no header row: date, signed amount, description, balance), matching to invoices, ageing, and the daily check.
3. **Chasing:** chase drafts the operator sends, always after a fresh bank check.
4. **Accountant pack and deductions research.**
5. **Documents:** a PDF viewer and a drawn signature.
