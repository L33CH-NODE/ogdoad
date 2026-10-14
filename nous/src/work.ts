// The work loop. A member is woken (a task given to it, a message, a mention, an answer, a decision,
// or a job it closed with its task still open) and a run waits for it. Its seat or live worker takes
// the run as a job through the mailbox, works with the run's own token, and closes the job.
//
// Better than the loop Ogdoad started with:
// - one run at a time per member, and the next one waits its turn without timing out behind a busy seat;
// - a lease that runs out puts the job back in the queue instead of failing the run;
// - a run's token is good only while the run is, and says exactly who's asking.

import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { CLOSED, NousError, sha256, type Engine, type Member, type WakeDetails, type WakeReason, type Who } from "./engine.js";
import { promptFor } from "./prompt.js";

export const PROTOCOL = "paperclip-live-agent/1";

/** Wake reasons in the words the old engine's hires know. */
export const COMPAT_REASON: Record<WakeReason, string> = {
  assigned: "issue_assigned",
  message: "issue_commented",
  mention: "issue_comment_mentioned",
  answer: "issue_interaction_answered",
  decision: "approval_resolved",
  unfinished: "issue_disposition_repair",
};

export interface Run {
  id: string; companyId: string; memberId: string; taskId: string | null; reason: WakeReason; wake: WakeDetails;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; jobId: string | null; leaseUntil: string | null; claims: number;
  summary: string | null; error: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
}

const run = (r: any): Run => ({
  id: r.id, companyId: r.company_id, memberId: r.member_id, taskId: r.task_id, reason: r.reason, wake: JSON.parse(r.wake), status: r.status,
  jobId: r.job_id, leaseUntil: r.lease_until, claims: r.claims, summary: r.summary, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const now = () => new Date().toISOString();
const LOG_KEEP = 64 * 1024;

export interface Job {
  jobId: string; protocol: string; runId: string; agentId: string; agentName: string; companyId: string; taskId: string | null;
  wakeReason: string; prompt: string; env: Record<string, string>; leaseSec: number;
}

export class Work {
  /** "ready:<memberId>" fires when a run is queued for that member (a long poll is waiting on it). */
  private readonly ready = new EventEmitter();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly engine: Engine, private readonly opts: { apiUrl: string; leaseSec?: number }) {
    this.ready.setMaxListeners(0);
    engine.waker = (memberId, taskId, reason, details) => this.wake(memberId, taskId, reason, details);
    this.sweeper = setInterval(() => this.sweep(), 2000);
    this.sweeper.unref();
  }

  private get db() {
    return this.engine.db;
  }

  private get leaseSec() {
    return this.opts.leaseSec ?? 120;
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  private changed(r: Run): void {
    this.engine.emit({ kind: "run", companyId: r.companyId, runId: r.id, memberId: r.memberId, taskId: r.taskId, status: r.status });
  }

  run(id: string): Run {
    const r = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    if (!r) throw new NousError(404, "not_found", "No such run.");
    return run(r);
  }

  /** The runs under way in a company (queued or running), newest first. */
  live(companyId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE company_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC").all(companyId) as any[]).map(run);
  }

  /**
   * Wake a member. A paused member isn't woken. A run already waiting for the same member and task
   * takes the newest reason instead of a second run starting.
   */
  wake(memberId: string, taskId: string | null, reason: WakeReason, details: WakeDetails = {}): Run | null {
    const m = this.engine.member(memberId);
    if (m.status === "paused" || m.status === "let_go") return null;
    const at = now();
    const waiting = this.db.prepare("SELECT * FROM runs WHERE member_id = ? AND status = 'queued' AND task_id IS ? ORDER BY created_at LIMIT 1").get(memberId, taskId) as any;
    let id: string;
    if (waiting) {
      id = waiting.id;
      this.db.prepare("UPDATE runs SET reason = ?, wake = ?, updated_at = ? WHERE id = ?").run(reason, JSON.stringify(details), at, id);
    } else {
      id = randomUUID();
      this.db.prepare("INSERT INTO runs (id, company_id, member_id, task_id, reason, wake, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, m.companyId, memberId, taskId, reason, JSON.stringify(details), at, at);
    }
    const r = this.run(id);
    this.changed(r);
    this.ready.emit(`ready:${memberId}`);
    return r;
  }

  /** Take the member's next run as a job, if it has none running: the run, its new token and job id. */
  private take(member: Member): { r: Run; token: string; jobId: string } | null {
    return this.db.transaction((): { r: Run; token: string; jobId: string } | null => {
      if (this.db.prepare("SELECT 1 FROM runs WHERE member_id = ? AND status = 'running'").get(member.id)) return null;
      const next = this.db.prepare("SELECT * FROM runs WHERE member_id = ? AND status = 'queued' ORDER BY created_at LIMIT 1").get(member.id) as any;
      if (!next) return null;
      const jobId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const at = new Date();
      this.db.prepare(`UPDATE runs SET status = 'running', job_id = ?, token_hash = ?, lease_until = ?, claims = claims + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`)
        .run(jobId, sha256(token), new Date(at.getTime() + this.leaseSec * 1000).toISOString(), at.toISOString(), at.toISOString(), next.id);
      this.db.prepare("INSERT INTO jobs (id, run_id, created_at) VALUES (?, ?, ?)").run(jobId, next.id, at.toISOString());
      this.db.prepare("UPDATE members SET status = 'working', updated_at = ? WHERE id = ? AND status = 'idle'").run(at.toISOString(), member.id);
      return { r: this.run(next.id), token, jobId };
    })();
  }

  /** The next job for a member, waiting up to waitSec for one to be queued. */
  async next(member: Member, waitSec: number): Promise<Job | null> {
    const deadline = Date.now() + Math.min(Math.max(waitSec, 0), 60) * 1000;
    for (;;) {
      const taken = this.take(member);
      if (taken) {
        this.changed(taken.r);
        return this.job(taken.r, member, taken.token, taken.jobId);
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.ready.off(`ready:${member.id}`, done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.ready.once(`ready:${member.id}`, done);
      });
    }
  }

  private job(r: Run, member: Member, token: string, jobId: string): Job {
    const env: Record<string, string> = {
      PAPERCLIP_API_URL: this.opts.apiUrl,
      PAPERCLIP_API_KEY: token,
      PAPERCLIP_RUN_ID: r.id,
      PAPERCLIP_AGENT_ID: member.id,
      PAPERCLIP_COMPANY_ID: member.companyId,
      PAPERCLIP_WAKE_REASON: COMPAT_REASON[r.reason],
    };
    if (r.taskId) env.PAPERCLIP_TASK_ID = r.taskId;
    if (r.wake.messageId) env.PAPERCLIP_WAKE_COMMENT_ID = r.wake.messageId;
    if (r.wake.approvalId) env.PAPERCLIP_APPROVAL_ID = r.wake.approvalId;
    if (r.wake.approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = r.wake.approvalStatus;
    return {
      jobId, protocol: PROTOCOL, runId: r.id, agentId: member.id, agentName: member.name, companyId: member.companyId, taskId: r.taskId,
      wakeReason: COMPAT_REASON[r.reason], prompt: promptFor(this.engine, r, member, this.opts.apiUrl), env, leaseSec: this.leaseSec,
    };
  }

  /** Who a run's token speaks for, while the run is running. */
  whoForToken(token: string): Who | null {
    const r = this.db.prepare("SELECT id, member_id, company_id FROM runs WHERE token_hash = ? AND status = 'running'").get(sha256(token)) as any;
    return r ? { kind: "member", memberId: r.member_id, companyId: r.company_id, runId: r.id } : null;
  }

  /**
   * A seat's call about a job it holds: heartbeat, log or done. Each one renews the lease. A settled job
   * stays settled; a job whose lease ran out (back in the queue) is lost to the old holder.
   */
  touch(member: Member, jobId: string, action: "heartbeat" | "log" | "done", body: any): { cancel: boolean; settled: boolean } {
    const j = this.db.prepare("SELECT j.run_id FROM jobs j JOIN runs r ON r.id = j.run_id WHERE j.id = ? AND r.member_id = ?").get(jobId, member.id) as { run_id: string } | undefined;
    if (!j) throw new NousError(404, "no_such_job", "No such job.");
    const r = this.run(j.run_id);
    if (["succeeded", "failed", "cancelled"].includes(r.status)) return { cancel: true, settled: true };
    if (r.status !== "running" || r.jobId !== jobId) throw new NousError(409, "lease_lost", "That job's lease ran out; it went back to the queue.");
    const at = now();
    this.db.prepare("UPDATE runs SET lease_until = ?, updated_at = ? WHERE id = ?").run(new Date(Date.now() + this.leaseSec * 1000).toISOString(), at, r.id);
    if (action === "log") {
      const text = typeof body?.text === "string" ? body.text : "";
      this.db.prepare("UPDATE runs SET log = substr(log || ?, -?) WHERE id = ?").run(text, LOG_KEEP, r.id);
      return { cancel: false, settled: false };
    }
    if (action === "heartbeat") return { cancel: false, settled: false };
    this.finish(r, body?.ok === true, body?.summary ?? null, body?.error ?? null);
    return { cancel: false, settled: true };
  }

  /** A run ends: its token stops working, its member is free, and an unfinished task brings it back. */
  private finish(r: Run, ok: boolean, summary: string | null, error: string | null): void {
    const at = now();
    this.db.prepare("UPDATE runs SET status = ?, summary = ?, error = ?, token_hash = NULL, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?")
      .run(ok ? "succeeded" : "failed", summary, ok ? null : (error ?? summary ?? "The member reported failure."), at, at, r.id);
    this.db.prepare("UPDATE members SET status = 'idle', updated_at = ? WHERE id = ? AND status = 'working'").run(at, r.memberId);
    this.changed(this.run(r.id));
    // A job closed with its task still in progress, held by that run: wake the member to finish it properly.
    if (r.taskId) {
      const t = this.engine.task(r.taskId);
      if (t.status === "in_progress" && t.assigneeId === r.memberId && t.heldByRun === r.id && !CLOSED.includes(t.status)) this.wake(r.memberId, r.taskId, "unfinished");
    }
    this.ready.emit(`ready:${r.memberId}`);
  }

  /** Leases that ran out: the job goes back in the queue for the member's next poll. */
  sweep(): void {
    const expired = this.db.prepare("SELECT * FROM runs WHERE status = 'running' AND lease_until < ?").all(now()) as any[];
    for (const row of expired) {
      this.db.prepare("UPDATE runs SET status = 'queued', job_id = NULL, token_hash = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").run(now(), row.id);
      this.db.prepare("UPDATE members SET status = 'idle', updated_at = ? WHERE id = ? AND status = 'working'").run(now(), row.member_id);
      this.changed(this.run(row.id));
      this.ready.emit(`ready:${row.member_id}`);
    }
  }
}
