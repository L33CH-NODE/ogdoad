// Clients: who you invoice, what they owe, and where they pay.

import { useState } from "react";

import { ErrorNote, Loading, StatusChip, useLoad } from "../components/bits";
import { Icon } from "../components/icons";
import { api, type Account, type Client, type InvoiceSummary } from "../lib/api";
import { aud, shortDate } from "../lib/format";
import { linkProps, navigate } from "../lib/router";

export function ClientsPage() {
  const clients = useLoad<Client[]>("/ogdoad/money/clients");
  const invoices = useLoad<InvoiceSummary[]>("/ogdoad/money/invoices");
  const [adding, setAdding] = useState(false);
  if (clients.error) return <ErrorNote error={clients.error} retry={clients.reload} />;
  if (!clients.data) return <Loading what="Loading clients" />;
  const owing = new Map<string, number>();
  for (const i of invoices.data ?? []) owing.set(i.clientId, (owing.get(i.clientId) ?? 0) + i.balanceCents);
  return (
    <>
      <header className="page-head">
        <div><h1>Clients</h1><p>{clients.data.length} client{clients.data.length === 1 ? "" : "s"}.</p></div>
        <button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" /> Add a client</button>
      </header>
      {adding ? <ClientForm onDone={(c) => { setAdding(false); if (c) navigate(`/money/clients/${c.id}`); }} /> : null}
      <section className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Contact</th><th>NDIS participant</th><th className="num">Owing</th></tr></thead>
            <tbody>
              {clients.data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/money/clients/${c.id}`)}>
                  <td><a {...linkProps(`/money/clients/${c.id}`)} onClick={(e) => e.stopPropagation()}><strong>{c.name}</strong></a></td>
                  <td className="muted">{[c.contactName, c.email].filter(Boolean).join(" · ")}</td>
                  <td>{c.participantName}</td>
                  <td className="num">{owing.get(c.id) ? aud(owing.get(c.id)!) : ""}</td>
                </tr>
              ))}
              {!clients.data.length ? <tr><td colSpan={4} className="muted">No clients yet. Add one, or import your old invoicing site in Settings.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function ClientPage({ id }: { id: string }) {
  const client = useLoad<Client & { invoices: InvoiceSummary[] }>(`/ogdoad/money/clients/${id}`);
  if (client.error) return <ErrorNote error={client.error} retry={client.reload} />;
  if (!client.data) return <Loading what="Loading the client" />;
  const c = client.data;
  return (
    <>
      <header className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <a className="btn small" {...linkProps("/money/clients")}><Icon name="back" size={16} /> Clients</a>
          <h1>{c.name}</h1>
        </div>
      </header>
      <ClientForm client={c} onDone={() => client.reload()} />
      <section className="card stack">
        <h3>Invoices</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Number</th><th>Issued</th><th className="num">Total</th><th className="num">Owing</th><th>Status</th></tr></thead>
            <tbody>
              {c.invoices.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => navigate(`/money/invoices/${i.id}`)}>
                  <td className="mono">{i.number ?? "Draft"}</td><td>{shortDate(i.issueDate)}</td><td className="num">{aud(i.totalCents)}</td>
                  <td className="num">{i.balanceCents ? aud(i.balanceCents) : ""}</td><td><StatusChip bucket={i.bucket} /></td>
                </tr>
              ))}
              {!c.invoices.length ? <tr><td colSpan={5} className="muted">No invoices yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ClientForm({ client, onDone }: { client?: Client; onDone: (c: Client | null) => void }) {
  const accounts = useLoad<Account[]>("/ogdoad/money/accounts");
  const [f, setF] = useState({
    name: client?.name ?? "", contactName: client?.contactName ?? "", email: client?.email ?? "", phone: client?.phone ?? "", address: client?.address ?? "",
    participantName: client?.participantName ?? "", ndisNumber: client?.ndisNumber ?? "", termsDays: client?.termsDays?.toString() ?? "", payToAccountId: client?.payToAccountId ?? "", notes: client?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const field = (k: keyof typeof f, label: string, opts: { type?: string; mono?: boolean } = {}) => (
    <label className="field">{label}<input className={`input${opts.mono ? " mono" : ""}`} type={opts.type ?? "text"} value={f[k]} onChange={(e) => { setF({ ...f, [k]: e.target.value }); setSaved(false); }} /></label>
  );
  const save = async () => {
    setError(null);
    const body = { ...f, termsDays: f.termsDays === "" ? null : Number(f.termsDays), payToAccountId: f.payToAccountId || null };
    try {
      const out = client ? await api.put<Client>(`/ogdoad/money/clients/${client.id}`, body) : await api.post<Client>("/ogdoad/money/clients", body);
      setSaved(true);
      onDone(out);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="card stack enter" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {!client ? <h3>New client</h3> : null}
      <div className="form-grid">
        {field("name", "Name")}
        {field("contactName", "Contact person")}
        {field("email", "Email", { type: "email" })}
        {field("phone", "Phone")}
        {field("participantName", "NDIS participant")}
        {field("ndisNumber", "NDIS number", { mono: true })}
        {field("termsDays", "Payment terms (days)", { type: "number" })}
        <label className="field">Paid into
          <select className="input" value={f.payToAccountId} onChange={(e) => setF({ ...f, payToAccountId: e.target.value })}>
            <option value="">The default account</option>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.kind})</option>)}
          </select>
        </label>
      </div>
      <label className="field">Address<textarea className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
      {error ? <ErrorNote error={error} /> : null}
      <div className="row">
        <button className="btn primary" type="submit">{client ? "Save changes" : "Add client"}</button>
        {!client ? <button className="btn" type="button" onClick={() => onDone(null)}>Cancel</button> : null}
        {saved ? <span className="muted" role="status">Saved.</span> : null}
      </div>
    </form>
  );
}
