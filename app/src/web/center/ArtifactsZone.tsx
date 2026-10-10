// VI. Artifacts: the shelf of everything made in the business, newest first, each with where it came
// from: who made it, how, its privacy tier and what the cloud saw while it was made. Invoices first;
// shift notes and the hires' documents and dashboards join as they're produced.

import { useMemo, useState } from "react";

import { Icon } from "../components/icons";
import type { Artifact } from "../lib/api";
import { ago } from "../lib/format";
import { navigate, usePath } from "../lib/router";
import { useZoom, Zone } from "./ControlCenter";
import { useCenter } from "./data";

function Item({ a, picked }: { a: Artifact; picked?: boolean }) {
  return (
    <button className={`shelf-item${picked ? " picked" : ""}`} onClick={() => navigate(`/artifacts/${a.id}`)}>
      <span className="shelf-icon"><Icon name="money" size={16} /></span>
      <span className="shelf-text">
        <span className="shelf-title">{a.title}</span>
        <span className="muted">{a.by} · {ago(a.at)}</span>
      </span>
      <span className="chip quiet tier">{a.tier}</span>
    </button>
  );
}

export function ArtifactsZone() {
  const { artifacts, info } = useCenter();
  const open = useZoom() === "artifacts";
  const pickedId = usePath().split("/").filter(Boolean)[1];
  const [q, setQ] = useState("");
  const list = artifacts ?? [];
  const week = list.filter((a) => Date.now() - Date.parse(a.at) < 7 * 86_400_000).length;
  const shown = useMemo(() => (q ? list.filter((a) => a.title.toLowerCase().includes(q.toLowerCase())) : list), [list, q]);
  const chip = <span className="chip quiet">{week} this week</span>;

  if (!open) {
    return (
      <Zone id="artifacts" chip={chip}>
        <div className="stack shelf" style={{ gap: 4 }}>
          {list.slice(0, 6).map((a) => <Item key={a.id} a={a} />)}
          {!list.length ? <span className="muted" style={{ fontSize: 13 }}>Nothing made yet. Issued invoices land here first, then shift notes and the hires' work.</span> : null}
        </div>
      </Zone>
    );
  }
  const picked = list.find((a) => a.id === pickedId) ?? null;
  return (
    <Zone id="artifacts" chip={chip}>
      <div className="room-cols">
        <div className="stack" style={{ gap: 8, minWidth: 0 }}>
          <label htmlFor="shelf-q" className="sr">Search what got made</label>
          <input id="shelf-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by number or client" autoComplete="off" />
          <div className="stack shelf" style={{ gap: 4 }}>{shown.map((a) => <Item key={a.id} a={a} picked={a.id === picked?.id} />)}</div>
        </div>
        {picked ? (
          <div className="stack provenance enter" key={picked.id} style={{ gap: 12 }}>
            <strong style={{ fontSize: 18 }}>{picked.title}</strong>
            <dl>
              <dt>Made by</dt><dd>{picked.by}{picked.via === "Money" ? ", in Money" : ", brought in"}</dd>
              <dt>When</dt><dd>{new Date(picked.at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}</dd>
              <dt>Privacy</dt><dd>{picked.tier}</dd>
              <dt>The cloud saw</dt><dd>{picked.cloudSaw}</dd>
              <dt>At rest</dt><dd>{info?.practice ? "not encrypted: the practice copy's books are made up" : picked.sealed ? "sealed with your key" : "in the encrypted books (no sealed copy yet)"}</dd>
            </dl>
            <div className="row">
              <a className="btn primary" href={picked.open} target="_blank" rel="noreferrer"><Icon name="external" size={16} /> Open the PDF</a>
              <button className="btn" onClick={() => navigate(picked.ref)}>Go to the invoice</button>
            </div>
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>Sharing is always your act: nothing here leaves this machine unless you send it.</p>
          </div>
        ) : <p className="muted">Pick something to see where it came from.</p>}
      </div>
    </Zone>
  );
}
