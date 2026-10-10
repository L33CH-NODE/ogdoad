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

## Money in: bank statements

The bank's CSV export (no header row: date, signed amount, description, balance) is brought in from the Bank page. For each credit, in order:

1. **Already on the books?** The same amount was recorded within three days (by the import, say). If so, it's linked, not recorded twice.
2. **Names an invoice number:** recorded.
3. **Exactly one open invoice for that amount, and the payer's name shows:** recorded.
4. **Otherwise it's only a suggestion.** That covers an amount match without the payer's name, several invoices for that amount, or several of one payer's invoices that add up to it (a batch payment). The operator confirms which invoice it pays, or marks it "not an invoice payment".
5. **The full amount of an invoice that's already paid, from the same payer:** flagged as a likely second payment, on Money and on Home.

Personal-account lines that pay no invoice are dropped and never stored. Business-account credits are all kept, so unexplained income shows up for review. Payments out are skipped for now; the accountant pack will read business expenses later. Importing the same statement again changes nothing.

## The GST threshold meter

**GST turnover** is the value of supplies made in the current month plus the previous 11 months (and, projected, the current month plus the next 11). GST-free NDIS income still counts. The meter sums invoice totals by supply date (service date, falling back to issue date) over that window. It warns at 75% and alerts at 90% of the $75,000 threshold. ATO rules should be re-checked against ato.gov.au before relying on the exact definition.

## Backups, and getting the books back

- **What's kept.** Every hour while Ogdoad is open, `~/.ogdoad/money/backups/` gets `money-<time>.db` (the books, still encrypted with the operator's key) and `vault-<time>.json` (the vault's wrapped keys). A copy is useless without its keys: the data key is random, and only the vault file holds it, wrapped by the password and by the recovery phrase. The last day's copies are all kept, then the newest of each day for a month.
- **Keep one off the machine.** These copies live on the same disk as the books. Copy the backups folder to a USB stick or the home box now and then. The files are encrypted, so a stolen stick gives nothing away without the password or phrase.
- **Getting them back:**
  1. Stop Ogdoad (OGDOAD-STOP).
  2. In `~/.ogdoad/money/`, move `money.db` (and any `money.db-wal`, `money.db-shm`) aside.
  3. Copy the chosen `money-<time>.db` in as `money.db`.
  4. If the vault file is lost or damaged too, copy `vault-<time>.json` in as `~/.ogdoad/vault/vault.json`. Keys from the same time match that copy; a later vault file works too, unless the vault was made again from scratch.
  5. Start Ogdoad and unlock with the password, or recover with the phrase.
- **The first key.** When the vault is first made, books kept before it are encrypted in place. A safety copy is kept until the encrypted file is proven (it opens with the key and every table has the same rows), and the books are put back untouched if it isn't.

## Phases

1. **Core:** schema, settings, payment accounts, clients, draft → issue → void, numbering, PDFs, import of the old system, the GST meter, and the Money screen in the new UI.
2. **Money in:** bank statement import (the bank's CSV has no header row: date, signed amount, description, balance), matching to invoices, ageing, and the daily check.
3. **Chasing:** chase drafts the operator sends, always after a fresh bank check. (Built 2026-10-10: "Draft a reminder" on a late invoice, and from Flow. The tone goes gentle, firm, then final with how late it is, with the pay-to details and the invoice number as the reference. The draft can be copied or opened in the mail app; Ogdoad never sends it. Once the operator says it's gone, Flow rests that invoice for a week.)
4. **Accountant pack and deductions research.** (The pack is built 2026-10-10, as "For your accountant" in the Money room: one financial year's invoices and payments as CSV, and a one-page summary PDF. Deductions research comes with the agents, after the doors are locked.)
5. **Documents:** a PDF viewer and a drawn signature.
