// One hire: a harness running in a real terminal (ConPTY on Windows), mirrored into a headless
// terminal so herd reads what a person would see, plus the state machine that watches it.

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { Terminal as TerminalType } from "@xterm/headless";

import { Stabilizer, type SelfReport } from "./detector.js";
import { classify, rulesFor, type HireState, type Rule } from "./rules.js";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

const TICK_MS = 300;
const CONFIRM_TICK_MS = 100;
const PROMPT_ENTER_DELAY_MS = 300;
const PROMPT_START_TIMEOUT_MS = 5000;

/**
 * Session-scoped variables a hire must never inherit when herd itself runs under a Claude Code
 * session: nesting markers (claude refuses to start, or turns transcripts off) and that session's
 * messaging credentials (a hire holding them could act as the parent session). Configuration such
 * as CLAUDE_CONFIG_DIR is left alone.
 */
const PARENT_SESSION_VAR = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(ENTRYPOINT|SESSION(_\w+)?|CHILD_SESSION|PARENT_SESSION|BRIDGE_SESSION_ID|MESSAGING_\w+))$/;

export interface HireSpec {
  id?: string;
  /** Harness id from harnesses.ts, used to pick detection rules ("generic" if unknown). */
  harness: string;
  /** Program and args, already resolved (see resolveCommand). */
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  label?: string;
  cols?: number;
  rows?: number;
}

export interface HireInfo {
  id: string;
  label: string;
  harness: string;
  argv: string[];
  cwd: string;
  pid: number;
  state: HireState;
  startedAt: string;
  lastOutputAt: string | null;
  exitCode: number | null;
  sessionId: string | null;
  title: string;
}

const KEYS: Record<string, string> = {
  enter: "\r", esc: "\x1b", escape: "\x1b", tab: "\t", backspace: "\x7f", space: " ",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  "ctrl+c": "\x03", "ctrl+d": "\x04", "shift+tab": "\x1b[Z",
};

export class Hire extends EventEmitter {
  readonly id: string;
  readonly label: string;
  readonly harness: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly startedAt = Date.now();
  title = "";
  exitCode: number | null = null;
  sessionId: string | null = null;
  resumeArgs: string[] | null = null;
  /** Settles once the hire's brief (if any) has been handed over; seats wait on it before prompting. */
  briefing: Promise<void> = Promise.resolve();

  private readonly pty: pty.IPty;
  private readonly term: TerminalType;
  private readonly rules: Rule[];
  private readonly stabilizer: Stabilizer;
  private lastOutputAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(spec: HireSpec) {
    super();
    this.id = spec.id ?? randomUUID().slice(0, 8);
    this.label = spec.label ?? spec.harness;
    this.harness = spec.harness;
    this.argv = [spec.file, ...spec.args];
    this.cwd = spec.cwd;
    this.rules = rulesFor(spec.harness);
    this.stabilizer = new Stabilizer(this.startedAt);

    const cols = spec.cols ?? 120;
    const rows = spec.rows ?? 40;
    this.term = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
    this.term.onTitleChange((title) => (this.title = title));

    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !PARENT_SESSION_VAR.test(name)) env[name] = value;
    Object.assign(env, spec.env, { OGDOAD_HIRE_ID: this.id });

    this.pty = pty.spawn(spec.file, spec.args, { name: "xterm-256color", cols, rows, cwd: spec.cwd, env });
    this.pty.onData((data) => {
      this.lastOutputAt = Date.now();
      this.term.write(data);
      this.emit("output", data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      this.stabilizer.markExited();
      this.emitState();
      // A session that ends on its own still holds its ConPTY host (conhost) open on Windows;
      // close it, or every crash leaks a console and keeps herd's event loop alive.
      setTimeout(() => {
        try {
          this.pty.kill();
        } catch {
          // already closed
        }
      }, 0);
      this.dispose();
    });
    this.schedule(TICK_MS);
  }

  get pid(): number {
    return this.pty.pid;
  }

  get state(): HireState {
    return this.stabilizer.state;
  }

  /** The visible screen, top to bottom, with trailing spaces trimmed. */
  screen(): string[] {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = buf.viewportY; y < buf.viewportY + this.term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    return lines;
  }

  /** Recent output including scrollback, newest last. Reading it acknowledges a "done" hire. */
  read(lines = 60, acknowledge = true): string[] {
    const buf = this.term.buffer.active;
    // Count back from the last line with content, not from the bottom of the screen: a short
    // session only fills the top of a 40-row terminal.
    let end = buf.viewportY + this.term.rows;
    while (end > 0 && !(buf.getLine(end - 1)?.translateToString(true) ?? "").trim()) end--;
    const out: string[] = [];
    for (let y = Math.max(0, end - lines); y < end; y++) out.push(buf.getLine(y)?.translateToString(true) ?? "");
    if (acknowledge && this.state === "done") {
      this.stabilizer.acknowledge();
      this.emitState();
    }
    return out;
  }

  /** Type text into the hire as a paste, then press Enter. Refuses while the hire waits on a decision. */
  async prompt(text: string, opts: { wait?: boolean; timeoutMs?: number } = {}): Promise<HireState> {
    if (this.state === "blocked") throw new HerdError("hire_blocked", "The hire is waiting on a decision; answer it with keys first.");
    if (this.state === "exited") throw new HerdError("hire_exited", "The hire has exited.");
    this.stabilizer.markPrompted();
    const bracketed = this.term.modes.bracketedPasteMode;
    this.pty.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text);
    await sleep(PROMPT_ENTER_DELAY_MS);
    this.pty.write("\r");
    if (!opts.wait) return this.state;

    const started = await this.waitFor((s) => s === "working" || s === "blocked" || s === "exited", PROMPT_START_TIMEOUT_MS);
    if (!started) throw new HerdError("prompt_stalled", "The hire didn't start working within 5 s of the prompt.");
    await this.waitFor((s) => s === "idle" || s === "done" || s === "blocked" || s === "exited", opts.timeoutMs ?? 30 * 60_000);
    return this.state;
  }

  /** Type a line as keystrokes (not a paste), then Enter: for harness commands such as /exit. */
  async typeLine(text: string): Promise<void> {
    if (this.state === "exited") return;
    this.pty.write(text);
    await sleep(PROMPT_ENTER_DELAY_MS);
    this.pty.write("\r");
  }

  /** Send named keys ("enter", "esc", "down", "ctrl+c") or literal text, in order. */
  keys(sequence: string[]): void {
    // Answering a question or typing counts as asking for work, same as a prompt.
    this.stabilizer.markPrompted();
    for (const k of sequence) this.pty.write(KEYS[k.toLowerCase()] ?? k);
  }

  /** A hire reporting its own state (over the mailbox or herd's API). */
  report(r: { state: SelfReport["state"]; source: string; seq: number; sessionId?: string; resumeArgs?: string[] }): boolean {
    if (r.sessionId) this.sessionId = r.sessionId;
    if (r.resumeArgs) this.resumeArgs = r.resumeArgs;
    const accepted = this.stabilizer.acceptReport({ state: r.state, source: r.source, seq: r.seq, at: Date.now() });
    if (accepted) this.tick();
    return accepted;
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  kill(): void {
    if (this.disposed) return;
    try {
      this.pty.kill();
    } catch {
      // already gone
    }
    this.stabilizer.markExited();
    this.emitState();
    this.dispose();
  }

  info(): HireInfo {
    return {
      id: this.id,
      label: this.label,
      harness: this.harness,
      argv: this.argv,
      cwd: this.cwd,
      pid: this.pid,
      state: this.state,
      startedAt: new Date(this.startedAt).toISOString(),
      lastOutputAt: this.lastOutputAt ? new Date(this.lastOutputAt).toISOString() : null,
      exitCode: this.exitCode,
      sessionId: this.sessionId,
      title: this.title,
    };
  }

  waitFor(predicate: (s: HireState) => boolean, timeoutMs: number): Promise<boolean> {
    if (predicate(this.state)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onState = (s: HireState) => {
        if (!predicate(s)) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("state", onState);
      };
      this.on("state", onState);
    });
  }

  private tick(): void {
    if (this.disposed) return;
    const before = this.state;
    this.stabilizer.observe({ now: Date.now(), rule: classify(this.rules, { lines: this.screen(), title: this.title }), lastOutputAt: this.lastOutputAt });
    if (this.state !== before) this.emitState();
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.tick();
      if (!this.disposed) this.schedule(this.stabilizer.confirming ? CONFIRM_TICK_MS : TICK_MS);
    }, ms);
  }

  private emitState(): void {
    this.emit("state", this.state);
  }

  /** node-pty's Windows backend keeps console handles open after the child exits; release them. */
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    setTimeout(() => this.term.dispose(), 0);
  }
}

export class HerdError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
