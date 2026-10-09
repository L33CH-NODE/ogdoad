// Turns a stream of raw classifications into a steady hire state.
// Timings follow Herdr's, which were tuned against real harnesses:
// - new sessions get 3 s of grace (shown as "starting"), so a blank screen isn't read as idle;
// - working -> idle needs 3 agreeing checks at least 100 ms apart, capped at 700 ms, unless the
//   idle evidence is a rule match (visible idle chrome), which counts at once;
// - blocked only ever comes from a rule; an unrecognised prompt is idle, never blocked;
// - with no rule match, recent terminal output means working and silence means idle.
// "done" is idle-after-work that nobody has looked at yet; reading the hire acknowledges it.

import type { DetectedState, HireState, Rule } from "./rules.js";

export const STARTUP_GRACE_MS = 3000;
export const ACTIVITY_WINDOW_MS = 1200;
export const IDLE_CONFIRMATIONS = 3;
export const IDLE_CONFIRM_SPACING_MS = 100;
export const IDLE_CONFIRM_CAP_MS = 700;

export interface Observation {
  now: number;
  /** Highest-priority matching rule, if any. */
  rule: Rule | null;
  /** Time of the last byte the hire wrote. */
  lastOutputAt: number;
}

export interface SelfReport {
  state: DetectedState;
  source: string;
  seq: number;
  at: number;
}

export class Stabilizer {
  state: HireState = "starting";
  private idleSince: number | null = null;
  private idleChecks = 0;
  private lastIdleCheckAt = 0;
  private workedSinceSeen = false;
  private report: SelfReport | null = null;

  constructor(private readonly startedAt: number) {}

  /** A hire's own report of its state outranks screen reading, except a visible permission prompt. */
  acceptReport(report: SelfReport): boolean {
    if (this.report && report.seq <= this.report.seq) return false;
    this.report = report;
    return true;
  }

  /** Mark the current result as seen (someone read the screen), turning "done" back into "idle". */
  acknowledge(): void {
    this.workedSinceSeen = false;
    if (this.state === "done") this.state = "idle";
  }

  /** Feed one observation; returns the (possibly unchanged) state. */
  observe(o: Observation): HireState {
    if (this.state === "exited") return this.state;
    const raw = this.rawState(o);

    // Startup banners are output too; they are not work, so they don't count toward "done".
    if (o.now - this.startedAt < STARTUP_GRACE_MS && raw !== "blocked") return (this.state = "starting");

    if (raw !== "idle") {
      this.idleSince = null;
      this.idleChecks = 0;
      if (raw === "working") this.workedSinceSeen = true;
      return (this.state = raw);
    }

    // raw idle: settle it.
    const ruleSaysIdle = o.rule?.state === "idle";
    if (this.state === "idle" || this.state === "done" || this.state === "starting" || ruleSaysIdle) return this.settleIdle();

    if (this.idleSince === null) {
      this.idleSince = o.now;
      this.idleChecks = 1;
      this.lastIdleCheckAt = o.now;
      return this.state;
    }
    if (o.now - this.lastIdleCheckAt >= IDLE_CONFIRM_SPACING_MS) {
      this.idleChecks += 1;
      this.lastIdleCheckAt = o.now;
    }
    if (this.idleChecks >= IDLE_CONFIRMATIONS || o.now - this.idleSince >= IDLE_CONFIRM_CAP_MS) return this.settleIdle();
    return this.state;
  }

  /** True while an idle candidate is being confirmed, so the caller can tick faster. */
  get confirming(): boolean {
    return this.idleSince !== null && this.state !== "idle" && this.state !== "done";
  }

  markExited(): void {
    this.state = "exited";
  }

  private settleIdle(): HireState {
    this.idleSince = null;
    this.idleChecks = 0;
    return (this.state = this.workedSinceSeen ? "done" : "idle");
  }

  private rawState(o: Observation): DetectedState {
    if (o.rule?.state === "blocked") return "blocked";
    if (this.report) return this.report.state;
    if (o.rule) return o.rule.state;
    return o.now - o.lastOutputAt < ACTIVITY_WINDOW_MS ? "working" : "idle";
  }
}
