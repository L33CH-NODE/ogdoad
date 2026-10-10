// A conversation with SOPHIA, in the control center: her task's thread as messages, her question cards
// in line (answered in Flow), and a box to reply. It's the same thread the classic view shows, so
// nothing is lost either way, and every message sent from here is noted in the crossings log. A message
// goes through the membrane: one that names someone waits here for a check, and the hire's stand-ins
// read as who they are.

import { useEffect, useRef, useState } from "react";

import { Markdown } from "../components/Markdown";
import { api, isHeld, type Check, type MaybeHeld } from "../lib/api";
import { useLinks } from "../lib/links";
import { ago } from "../lib/format";
import { navigate } from "../lib/router";
import { CheckCard } from "./CheckCard";
import { useCenter } from "./data";

interface Comment { id: string; body: string; createdAt: string; authorType?: string; authorAgentId?: string | null }
interface Card { id: string; kind: string; status: string; title: string | null; createdAt: string; resolvedAt?: string | null }

type Item = { at: string; kind: "comment"; c: Comment } | { at: string; kind: "card"; card: Card };

export function Conversation({ taskId, name }: { taskId: string; name: string }) {
  const { say, markAsked } = useCenter();
  const [items, setItems] = useState<Item[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<Check[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const links = useLinks((items ?? []).map((it) => (it.kind === "comment" ? it.c.body : "")));

  const load = () =>
    Promise.all([
      api.get<Comment[]>(`/api/issues/${taskId}/comments?order=desc&limit=60`),
      api.get<Card[]>(`/api/issues/${taskId}/interactions`).catch(() => [] as Card[]),
    ]).then(([comments, cards]) => {
      const list: Item[] = [
        ...comments.map((c) => ({ at: c.createdAt, kind: "comment" as const, c })),
        ...cards.filter((c) => c.kind === "ask_user_questions").map((card) => ({ at: card.createdAt, kind: "card" as const, card })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      setItems(list);
    }, (err) => setError((err as Error).message));

  useEffect(() => {
    void load();
    const t = setInterval(() => !document.hidden && void load(), 10_000);
    return () => clearInterval(t);
  }, [taskId]);
  // A body, not an arrow's value: scrollIntoView returns a promise in newer browsers, and an effect
  // may only return its cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items?.length]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<MaybeHeld<unknown>>(`/api/issues/${taskId}/comments`, { body, clientRequestId: crypto.randomUUID() });
      setText("");
      if (isHeld(r)) return setHeld((h) => [...h, r.held]);
      say("you", `to ${name}: ${body}`);
      markAsked();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fromHire = (c: Comment) => !!c.authorAgentId || c.authorType === "agent";
  return (
    <div className="stack conversation" style={{ gap: 10 }}>
      <div className="thread" aria-live="polite">
        {items === null ? <span className="muted">Reading the conversation…</span> : null}
        {items?.length === 0 ? <span className="muted">Nothing said yet. Say hello.</span> : null}
        {items?.map((it) => it.kind === "card" ? (
          <div key={`card-${it.card.id}`} className={`msg card${it.card.status === "pending" ? " waiting" : ""}`}>
            <span className="msg-who">{name} asked</span>
            <strong>{it.card.title ?? "A question card"}</strong>
            {it.card.status === "pending"
              ? <button className="btn small primary" style={{ alignSelf: "flex-start" }} onClick={() => navigate(`/flow/ask/${taskId}/${it.card.id}`)}>Answer it</button>
              : <span className="muted" style={{ fontSize: 12 }}>{it.card.status === "answered" ? "You answered it." : it.card.status}</span>}
          </div>
        ) : (
          <div key={it.c.id} className={`msg ${fromHire(it.c) ? "them" : "you"}`}>
            <span className="msg-who">{fromHire(it.c) ? name : "you"} · {ago(it.c.createdAt)}</span>
            <Markdown text={it.c.body} links={links} renderFence={(lang, _body, key) => lang === "ogdoad-recipe"
              ? <button key={key} className="btn small" onClick={() => navigate("/dashboards")}>A panel recipe: look at it in Dashboards</button>
              : null} />
          </div>
        ))}
        <div ref={end} />
      </div>
      {held.map((c) => (
        <CheckCard key={c.id} id={c.id} initial={c} onDone={(o) => {
          setHeld((h) => h.filter((x) => x.id !== c.id));
          if (o.kind === "sent") {
            markAsked();
            void load();
          }
        }} />
      ))}
      <form className="reply-box" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label htmlFor="talk" className="sr">Message {name}</label>
        <textarea id="talk" className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${name} (Ctrl+Enter sends)`}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
        <button className="btn small primary" type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      </form>
      {error ? <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p> : null}
      <span className="muted" style={{ fontSize: 11.5 }}>What you send goes to {name}'s harness, with your clients' details stood in, and is noted in "What the cloud has seen".</span>
    </div>
  );
}
