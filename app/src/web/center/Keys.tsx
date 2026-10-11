// Sub shortcut keys: a leader, then one key. G goes somewhere (G then F is Flow), N makes something new
// (N then I is a new invoice). A moment after the leader, a small key map shows what the next key does,
// so nothing needs memorising; ? shows every key at once, and / opens the command line on its slash
// commands. Keys only count when you aren't typing in a field.

import { useEffect, useRef, useState } from "react";

import { navigate } from "../lib/router";
import { typing } from "./ControlCenter";

interface Sub { key: string; label: string; say?: string; run: () => void }
interface Chord { lead: string; word: string; subs: Sub[] }

const go = (path: string) => () => navigate(path);
/** Open the command line with words already in it (or on the palette, with none). */
const command = (preset?: string) => () => window.dispatchEvent(new CustomEvent("ogdoad:command", { detail: preset }));

export const CHORDS: Chord[] = [
  {
    lead: "g", word: "Go",
    subs: [
      { key: "f", label: "Flow", say: "go flow", run: go("/flow") },
      { key: "t", label: "Team", say: "go team", run: go("/team") },
      { key: "m", label: "Money", say: "go money", run: go("/money") },
      { key: "w", label: "Work", say: "go work", run: go("/work") },
      { key: "a", label: "Artifacts", say: "go artifacts", run: go("/artifacts") },
      { key: "s", label: "Signals", say: "go signals", run: go("/signals") },
      { key: "d", label: "Dashboards", say: "go dashboards", run: go("/dashboards") },
      { key: ",", label: "Settings", say: "go settings", run: go("/settings") },
      { key: "h", label: "Home", say: "home", run: go("/") },
    ],
  },
  {
    lead: "n", word: "New",
    subs: [
      { key: "i", label: "Invoice", say: "new invoice", run: go("/money/invoices/new") },
      { key: "s", label: "Shift", say: "new shift", run: go("/work/new") },
      { key: "t", label: "Task", say: "add ", run: command("add ") },
      { key: "r", label: "Room", say: "new room", run: go("/team/room/new") },
      { key: "h", label: "Hire", say: "hire someone", run: go("/team/hire") },
    ],
  },
];

/** The keys for a palette command, if it has any ("g f"). */
export function chordOf(say: string): string | undefined {
  for (const c of CHORDS) for (const s of c.subs) if (s.say === say) return `${c.lead} ${s.key}`;
  return undefined;
}

/** Keys that work on their own, for the full map. */
const SINGLES: Array<[string, string]> = [["Ctrl K", "Command palette"], ["/", "Slash commands"], ["Esc", "Back to everything"], ["D · S · P", "Flow: done, skip, park"], ["?", "This map"]];

const label = (k: string) => (k === "," ? "," : k.toUpperCase());

export function KeyChords() {
  // The leader pressed (waiting for the next key), and whether its map is showing yet.
  const [lead, setLead] = useState<string | null>(null);
  const [shown, setShown] = useState<"lead" | "all" | null>(null);
  const timers = useRef<number[]>([]);
  const clear = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };
  const cancel = () => {
    clear();
    setLead(null);
    setShown(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      const k = e.key.toLowerCase();
      const swallow = () => {
        e.preventDefault();
        // Before anything else hears it: S after G is Signals, not "skip" in Flow.
        e.stopImmediatePropagation();
      };
      if (lead) {
        const sub = CHORDS.find((c) => c.lead === lead)?.subs.find((s) => s.key === k);
        if (k === "escape" || sub) swallow();
        cancel();
        sub?.run();
        return;
      }
      if (shown === "all") {
        swallow();
        return cancel();
      }
      if (CHORDS.some((c) => c.lead === k) && !e.shiftKey) {
        swallow();
        setLead(k);
        // Shown after a beat, so a quick G F never flickers. It stays until a key, a click or Esc.
        timers.current.push(window.setTimeout(() => setShown("lead"), 260));
        return;
      }
      if (e.key === "?") {
        swallow();
        return setShown("all");
      }
      if (e.key === "/") {
        swallow();
        command("/")();
      }
    };
    // Capture: the chord's second key is taken before the zones' own single keys.
    window.addEventListener("keydown", onKey, true);
    const off = () => (lead || shown) && cancel();
    window.addEventListener("pointerdown", off);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", off);
    };
  }, [lead, shown]);
  useEffect(() => clear, []);

  if (!shown) return null;
  const chords = shown === "all" ? CHORDS : CHORDS.filter((c) => c.lead === lead);
  return (
    <div className="keymap enter" role="dialog" aria-label="Shortcut keys">
      {chords.map((c) => (
        <div key={c.lead} className="keymap-group">
          <span className="keymap-lead"><kbd>{label(c.lead)}</kbd> {c.word}</span>
          <div className="keymap-subs">
            {c.subs.map((s) => (
              <span key={s.key} className="keymap-sub"><kbd>{label(s.key)}</kbd>{s.label}</span>
            ))}
          </div>
        </div>
      ))}
      {shown === "all" ? (
        <div className="keymap-group">
          <span className="keymap-lead">On their own</span>
          <div className="keymap-subs">
            {SINGLES.map(([k, what]) => <span key={k} className="keymap-sub"><kbd>{k}</kbd>{what}</span>)}
          </div>
        </div>
      ) : <span className="muted keymap-foot">Esc to cancel · ? for every key</span>}
    </div>
  );
}
