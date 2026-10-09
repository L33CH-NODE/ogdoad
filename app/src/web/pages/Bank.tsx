// Bank: bring in a statement, let sure matches record themselves, and decide the rest.

import { useState } from "react";

import { ErrorNote, Loading, useLoad } from "../components/bits";
import { useEffect } from "react";
import { api, getAppInfo, type Account } from "../lib/api";
import { aud, shortDate } from "../lib/format";
import { linkProps } from "../lib/router";

interface ReviewLine {
  id: string;
  accountLabel: string;
  postedOn: string;
  amountCents: number;
  description: string;
  status: "suggested" | "unmatched";
  reason: string;
  flag: string;
  groups: Array<Array<{ id: string; number: string | null; clientName: string; balanceCents: number; totalCents: number }>>;
}

interface ImportSummary {
  account: string; lines: number; credits: number; debitsSkipped: number; unreadable: number; alreadyImported: number;
  matched: number; alreadyRecorded: number; suggested: number; paidTwice: number; unmatched: number; personalDropped: number;
}

export function BankPage() {
  const accounts = useLoad<Account[]>("/ogdoad/money/accounts");
  const review = useLoad<ReviewLine[]>("/ogdoad/money/bank/review");
  const [accountId, setAccountId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [practice, setPractice] = useState(false);
  useEffect(() => void getAppInfo().then((i) => setPractice(i.practice)), []);

  if (accounts.error) return <ErrorNote error={accounts.error} retry={accounts.reload} />;
  if (!accounts.data || !review.data) return <Loading what="Loading the bank" />;
  const chosen = accountId || accounts.data[0]?.id || "";
  const chosenAccount = accounts.data.find((a) => a.id === chosen);

  const run = async () => {
    if (!file || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post<ImportSummary>("/ogdoad/money/bank/import", { accountId: chosen, csv: await file.text() }));
      review.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (path: string, body: unknown = {}) => {
    setError(null);
    try {
      await api.post(path, body);
      review.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <header className="page-head">
        <div><h1>Bank</h1><p>Paid status comes from money actually received. Bring in a statement and the books catch up.</p></div>
      </header>

      <section className="card stack">
        <h3>Bring in a statement</h3>
        {!accounts.data.length ? (
          <div className="notice"><span style={{ flex: 1 }}>Add the accounts you're paid into first.</span><a className="btn small" {...linkProps("/settings")}>Settings</a></div>
        ) : (
          <>
            <div className="form-grid">
              <label className="field">From account
                <select className="input" value={chosen} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.data.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.kind})</option>)}
                </select>
              </label>
              <label className="field">The bank's CSV export<input className="input" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {chosenAccount?.kind === "personal"
                ? "Personal account: only lines that pay one of your invoices are kept. Everything else in the statement is ignored and never stored."
                : "Business account: every credit is kept, so income nothing explains shows up here for you to look at."}
            </p>
            <div className="row">
              <button className="btn primary" disabled={!file || busy} onClick={() => void run()}>{busy ? "Reading…" : "Bring it in"}</button>
              {practice ? <a className="btn" href="/ogdoad/practice/statement.csv" download>Download a practice statement</a> : null}
            </div>
          </>
        )}
        {error ? <ErrorNote error={error} /> : null}
        {result ? (
          <div className="notice enter" role="status">
            <div className="stack" style={{ gap: 4 }}>
              <strong>{result.account}: {result.credits} payments in.</strong>
              <span>{result.matched} matched and recorded; {result.alreadyRecorded} were already on the books; {result.suggested} to confirm below.</span>
              {result.paidTwice ? <span style={{ color: "var(--bad)" }}>{result.paidTwice} look like a second payment of an invoice that was already paid.</span> : null}
              {result.unmatched ? <span>{result.unmatched} business credits nothing explains yet.</span> : null}
              <span className="muted">{result.personalDropped ? `${result.personalDropped} personal lines ignored and not stored. ` : ""}{result.debitsSkipped} payments out skipped.{result.alreadyImported ? ` ${result.alreadyImported} were already brought in before.` : ""}</span>
            </div>
          </div>
        ) : null}
      </section>

      <section className="card stack" aria-label="To confirm">
        <h3>To confirm</h3>
        {review.data.length ? review.data.map((l) => (
          <div key={l.id} className={`notice ${l.flag === "paid_twice" ? "bad" : ""}`} style={{ flexDirection: "column", alignItems: "stretch" }}>
            <div className="row">
              <strong>{aud(l.amountCents)}</strong>
              <span className="muted">{shortDate(l.postedOn)} · {l.accountLabel}</span>
              <span className="spacer" />
              <button className="btn small" onClick={() => void act(`/ogdoad/money/bank/lines/${l.id}/ignore`)}>Not an invoice payment</button>
            </div>
            <div className="mono muted" style={{ fontSize: 12 }}>{l.description}</div>
            {l.reason ? <div style={{ fontSize: 13 }}>{l.reason.charAt(0).toUpperCase() + l.reason.slice(1)}.</div> : null}
            {l.flag !== "paid_twice" ? l.groups.map((g, i) => (
              <div key={i} className="row" style={{ borderTop: "1px solid var(--edge)", paddingTop: 8 }}>
                <span style={{ flex: 1 }}>
                  {g.map((inv) => <span key={inv.id} style={{ marginRight: 12 }}><a className="mono" {...linkProps(`/money/invoices/${inv.id}`)}>{inv.number}</a> {inv.clientName} <span className="muted">owes {aud(inv.balanceCents)}</span></span>)}
                </span>
                <button className="btn small primary" onClick={() => void act(`/ogdoad/money/bank/lines/${l.id}/confirm`, { invoiceIds: g.map((x) => x.id) })}>{g.length > 1 ? "It pays these" : "It pays this"}</button>
              </div>
            )) : null}
          </div>
        )) : <span className="muted">Nothing to confirm.</span>}
      </section>
    </>
  );
}
