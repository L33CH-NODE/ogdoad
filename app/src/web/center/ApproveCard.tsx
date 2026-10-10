// An approval, decided where it lands in Flow: what's being asked (hiring, a plan, going over budget),
// its details, an optional note, and Approve or Turn down. Deciding is what clears it from Flow.

import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { useCenter } from "./data";

interface Approval { id: string; type: string; status: string; payload: Record<string, unknown>; decisionNote: string | null; createdAt: string }

const KIND: Record<string, string> = {
  hire_agent: "Hire a new agent",
  approve_ceo_strategy: "SOPHIA's plan",
  budget_override_required: "Go over the budget",
  request_board_approval: "A decision for you",
};

/** The payload's simple fields, in words; nested things are summarised, not dumped. */
function details(payload: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(payload)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 12)
    .map(([k, v]) => [k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase(), typeof v === "object" ? (Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : "details in the classic view") : String(v).slice(0, 400)]);
}

export function ApproveCard({ id }: { id: string }) {
  const { say, reloadFlow } = useCenter();
  const [a, setA] = useState<Approval | null | undefined>(undefined);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setA(undefined);
    api.get<Approval>(`/api/approvals/${id}`).then(setA, () => setA(null));
  }, [id]);

  if (a === undefined) return <div className="now-card askcard"><span className="muted">Opening it…</span></div>;
  if (!a || a.status !== "pending") {
    return (
      <div className="now-card askcard calm">
        <strong>{a ? `Already decided: ${a.status.replace(/_/g, " ")}.` : "That approval isn't there any more."}</strong>
        <button className="link-btn" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/flow")}>Back to Flow</button>
      </div>
    );
  }
  const decide = async (verb: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/approvals/${a.id}/${verb}`, { decisionNote: note.trim() || null });
      say("you", `${verb === "approve" ? "approved" : "turned down"}: ${KIND[a.type] ?? a.type}${note.trim() ? ` (${note.trim()})` : ""}`, verb === "approve" ? "good" : "muted");
      reloadFlow();
      navigate("/flow");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const rows = details(a.payload ?? {});
  return (
    <div className="now-card askcard enter">
      <span className="zlabel" style={{ color: "var(--warn)" }}>Needs your yes</span>
      <strong className="now-title">{KIND[a.type] ?? a.type.replace(/_/g, " ")}</strong>
      {rows.length ? <dl className="approval-dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : null}
      <label className="field">A note with your decision (optional)
        <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <div className="now-acts">
        <button className="btn small" onClick={() => navigate("/flow")}>Later</button>
        <button className="btn small danger" disabled={busy} onClick={() => void decide("reject")}>Turn it down</button>
        <button className="btn small primary" disabled={busy} onClick={() => void decide("approve")}>Approve</button>
      </div>
    </div>
  );
}
