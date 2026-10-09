// A seat binds a herd hire to a Paperclip agent on the live-agent adapter. The bridge long-polls
// that agent's mailbox, hands each job to the hire's live session, keeps the lease alive, and
// closes the job when the hire reports back (or, as a fallback, when the hire settles).
// The mailbox key stays with herd; the hire only ever sees per-job run credentials.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Herd's own CLI, called by absolute path so hires don't need it on PATH. */
const HERD_CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

import type { Hire } from "./hire.js";

export interface MailboxJob {
  jobId: string;
  runId: string;
  agentId: string;
  agentName: string;
  companyId: string;
  taskId: string | null;
  wakeReason: string | null;
  prompt: string;
  env: Record<string, string>;
  leaseSec: number;
}

interface JobControl {
  cancel: boolean;
  settled: boolean;
}

/** How long after the hire settles herd waits for it to close the job itself before closing it. */
const SELF_CLOSE_GRACE_MS = 45_000;

export function mailboxKeyFor(agentId: string): string {
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(agentId)) throw new Error(`not an agent id: ${agentId}`);
  const home = process.env.PAPERCLIP_HOME?.trim() || join(homedir(), ".paperclip");
  return readFileSync(join(home, "live-agent", "keys", `${agentId}.key`), "utf8").trim();
}

class Mailbox {
  constructor(readonly baseUrl: string, private readonly key: string) {}

  private headers() {
    return { authorization: `Bearer ${this.key}`, "content-type": "application/json" };
  }

  async next(waitSec = 25): Promise<MailboxJob | null> {
    const res = await fetch(`${this.baseUrl}/v1/next?wait=${waitSec}`, { headers: this.headers(), signal: AbortSignal.timeout((waitSec + 15) * 1000) });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`mailbox /v1/next answered ${res.status}`);
    return (await res.json()) as MailboxJob;
  }

  async post(jobId: string, action: "heartbeat" | "log" | "done", body: unknown): Promise<JobControl | "lost"> {
    const res = await fetch(`${this.baseUrl}/v1/jobs/${jobId}/${action}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000) });
    if (res.status === 409) return "lost";
    if (!res.ok) throw new Error(`mailbox ${action} answered ${res.status}`);
    return (await res.json()) as JobControl;
  }
}

export interface SeatInfo {
  agentId: string;
  hireId: string;
  mailbox: string;
  currentJob: string | null;
  jobsHandled: number;
}

export class Seat {
  currentJob: MailboxJob | null = null;
  jobsHandled = 0;
  private stopped = false;
  private readonly mailbox: Mailbox;
  private readonly jobsDir: string;

  constructor(
    readonly agentId: string,
    readonly hire: Hire,
    mailboxUrl: string,
    private readonly log: (event: string, data: unknown) => void,
  ) {
    this.mailbox = new Mailbox(mailboxUrl.replace(/\/+$/, ""), mailboxKeyFor(agentId));
    this.jobsDir = join(hire.cwd, ".ogdoad", "jobs");
    mkdirSync(this.jobsDir, { recursive: true });
    hire.on("state", (s: string) => {
      if (s === "exited") this.stop();
    });
    void this.loop();
  }

  info(): SeatInfo {
    return { agentId: this.agentId, hireId: this.hire.id, mailbox: this.mailbox.baseUrl, currentJob: this.currentJob?.jobId ?? null, jobsHandled: this.jobsHandled };
  }

  stop(): void {
    this.stopped = true;
  }

  private stateNow(): string {
    return this.hire.state;
  }

  /** The hire (or the operator) closes the current job. */
  async close(jobId: string, outcome: { ok: boolean; summary?: string }): Promise<boolean> {
    if (this.currentJob?.jobId !== jobId) return false;
    const res = await this.mailbox.post(jobId, "done", outcome.ok ? { ok: true, summary: outcome.summary } : { ok: false, summary: outcome.summary, error: outcome.summary ?? "the seat reported failure" });
    this.finish(jobId, res === "lost" ? "lost" : outcome.ok ? "done" : "failed");
    return true;
  }

  private finish(jobId: string, how: string): void {
    if (this.currentJob?.jobId !== jobId) return;
    this.currentJob = null;
    this.jobsHandled += 1;
    this.log("seat_job_closed", { agentId: this.agentId, hireId: this.hire.id, jobId, how });
  }

  private async loop(): Promise<void> {
    let backoff = 2000;
    while (!this.stopped && this.hire.state !== "exited") {
      if (this.currentJob) {
        await sleep(1000);
        continue;
      }
      let job: MailboxJob | null;
      try {
        job = await this.mailbox.next(25);
        backoff = 2000;
      } catch (err) {
        this.log("seat_mailbox_unreachable", { agentId: this.agentId, error: (err as Error).message });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      if (job) await this.handle(job);
    }
  }

  private async handle(job: MailboxJob): Promise<void> {
    this.currentJob = job;
    const promptFile = join(this.jobsDir, `${job.jobId}.md`);
    const envFile = join(this.jobsDir, `${job.jobId}.env.json`);
    writeFileSync(promptFile, job.prompt, "utf8");
    writeFileSync(envFile, JSON.stringify(job.env, null, 2), { encoding: "utf8", mode: 0o600 });
    this.log("seat_job_received", { agentId: this.agentId, hireId: this.hire.id, jobId: job.jobId, taskId: job.taskId, wakeReason: job.wakeReason });

    const beat = setInterval(async () => {
      if (this.currentJob?.jobId !== job.jobId) return clearInterval(beat);
      try {
        const control = await this.mailbox.post(job.jobId, "heartbeat", {});
        if (control === "lost" || control.settled) {
          clearInterval(beat);
          this.finish(job.jobId, control === "lost" ? "lost" : "settled");
        } else if (control.cancel) {
          this.hire.keys(["esc"]);
          this.log("seat_job_cancel_requested", { jobId: job.jobId });
        }
      } catch {
        // transient; next beat retries
      }
    }, Math.max(5, job.leaseSec / 3) * 1000);

    // Wait for the hire to be free, then hand it the job.
    await this.hire.waitFor((s) => s === "idle" || s === "done" || s === "exited", 30 * 60_000);
    if (this.hire.state === "exited") return void this.close(job.jobId, { ok: false, summary: "the seat's session exited" });
    this.hire.read(1); // acknowledge any earlier result
    try {
      await this.hire.prompt(deliveryNote(job, promptFile, envFile));
    } catch (err) {
      return void this.close(job.jobId, { ok: false, summary: `couldn't deliver the job: ${(err as Error).message}` });
    }

    // Fallback close: if the hire settles and doesn't close the job itself, close it with its screen.
    await this.hire.waitFor((s) => s === "working" || s === "blocked", 10_000);
    while (this.currentJob?.jobId === job.jobId) {
      await this.hire.waitFor((s) => s === "done" || s === "idle" || s === "exited", 30 * 60_000);
      if (this.currentJob?.jobId !== job.jobId) break;
      await sleep(SELF_CLOSE_GRACE_MS);
      if (this.currentJob?.jobId !== job.jobId) break;
      // Re-read: the state changes while we wait, which TypeScript can't see through the await.
      const now = this.stateNow();
      if (now === "done" || now === "idle" || now === "exited") {
        const tail = this.hire.read(40).join("\n").trim().slice(-1500);
        await this.close(job.jobId, { ok: now !== "exited", summary: tail || "finished (no output captured)" });
      }
    }
    clearInterval(beat);
  }
}

/** What the hire sees for each job: short, with everything it needs to act and to report back. */
export function deliveryNote(job: MailboxJob, promptFile: string, envFile: string): string {
  const why = job.wakeReason ? ` (${job.wakeReason})` : "";
  const task = job.taskId ? ` on task ${job.taskId}` : "";
  return [
    `[Ogdoad job ${job.jobId}] New work for ${job.agentName}${task}${why}.`,
    `Read the job: ${promptFile}`,
    `This job's run credentials (PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID): ${envFile}`,
    `Do the work and reply on the task with those credentials. Then close the job:`,
    `  node "${HERD_CLI}" done ${job.jobId} --agent ${job.agentId} --summary "<one line>"`,
  ].join(" ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
