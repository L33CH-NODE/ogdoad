// The command line: SOPHIA and the command palette at once (Ctrl+K from anywhere). Commands Ogdoad
// knows run here ("go money", "add ring Harbour", "what's late?", "/deep", "/lock"); anything else is
// a message to SOPHIA, and her reply appears above the line when it comes.

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../components/icons";
import { api } from "../lib/api";
import { aud } from "../lib/format";
import { navigate } from "../lib/router";
import { useCenter } from "./data";

const SKINS = [
  { id: "ogdoad-dark", label: "Dark" },
  { id: "ogdoad", label: "Light" },
  { id: "cyberpunk-uv", label: "Ultraviolet" },
];
const PLACES = ["flow", "team", "money", "work", "artifacts", "signals", "dashboards", "settings"];
const COMMANDS: Array<{ say: string; hint: string }> = [
  ...PLACES.map((p) => ({ say: `go ${p}`, hint: `Open ${p[0].toUpperCase()}${p.slice(1)}` })),
  { say: "new invoice", hint: "Start a draft" },
  { say: "add ", hint: "Add a task: add ring Harbour about the roster" },
  { say: "what's late?", hint: "Late invoices, from your books" },
  { say: "/deep", hint: "Deep work on or off" },
  { say: "/skin", hint: "Next skin" },
  { say: "/lock", hint: "Lock Ogdoad now" },
  { say: "home", hint: "Back to everything" },
];

export function CommandLine() {
  const { sophia, sophiaReply, markAsked, say, deep, setDeep, invoices, vault, info, reloadFlow } = useCenter();
  const [draft, setDraft] = useState("");
  const [palette, setPalette] = useState(false);
  const [pick, setPick] = useState(-1);
  const [skin, setSkin] = useState(() => document.documentElement.dataset.skin ?? "ogdoad-dark");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const preset = (e as CustomEvent<string | undefined>).detail;
      if (typeof preset === "string") setDraft(preset);
      setPalette(typeof preset !== "string");
      setPick(-1);
      input.current?.focus();
    };
    window.addEventListener("ogdoad:command", on);
    return () => window.removeEventListener("ogdoad:command", on);
  }, []);

  const matches = useMemo(() => {
    const d = draft.trim().toLowerCase();
    if (!palette && !d.startsWith("/")) return [];
    return COMMANDS.filter((c) => !d || c.say.startsWith(d) || c.say.includes(d) || c.hint.toLowerCase().includes(d)).slice(0, 7);
  }, [draft, palette]);

  // In the palette, the first match is ready to run; arrows move it.
  const lit = matches.length ? Math.max(0, Math.min(pick, matches.length - 1)) : -1;

  const nextSkin = () => {
    const next = SKINS[(SKINS.findIndex((s) => s.id === skin) + 1) % SKINS.length].id;
    document.documentElement.dataset.skin = next;
    try {
      localStorage.setItem("ogdoad.skin", next);
    } catch {}
    setSkin(next);
  };
  const lock = async () => {
    if (info?.practice) return say("Ogdoad", "The practice copy has no lock: its books are made up.", "muted");
    await api.post("/ogdoad/vault/lock").catch(() => {});
    window.dispatchEvent(new Event("ogdoad:locked"));
  };

  const run = async (text: string) => {
    const said = text.trim();
    const lower = said.toLowerCase();
    setDraft("");
    setPalette(false);
    setPick(-1);
    if (!said) return;
    const place = /^(?:go|open|show)?\s*(\w+)$/.exec(lower)?.[1];
    if (place && PLACES.includes(place)) return navigate(`/${place}`);
    if (/^(home|back|everything)$/.test(lower)) return navigate("/");
    if (lower === "/lock" || lower === "lock") return void lock();
    if (lower === "/deep" || lower === "deep work") return setDeep(!deep.on);
    if (lower === "/skin" || lower === "skin") return nextSkin();
    if (/^(new|start an?) invoice/.test(lower)) return navigate("/money/invoices/new");
    const task = /^(?:add|todo|task|\+)\s+(.+)$/i.exec(said)?.[1];
    if (task) {
      try {
        await api.post("/ogdoad/flow", { title: task });
        reloadFlow();
      } catch (err) {
        say("Ogdoad", (err as Error).message, "bad");
      }
      return;
    }
    if (/\blate\b|overdue|who owes/.test(lower)) {
      const late = (invoices ?? []).filter((i) => i.status === "issued" && i.balanceCents > 0 && (i.daysOverdue ?? 0) > 0).sort((a, b) => (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0));
      say("you", said);
      if (!late.length) return say("Ogdoad", "Nothing is late. Everything owed is still inside its terms.", "good");
      const total = late.reduce((a, i) => a + i.balanceCents, 0);
      return say("Ogdoad", `${late.length} invoice${late.length === 1 ? " is" : "s are"} late, ${aud(total)} in all. The oldest is ${late[0].number} from ${late[0].clientName}, ${late[0].daysOverdue} days. Check the bank before chasing.`, "warn");
    }
    if (!sophia) return say("Ogdoad", "SOPHIA isn't set up yet. Her setup is in the classic view; until then, commands still work here.", "warn");
    try {
      // A comment on her task wakes her, the same way the setup cards do.
      await api.post(`/api/issues/${sophia.taskId}/comments`, { body: said, clientRequestId: crypto.randomUUID() });
      say("you", `to SOPHIA: ${said}`);
      markAsked();
    } catch (err) {
      say("Ogdoad", `Couldn't reach SOPHIA: ${(err as Error).message}`, "bad");
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (palette || draft) {
        setPalette(false);
        setDraft("");
      } else input.current?.blur();
    } else if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setPick((p) => (e.key === "ArrowDown" ? (p + 1) % matches.length : (p - 1 + matches.length) % matches.length));
    } else if (e.key === "Tab" && matches.length) {
      e.preventDefault();
      setDraft(matches[lit].say);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = lit >= 0 ? matches[lit].say : null;
      if (chosen && chosen.endsWith(" ")) return setDraft(chosen);
      void run(chosen ?? draft);
    }
  };

  const reply = sophiaReply && sophiaReply.id !== dismissed ? sophiaReply : null;
  return (
    <footer className="zone keep cmdline" style={{ gridArea: "cmd" }}>
      {reply ? (
        <div className="reply enter" role="status">
          <span className="orb small" aria-hidden="true" />
          <p><strong>SOPHIA</strong> {reply.body.length > 420 ? `${reply.body.slice(0, 420)}… (the rest is on her task)` : reply.body}</p>
          <button className="icon-btn" onClick={() => setDismissed(reply.id)} aria-label="Dismiss SOPHIA's reply"><Icon name="close" size={14} /></button>
        </div>
      ) : null}
      {matches.length ? (
        <ul className="palette enter" role="listbox" aria-label="Commands">
          {matches.map((c, i) => (
            <li key={c.say} role="option" aria-selected={i === lit} onMouseDown={(e) => { e.preventDefault(); if (c.say.endsWith(" ")) { setDraft(c.say); input.current?.focus(); } else void run(c.say); }}>
              <span className="mono">{c.say.trim()}</span><span className="muted">{c.hint}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cmd-row">
        <span className="orb" aria-hidden="true" />
        <span className="mono prompt">SOPHIA ›</span>
        <label htmlFor="cc-cmd" className="sr">Command, or a message to SOPHIA</label>
        <input id="cc-cmd" ref={input} value={draft} autoComplete="off" spellCheck={false}
          onChange={(e) => { setDraft(e.target.value); setPick(-1); }} onKeyDown={onKey} onBlur={() => setTimeout(() => setPalette(false), 120)}
          placeholder={sophia ? "Ask SOPHIA, or type a command: go money · add a task · what's late? · /deep" : "Type a command: go money · add a task · what's late? · /deep"} />
        <kbd className="hide-sm" title="Ctrl+K from anywhere">Ctrl K</kbd>
        <span className="sep hide-sm" />
        {info?.practice
          ? <span className="vault-chip"><Icon name="shield" size={14} />practice copy · no lock</span>
          : <button className="vault-chip" onClick={() => void lock()} title="Lock Ogdoad now"><Icon name="lock" size={14} />vault open · locks after {vault?.lockMinutes ?? 30} idle min</button>}
        <button className="hint" onClick={nextSkin} title="Change the skin">{SKINS.find((s) => s.id === skin)?.label ?? "Dark"}</button>
      </div>
    </footer>
  );
}
