// For your accountant: one financial year, summed up and ready to hand over. The year's invoices and
// payments as CSV, and a one-page summary PDF. Made from the books on this machine.

import { useEffect, useState } from "react";

import { ErrorNote, Loading, useLoad } from "../components/bits";
import { Icon } from "../components/icons";
import { api } from "../lib/api";
import { aud } from "../lib/format";

interface Years { years: string[]; current: string }
interface YearSummary {
  fy: string; from: string; to: string; invoicedCents: number; receivedCents: number; owedAtEndCents: number; invoices: number; voided: number;
  byClient: Array<{ client: string; invoicedCents: number; receivedCents: number }>; hoursWorked: number; shifts: number; gstRegistered: boolean;
}

export function AccountantPage() {
  const years = useLoad<Years>("/ogdoad/money/accountant");
  const [fy, setFy] = useState<string | null>(null);
  const [s, setS] = useState<YearSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The year just finished is what an accountant usually wants; this year is there too.
  const pick = fy ?? years.data?.years[1] ?? years.data?.current ?? null;
  useEffect(() => {
    if (!pick) return;
    setS(null);
    api.get<YearSummary>(`/ogdoad/money/accountant/${pick}/summary`).then(setS, (err) => setError((err as Error).message));
  }, [pick]);

  if (years.error) return <ErrorNote error={years.error} retry={years.reload} />;
  if (!years.data || !pick) return <Loading what="Reading the years" />;
  const base = `/ogdoad/money/accountant/${pick}`;
  const now = pick === years.data.current;
  return (
    <div className="stack" style={{ gap: 16, maxWidth: 820 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>For your accountant</h3>
        <span className="spacer" />
        <label className="sr" htmlFor="fy">Financial year</label>
        <select id="fy" className="input" style={{ width: "auto" }} value={pick} onChange={(e) => setFy(e.target.value)}>
          {years.data.years.map((y) => <option key={y} value={y}>{y.replace("-", "–")}{y === years.data!.current ? " (this year, so far)" : ""}</option>)}
        </select>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        One financial year, 1 July to 30 June: the invoices issued in it, the payments that arrived in it, and a one-page summary. Made from the books on this machine; send them yourself.
      </p>
      {error ? <p className="error-text">{error}</p> : null}
      {s ? (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            {[
              ["Invoiced", aud(s.invoicedCents, { cents: false }), `${s.invoices} invoice${s.invoices === 1 ? "" : "s"}${s.voided ? `, ${s.voided} voided` : ""}`],
              ["Received", aud(s.receivedCents, { cents: false }), "by the date paid"],
              [now ? "Owed now" : "Owed on 30 June", aud(s.owedAtEndCents, { cents: false }), "for that year's invoices"],
              ["Hours worked", `${s.hoursWorked}`, `${s.shifts} shift${s.shifts === 1 ? "" : "s"} in Work`],
            ].map(([k, v, sub]) => (
              <div key={k} className="card stack" style={{ gap: 2 }}>
                <span className="muted" style={{ fontSize: 12.5 }}>{k}</span>
                <strong style={{ fontSize: 22 }}>{v}</strong>
                <span className="muted" style={{ fontSize: 12 }}>{sub}</span>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn primary" href={`${base}/summary.pdf`}><Icon name="file" size={16} /> Summary (PDF)</a>
            <a className="btn" href={`${base}/invoices.csv`}><Icon name="money" size={16} /> Invoices (CSV)</a>
            <a className="btn" href={`${base}/payments.csv`}><Icon name="bank" size={16} /> Payments (CSV)</a>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {s.gstRegistered ? "GST: registered." : "GST: not registered, so no GST was charged. The GST meter on Money keeps an eye on the threshold."} The summary's totals come straight from the CSVs, so your accountant can check one against the other.
          </p>
        </>
      ) : <Loading what="Adding up the year" />}
    </div>
  );
}
