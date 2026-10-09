// Settings: the business on its invoices, the accounts it's paid into, and bringing the old
// invoicing site's history across.

import { useEffect, useState } from "react";

import { ErrorNote, Loading, useLoad } from "../components/bits";
import { api, type Account, type Settings } from "../lib/api";

/** The ATO's ABN check, so a typo shows before saving. */
function abnLooksValid(abn: string): boolean {
  const d = abn.replace(/\s+/g, "");
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  return [...d].reduce((s, ch, i) => s + (Number(ch) - (i === 0 ? 1 : 0)) * w[i], 0) % 89 === 0;
}

export function SettingsPage() {
  const settings = useLoad<Settings>("/ogdoad/money/settings");
  const accounts = useLoad<Account[]>("/ogdoad/money/accounts");
  if (settings.error) return <ErrorNote error={settings.error} retry={settings.reload} />;
  if (!settings.data || !accounts.data) return <Loading what="Loading settings" />;
  return (
    <>
      <header className="page-head"><div><h1>Settings</h1><p>What your invoices say about you, and where you're paid. Kept on this machine only.</p></div></header>
      <BusinessForm settings={settings.data} accounts={accounts.data} onSaved={settings.reload} />
      <Accounts accounts={accounts.data} reload={accounts.reload} />
      <ImportOld />
    </>
  );
}

function BusinessForm({ settings, accounts, onSaved }: { settings: Settings; accounts: Account[]; onSaved: () => void }) {
  const [f, setF] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setF(settings), [settings]);
  const set = (patch: Partial<Settings>) => (setF({ ...f, ...patch }), setSaved(false));
  const abnOk = !f.abn || abnLooksValid(f.abn);
  const save = async () => {
    setError(null);
    try {
      await api.put("/ogdoad/money/settings", f);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3>Your business</h3>
      <div className="form-grid">
        <label className="field">Business name<input className="input" value={f.businessName} onChange={(e) => set({ businessName: e.target.value })} /></label>
        <label className="field">ABN<input className="input mono" value={f.abn} onChange={(e) => set({ abn: e.target.value })} aria-invalid={!abnOk} />
          {!abnOk ? <span className="error-text">That ABN doesn't pass the ATO check.</span> : null}
        </label>
        <label className="field">Email on invoices<input className="input" type="email" value={f.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} /></label>
        <label className="field">Phone on invoices<input className="input" value={f.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} /></label>
        <label className="field">Payment terms (days)<input className="input" type="number" min={0} value={f.defaultTermsDays} onChange={(e) => set({ defaultTermsDays: Number(e.target.value) })} /></label>
        <label className="field">Next invoice number<input className="input mono" type="number" min={1} value={f.nextNumber} onChange={(e) => set({ nextNumber: Number(e.target.value) })} /></label>
        <label className="field">Default account
          <select className="input" value={f.defaultAccountId ?? ""} onChange={(e) => set({ defaultAccountId: e.target.value || null })}>
            <option value="">None</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.kind})</option>)}
          </select>
        </label>
      </div>
      <label className="field">Address on invoices<textarea className="input" value={f.address} onChange={(e) => set({ address: e.target.value })} /></label>
      <label className="field">Note at the bottom of every invoice<textarea className="input" value={f.footerNote} onChange={(e) => set({ footerNote: e.target.value })} /></label>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>You're not registered for GST, so invoices say "Invoice" (never "Tax Invoice") and charge no GST. The meter on Money tells you when that needs to change.</p>
      {error ? <ErrorNote error={error} /> : null}
      <div className="row"><button className="btn primary" type="submit" disabled={!abnOk}>Save</button>{saved ? <span className="muted" role="status">Saved.</span> : null}</div>
    </form>
  );
}

function Accounts({ accounts, reload }: { accounts: Account[]; reload: () => void }) {
  const [f, setF] = useState({ label: "", kind: "business" as Account["kind"], bankName: "", accountName: "", bsb: "", accountNumber: "" });
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      await api.post("/ogdoad/money/accounts", f);
      setF({ label: "", kind: "business", bankName: "", accountName: "", bsb: "", accountNumber: "" });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <section className="card stack">
      <h3>Where you're paid</h3>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>Existing clients keep paying into your personal account. New clients go to the business account, which only ever holds business money.</p>
      {accounts.map((a) => (
        <div key={a.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--faint)", paddingBottom: 8 }}>
          <span><strong>{a.label}</strong> <span className="chip">{a.kind}</span></span>
          <span className="mono muted">{a.bankName} · BSB {a.bsb.replace(/(\d{3})(\d{3})/, "$1-$2")} · {a.accountNumber}</span>
        </div>
      ))}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <div className="form-grid">
          <label className="field">Label<input className="input" value={f.label} placeholder="Business" onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label className="field">Kind
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Account["kind"] })}><option value="business">Business</option><option value="personal">Personal</option></select>
          </label>
          <label className="field">Bank<input className="input" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} /></label>
          <label className="field">Account name<input className="input" value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} /></label>
          <label className="field">BSB<input className="input mono" value={f.bsb} inputMode="numeric" onChange={(e) => setF({ ...f, bsb: e.target.value })} /></label>
          <label className="field">Account number<input className="input mono" value={f.accountNumber} inputMode="numeric" onChange={(e) => setF({ ...f, accountNumber: e.target.value })} /></label>
        </div>
        {error ? <ErrorNote error={error} /> : null}
        <div><button className="btn" type="submit">Add account</button></div>
      </form>
    </section>
  );
}

interface ImportSummary {
  clients: { created: number; updated: number };
  invoices: { created: number; updated: number; drafts: number };
  payments: { created: number; updated: number; fromTracker: number; fromExport: number };
  numbers: { lowest: string | null; highest: string | null; nextNumber: number };
  warnings: string[];
}

function ImportOld() {
  const [invoicesFile, setInvoicesFile] = useState<File | null>(null);
  const [trackerFile, setTrackerFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    if (!invoicesFile) return;
    setBusy(true);
    setError(null);
    try {
      // Read in the browser and sent to the app server on this machine; nothing goes anywhere else.
      const body = { invoicesCsv: await invoicesFile.text(), trackerCsv: trackerFile ? await trackerFile.text() : undefined };
      setResult(await api.post<ImportSummary>("/ogdoad/money/import", body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack">
      <h3>Bring your old invoicing site across</h3>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        Choose its invoice export (a CSV), and, if you have it, the reconciliation tracker built from your bank matches. The tracker's paid amounts win.
        Running it again updates instead of duplicating. The files are read on this machine and never leave it.
      </p>
      <div className="form-grid">
        <label className="field">Invoice export (CSV)<input className="input" type="file" accept=".csv,text/csv" onChange={(e) => setInvoicesFile(e.target.files?.[0] ?? null)} /></label>
        <label className="field">Reconciliation tracker (optional CSV)<input className="input" type="file" accept=".csv,text/csv" onChange={(e) => setTrackerFile(e.target.files?.[0] ?? null)} /></label>
      </div>
      {error ? <ErrorNote error={error} /> : null}
      <div><button className="btn primary" disabled={!invoicesFile || busy} onClick={() => void run()}>{busy ? "Importing…" : "Import"}</button></div>
      {result ? (
        <div className="notice enter" role="status">
          <div className="stack" style={{ gap: 4 }}>
            <strong>Imported.</strong>
            <span>{result.invoices.created} new and {result.invoices.updated} updated invoices; {result.clients.created} new and {result.clients.updated} updated clients.</span>
            <span>{result.payments.fromTracker} payments from the tracker, {result.payments.fromExport} from the export.</span>
            {result.numbers.highest ? <span>Numbers {result.numbers.lowest} to {result.numbers.highest}; the next invoice will be number {result.numbers.nextNumber}.</span> : null}
            {result.warnings.map((w, i) => <span key={i} style={{ color: "var(--warn)" }}>{w}</span>)}
          </div>
        </div>
      ) : null}
    </section>
  );
}
