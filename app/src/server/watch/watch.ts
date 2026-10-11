// The watch: Ogdoad's local heartbeat over the team. Every few seconds it looks at each hire that's
// waiting on a decision, reads the prompt off its screen, sorts what it wants to do by risk, and puts
// it in front of the operator as a card: allow it once, or deny it. What the operator's policy would do
// is shown on every card; the watch answers by itself only when the operator has turned that on, only
// what the policy allows, and never a kind on the floor (deleting, sending out, spending, investing,
// secrets, starting agents). An answer is pressed only while the very same prompt is still on screen.

import { randomUUID } from "node:crypto";

import type { Raised } from "../flow/flow.js";
import { HttpError } from "../http.js";
import { recipientOfHire, recordDirectCrossing } from "../crossings.js";
import type { Money } from "../money/service.js";
import { decide, type Verdict } from "./policy.js";
import { parsePrompt, type Ask, type Choice } from "./prompt.js";
import { ALWAYS_ASK, classify, RISK_VERB, RISK_WORD, type Risk, type RiskKind } from "./risk.js";

export interface HorosLink { base: string; headers: () => Record<string, string> }
interface HireInfo { id: string; label: string; harness: string; state: string; cwd?: string; role?: string }

export interface WatchAsk {
  id: string; hireId: string; fingerprint: string; hireLabel: string; harness: string; place: string;
  title: string | null; action: string; question: string; choices: Choice[];
  risk: Risk; verdict: Verdict; state: "open" | "answered" | "gone"; answer: string | null; answeredBy: string | null;
  createdAt: string; updatedAt: string;
}

const iso = () => new Date().toISOString();
const shortLabel = (l: string) => l.replace(/ - .*$/, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toAsk(r: any): WatchAsk {
  return {
    id: r.id, hireId: r.hire_id, fingerprint: r.fingerprint, hireLabel: r.hire_label, harness: r.harness, place: r.place, title: r.title, action: r.action, question: r.question,
    choices: JSON.parse(r.choices), risk: JSON.parse(r.risk), verdict: JSON.parse(r.verdict), state: r.state, answer: r.answer, answeredBy: r.answered_by,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class Watch {
  constructor(private readonly money: Money, private readonly horos: HorosLink, private readonly home?: string) {}

  private get db() {
    return this.money.db;
  }

  private async horosCall<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
    const r = await fetch(`${this.horos.base}${path}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json", ...this.horos.headers() },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new HttpError(502, "horos", `Horos answered ${r.status}.`);
    return (await r.json()) as T;
  }

  private async screenOf(hireId: string): Promise<Ask | null> {
    const s = await this.horosCall<{ lines: string[] }>(`/v1/hires/${encodeURIComponent(hireId)}/screen?lines=60`);
    return parsePrompt(Array.isArray(s.lines) ? s.lines : []);
  }

  settings(): { auto: boolean } {
    const r = this.db.prepare("SELECT auto FROM watch_settings WHERE id = 1").get() as { auto: number } | undefined;
    return { auto: !!r?.auto };
  }

  setAuto(on: boolean): { auto: boolean } {
    this.db.prepare("UPDATE watch_settings SET auto = ?, updated_at = ? WHERE id = 1").run(on ? 1 : 0, iso());
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'watch_auto', NULL, ?)").run(iso(), on ? "on" : "off");
    return this.settings();
  }

  list(limit = 40): WatchAsk[] {
    return (this.db.prepare("SELECT * FROM watch_asks ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT ?").all(limit) as any[]).map(toAsk);
  }

  get(id: string): WatchAsk {
    const r = this.db.prepare("SELECT * FROM watch_asks WHERE id = ?").get(id);
    if (!r) throw new HttpError(404, "no_ask", "That request isn't known here.");
    return toAsk(r);
  }

  /** One look at the team. True when anything the operator sees changed. */
  async tick(): Promise<boolean> {
    const hires = (await this.horosCall<HireInfo[]>("/v1/hires").catch(() => null))?.filter((h) => h.role !== "server");
    if (!hires) return false;
    let changed = false;
    const read = new Map<string, string | null>(); // hire -> the prompt on its screen (fingerprint), for those read
    for (const h of hires.filter((x) => x.state === "blocked")) {
      let ask: Ask | null;
      try {
        ask = await this.screenOf(h.id);
      } catch {
        continue;
      }
      read.set(h.id, ask?.fingerprint ?? null);
      if (!ask) continue;
      // Still waiting on the same prompt: the same card. Just answered: give the hire a moment to take it.
      const since = new Date(Date.now() - 30_000).toISOString();
      if (this.db.prepare("SELECT 1 FROM watch_asks WHERE hire_id = ? AND fingerprint = ? AND (state = 'open' OR (state = 'answered' AND updated_at > ?))").get(h.id, ask.fingerprint, since)) continue;
      const id = randomUUID().slice(0, 13);
      const risk = classify(ask);
      const place = recipientOfHire(h.id, this.home, { label: h.label, harness: h.harness }).where;
      let verdict: Verdict;
      try {
        verdict = decide(ask, risk, { label: shortLabel(h.label), harness: h.harness, where: place, cwd: h.cwd ?? null });
      } catch (err) {
        verdict = { allow: false, why: `the policy failed: ${(err as Error).message}` };
      }
      const now = iso();
      this.db.prepare(`INSERT INTO watch_asks (id, hire_id, fingerprint, hire_label, harness, place, title, action, question, choices, risk, verdict, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, h.id, ask.fingerprint, shortLabel(h.label), h.harness, place, ask.title, ask.action.slice(0, 4000), ask.question, JSON.stringify(ask.choices), JSON.stringify(risk), JSON.stringify(verdict), now, now);
      changed = true;
      // Answered by the policy only when the operator turned that on, and never a kind on the floor.
      if (this.settings().auto && verdict.allow && !risk.high && ask.choices.some((c) => c.kind === "yes")) {
        await this.press(this.get(id), "allow", "policy").catch(() => {});
      }
    }
    // Asks that went away: the hire isn't waiting any more, or it's waiting on something else now.
    const blocked = new Set(hires.filter((x) => x.state === "blocked").map((h) => h.id));
    for (const a of (this.db.prepare("SELECT id, hire_id, fingerprint FROM watch_asks WHERE state = 'open'").all() as Array<{ id: string; hire_id: string; fingerprint: string }>)) {
      const gone = !blocked.has(a.hire_id) || (read.has(a.hire_id) && read.get(a.hire_id) !== a.fingerprint);
      if (gone) {
        this.db.prepare("UPDATE watch_asks SET state = 'gone', updated_at = ? WHERE id = ?").run(iso(), a.id);
        changed = true;
      }
    }
    return changed;
  }

  /** The operator answers: allow once, always allow, or deny. A risky "yes" takes a second yes (confirm). */
  async answer(id: string, choice: unknown, confirm = false): Promise<WatchAsk> {
    if (choice !== "allow" && choice !== "always" && choice !== "deny") throw new HttpError(400, "choice", "Allow, always or deny.");
    const ask = this.get(id);
    if (ask.state !== "open") throw new HttpError(409, "not_open", ask.state === "answered" ? "That was already answered." : "It isn't asking that any more.");
    if (choice !== "deny" && ask.risk.high && !confirm) {
      throw new HttpError(409, "confirm", `${ask.hireLabel} wants to do something that ${ask.risk.kinds.filter((k) => ALWAYS_ASK.includes(k)).map((k) => RISK_WORD[k]).join(", ")}. Allow it again to let it.`);
    }
    return this.press(ask, choice, "you");
  }

  private async press(ask: WatchAsk, choice: "allow" | "always" | "deny", by: "you" | "policy"): Promise<WatchAsk> {
    // Only into the very same prompt: anything else on screen, and the answer isn't pressed.
    const now = await this.screenOf(ask.hireId).catch(() => null);
    if (!now || now.fingerprint !== ask.fingerprint) {
      this.db.prepare("UPDATE watch_asks SET state = 'gone', updated_at = ? WHERE id = ?").run(iso(), ask.id);
      throw new HttpError(409, "moved_on", `${ask.hireLabel} isn't asking that any more: it was answered in its terminal, or it moved on.`);
    }
    const want = choice === "allow" ? "yes" : choice === "always" ? "always" : "no";
    const pick = ask.choices.find((c) => c.kind === want);
    const keys = pick?.keys ?? (choice === "deny" ? ["esc"] : null);
    if (!keys) throw new HttpError(400, "no_choice", `Its prompt has no "${choice === "always" ? "always" : "yes"}" to press. Answer it in its terminal.`);
    await this.horosCall(`/v1/hires/${encodeURIComponent(ask.hireId)}/keys`, { method: "POST", body: { keys } });
    // A menu that only moved its selection is confirmed with Enter; one that took the number is gone.
    if (/^\d$/.test(keys[0])) {
      await wait(700);
      const after = await this.screenOf(ask.hireId).catch(() => null);
      if (after && after.fingerprint === now.fingerprint) await this.horosCall(`/v1/hires/${encodeURIComponent(ask.hireId)}/keys`, { method: "POST", body: { keys: ["enter"] } });
    }
    const at = iso();
    this.db.prepare("UPDATE watch_asks SET state = 'answered', answer = ?, answered_by = ?, updated_at = ? WHERE id = ?").run(choice, by, at, ask.id);
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, ?, 'watch_answered', ?, ?)")
      .run(at, by === "you" ? "operator" : "watch", ask.id, JSON.stringify({ hire: ask.hireLabel, harness: ask.harness, kinds: ask.risk.kinds, policy: ask.verdict.allow, answer: choice, by }));
    recordDirectCrossing(this.money, ask.hireId, `${by === "policy" ? "your policy " : ""}${choice === "deny" ? "denied" : choice === "always" ? "always allowed" : "allowed once"}: ${ask.title ?? ask.question}`, recipientOfHire(ask.hireId, this.home, { label: ask.hireLabel, harness: ask.harness }));
    return this.get(ask.id);
  }
}

/** Open asks as Flow cards: they clear themselves once they're answered (or the hire moves on). */
export function raisedFromWatch(money: Money): Raised[] {
  const rows = (money.db.prepare("SELECT * FROM watch_asks WHERE state = 'open' ORDER BY created_at").all() as any[]).map(toAsk);
  return rows.map((a) => {
    const first = a.risk.kinds[0] as RiskKind;
    const line = a.action.split("\n").find((l) => l.trim()) ?? a.question;
    return {
      key: `watch:ask:${a.hireId}:${a.id}`,
      title: `${a.hireLabel} wants to ${RISK_VERB[first] ?? "do something"}`,
      context: `${line.length > 140 ? `${line.slice(0, 139)}…` : line} · ${a.verdict.allow ? "Your policy would allow it." : "Your policy holds it for you."}`,
      source: "team" as const, ref: `/flow/watch/${encodeURIComponent(a.id)}`, urgency: a.risk.high ? 3 : 2, blocking: true,
    };
  });
}
