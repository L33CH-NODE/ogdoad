// One invoice. A draft is edited here and issued from here; once issued it never changes (payments
// are recorded against it, or it's voided with a reason).

import { useEffect, useMemo, useState } from "react";

import { ErrorNote, Loading, StatusChip, useLoad } from "../components/bits";
import { Icon } from "../components/icons";
import { api, type Client, type Invoice, type InvoiceLine } from "../lib/api";
import { aud, parseAud, shortDate } from "../lib/format";
import { linkProps, navigate } from "../lib/router";

interface LineDraft { description: string; quantity: string; unit: string; serviceDate: string }

const emptyLine = (): LineDraft => ({ description: "", quantity: "1", unit: "", serviceDate: "" });
const toDraftLine = (l: InvoiceLine): LineDraft => ({ description: l.description, quantity: String(l.quantity), unit: (l.unitCents / 100).toFixed(2), serviceDate: l.serviceDate ?? "" });

export function InvoicePage({ id }: { id: string }) {
  const isNew = id === "new";
  const inv = useLoad<Invoice>(isNew ? null : `/ogdoad/money/invoices/${id}`);
  if (!isNew && inv.error) return <ErrorNote error={inv.error} retry={inv.reload} />;
  if (!isNew && !inv.data) return <Loading what="Loading the invoice" />;
  const data = inv.data;
  if (data && data.status !== "draft") return <IssuedInvoice inv={data} reload={inv.reload} />;
  return <DraftEditor inv={data} onSaved={(saved) => (isNew ? navigate(`/money/invoices/${saved.id}`) : inv.reload())} />;
}

function Back() {
  return <a className="btn small" {...linkProps("/money")}><Icon name="back" size={16} /> Money</a>;
}

function DraftEditor({ inv, onSaved }: { inv: Invoice | null; onSaved: (inv: Invoice) => void }) {
  const clients = useLoad<Client[]>("/ogdoad/money/clients");
  const [clientId, setClientId] = useState(inv?.clientId ?? "");
  const [lines, setLines] = useState<LineDraft[]>(inv?.lines.length ? inv.lines.map(toDraftLine) : [emptyLine()]);
  const [serviceFrom, setServiceFrom] = useState(inv?.serviceFrom ?? "");
  const [serviceTo, setServiceTo] = useState(inv?.serviceTo ?? "");
  const [participant, setParticipant] = useState(inv?.participantName ?? "");
  const [ndis, setNdis] = useState(inv?.ndisNumber ?? "");
  const [notes, setNotes] = useState(inv?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId && clients.data?.length === 1) setClientId(clients.data[0].id);
  }, [clients.data]);

  const parsed = lines.map((l) => ({ description: l.description.trim(), quantity: Number(l.quantity), unitCents: parseAud(l.unit), serviceDate: l.serviceDate || null }));
  const total = parsed.reduce((sum, l) => sum + (Number.isFinite(l.unitCents) && l.quantity > 0 ? Math.round(l.quantity * l.unitCents) : 0), 0);
  const client = clients.data?.find((c) => c.id === clientId);

  const body = () => {
    const bad = parsed.findIndex((l) => !l.description || !(l.quantity > 0) || !Number.isFinite(l.unitCents));
    if (!clientId) throw new Error("Choose who the invoice is for.");
    if (bad >= 0) throw new Error(`Line ${bad + 1} needs a description, a quantity and a price.`);
    return { clientId, lines: parsed, serviceFrom: serviceFrom || null, serviceTo: serviceTo || null, participantName: participant, ndisNumber: ndis, notes };
  };

  const save = async (then?: (saved: Invoice) => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      const saved = inv ? await api.put<Invoice>(`/ogdoad/money/invoices/${inv.id}`, body()) : await api.post<Invoice>("/ogdoad/money/invoices", body());
      if (then) await then(saved);
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const issue = () =>
    save(async (saved) => {
      if (!confirm(`Issue this invoice for ${aud(total)} to ${client?.name}? It gets its number now and can't be edited afterwards.`)) throw new Error("Not issued.");
      await api.post(`/ogdoad/money/invoices/${saved.id}/issue`, {});
    });

  const reject = async () => {
    if (!inv) return;
    const reason = prompt("Why reject this draft? (It's kept, marked rejected.)") ?? "";
    await api.post(`/ogdoad/money/invoices/${inv.id}/reject`, { reason });
    navigate("/money");
  };

  const set = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <>
      <header className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <Back />
          <h1>{inv ? "Draft invoice" : "New invoice"}</h1>
          <p>It gets its number when you issue it. Until then, change anything.</p>
        </div>
        <div className="row">
          {inv ? <button className="btn danger" onClick={() => void reject()} disabled={busy}>Reject draft</button> : null}
          {inv ? <a className="btn" href={`/ogdoad/money/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file" size={16} /> Preview PDF</a> : null}
          <button className="btn" onClick={() => void save()} disabled={busy}>Save draft</button>
          <button className="btn primary" onClick={() => void issue()} disabled={busy || !total}>Issue</button>
        </div>
      </header>
      {error && error !== "Not issued." ? <ErrorNote error={error} /> : null}

      <section className="card stack">
        <div className="form-grid">
          <label className="field">Client
            <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Choose a client…</option>
              {clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">Service from<input className="input" type="date" value={serviceFrom} onChange={(e) => setServiceFrom(e.target.value)} /></label>
          <label className="field">Service to<input className="input" type="date" value={serviceTo} onChange={(e) => setServiceTo(e.target.value)} /></label>
          <label className="field">NDIS participant<input className="input" value={participant} placeholder={client?.participantName || "Optional"} onChange={(e) => setParticipant(e.target.value)} /></label>
          <label className="field">NDIS number<input className="input mono" value={ndis} placeholder={client?.ndisNumber || "Optional"} onChange={(e) => setNdis(e.target.value)} /></label>
        </div>
        {!clients.data?.length && clients.data ? <div className="notice"><span style={{ flex: 1 }}>No clients yet.</span><a className="btn small" {...linkProps("/money/clients")}>Add a client</a></div> : null}
      </section>

      <section className="card stack" aria-label="Lines">
        <h3>What it's for</h3>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th style={{ width: "45%" }}>Description</th><th>Date</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const p = parsed[i];
                const amount = Number.isFinite(p.unitCents) && p.quantity > 0 ? Math.round(p.quantity * p.unitCents) : 0;
                return (
                  <tr key={i}>
                    <td><input className="input" aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Support work: community access" /></td>
                    <td><input className="input" type="date" aria-label={`Line ${i + 1} date`} value={l.serviceDate} onChange={(e) => set(i, { serviceDate: e.target.value })} /></td>
                    <td className="num"><input className="input" style={{ width: 80, textAlign: "right" }} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></td>
                    <td className="num"><input className="input" style={{ width: 120, textAlign: "right" }} inputMode="decimal" aria-label={`Line ${i + 1} unit price`} value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} placeholder="0.00" /></td>
                    <td className="num">{aud(amount)}</td>
                    <td><button className="btn small" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))}><Icon name="close" size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="row">
          <button className="btn small" onClick={() => setLines((ls) => [...ls, emptyLine()])}><Icon name="plus" size={14} /> Add a line</button>
          <span className="spacer" />
          <span className="muted">Total</span>
          <strong style={{ fontSize: 22 }}>{aud(total)}</strong>
        </div>
        <label className="field">Notes on the invoice<textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      </section>
    </>
  );
}

function IssuedInvoice({ inv, reload }: { inv: Invoice; reload: () => void }) {
  const [amount, setAmount] = useState("");
  // Today on this machine (en-CA formats as YYYY-MM-DD); toISOString would give the UTC date.
  const [received, setReceived] = useState(new Date().toLocaleDateString("en-CA"));
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recordPayment = async () => {
    setError(null);
    const cents = parseAud(amount);
    if (!Number.isFinite(cents) || cents <= 0) return setError("Enter the amount received.");
    try {
      await api.post(`/ogdoad/money/invoices/${inv.id}/payments`, { amountCents: cents, receivedOn: received, evidence });
      setAmount("");
      setEvidence("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const voidIt = async () => {
    const reason = prompt("Why is this invoice being voided? It stays on the record with this reason.");
    if (!reason?.trim()) return;
    try {
      await api.post(`/ogdoad/money/invoices/${inv.id}/void`, { reason });
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const facts = useMemo(() => [
    ["Client", inv.clientName], ["Issued", shortDate(inv.issueDate)], ["Due", shortDate(inv.dueDate)],
    ["Service", inv.serviceFrom || inv.serviceTo ? [shortDate(inv.serviceFrom), shortDate(inv.serviceTo)].filter(Boolean).join(" to ") : ""],
    ["NDIS participant", inv.participantName], ["NDIS number", inv.ndisNumber], ["Imported", inv.source === "import" ? "from the previous invoicing system" : ""],
  ].filter(([, v]) => v), [inv]);

  return (
    <>
      <header className="page-head">
        <div className="stack" style={{ gap: 6 }}>
          <Back />
          <div className="row"><h1 className="mono">Invoice {inv.number}</h1><StatusChip bucket={inv.bucket} /></div>
          {inv.voidReason ? <p>Voided: {inv.voidReason}</p> : <p>{inv.balanceCents ? `${aud(inv.balanceCents)} still owing${inv.daysOverdue && inv.daysOverdue > 0 ? `, ${inv.daysOverdue} days late` : ""}.` : "Paid in full."}</p>}
        </div>
        <div className="row">
          <a className="btn" href={`/ogdoad/money/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><Icon name="file" size={16} /> Open PDF</a>
          {inv.status === "issued" && !inv.paidCents ? <button className="btn danger" onClick={() => void voidIt()}>Void</button> : null}
        </div>
      </header>
      {error ? <ErrorNote error={error} /> : null}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <section className="card stack">
          {facts.map(([k, v]) => <div key={k} className="row" style={{ justifyContent: "space-between" }}><span className="muted">{k}</span><span style={{ textAlign: "right" }}>{v}</span></div>)}
        </section>
        <section className="card stack" aria-label="Payments">
          <h3>Payments</h3>
          {inv.payments.length ? inv.payments.map((p) => (
            <div key={p.id} className="row" style={{ justifyContent: "space-between" }}>
              <span>{p.receivedOn ? shortDate(p.receivedOn) : "Date unknown"} <span className="muted">· {p.matchedBy}</span></span>
              <strong>{aud(p.amountCents)}</strong>
            </div>
          )) : <span className="muted">Nothing received yet.</span>}
          {inv.status === "issued" && inv.balanceCents > 0 ? (
            <form className="stack" style={{ gap: 10, borderTop: "1px solid var(--edge)", paddingTop: 12 }} onSubmit={(e) => { e.preventDefault(); void recordPayment(); }}>
              <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <label className="field">Amount received<input className="input" inputMode="decimal" value={amount} placeholder={(inv.balanceCents / 100).toFixed(2)} onChange={(e) => setAmount(e.target.value)} /></label>
                <label className="field">On<input className="input" type="date" value={received} onChange={(e) => setReceived(e.target.value)} /></label>
              </div>
              <label className="field">Where you saw it<input className="input" value={evidence} placeholder="Bank statement line, for example" onChange={(e) => setEvidence(e.target.value)} /></label>
              <button className="btn primary" type="submit">Record payment</button>
            </form>
          ) : null}
        </section>
      </div>

      <section className="card stack" aria-label="Lines">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {inv.lines.map((l) => <tr key={l.id}><td>{l.description}{l.serviceDate ? <span className="muted"> · {shortDate(l.serviceDate)}</span> : null}</td><td className="num">{l.quantity}</td><td className="num">{aud(l.unitCents)}</td><td className="num">{aud(l.lineCents ?? 0)}</td></tr>)}
              <tr><td colSpan={3} className="num"><strong>Total</strong></td><td className="num"><strong>{aud(inv.totalCents)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {inv.events?.length ? (
        <section className="card stack" aria-label="History">
          <h3>History</h3>
          {inv.events.map((e, i) => <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: 13 }}><span>{e.kind.replace(/_/g, " ")}{e.detail ? <span className="muted"> · {e.detail}</span> : null}</span><span className="muted">{e.actor} · {new Date(e.at).toLocaleString("en-AU")}</span></div>)}
        </section>
      ) : null}
    </>
  );
}
