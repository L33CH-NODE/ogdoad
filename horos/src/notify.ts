// The operator's pulse: every error, status and decision Horos sees becomes a notification. All of
// them go into one feed (notifications.jsonl, the record the UI's bell and SOPHIA can read), and
// the ones that matter right now also pop up on the desktop. Status flips (working, idle) are too
// frequent to pop up one by one, so they arrive as a digest at most once per interval.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { HOROS_DIR } from "./paths.js";
import type { ToastFn } from "./toast.js";

export const NOTIFICATIONS_FILE = join(HOROS_DIR, "notifications.jsonl");

/** error: something broke. warn: something needs the operator, or went wrong and is being handled.
 *  info: something happened. pulse: a status change, digested. */
export type Level = "error" | "warn" | "info" | "pulse";

export interface Notification {
  id: number;
  at: string;
  level: Level;
  kind: string;
  title: string;
  body: string;
  hireId?: string;
  agentId?: string;
  jobId?: string;
}

export type NotificationInput = Omit<Notification, "id" | "at"> & {
  /** Same key within the window: recorded once, not repeated (a mailbox that stays down, say). */
  dedupeKey?: string;
  dedupeMs?: number;
};

export interface NotifierOptions {
  /** Feed file; omit for an in-memory feed (tests). */
  file?: string;
  toast?: ToastFn | null;
  pulseDigestMs?: number;
  /** Called for every notification recorded (Horos streams them to the UI). */
  onNotify?: (n: Notification) => void;
}

const KEEP = 500;
const TOAST_GAP_MS = 1500;

export class Notifier {
  private feed: Notification[] = [];
  private nextId = 1;
  private lastRead = 0;
  private readonly dedupe = new Map<string, number>();
  private toastQueue: Notification[] = [];
  private toastTimer: NodeJS.Timeout | null = null;
  private lastToastAt = 0;
  private readonly pulse = new Map<string, string>();
  private pulseTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: NotifierOptions = {}) {
    if (!opts.file) return;
    if (existsSync(opts.file)) {
      for (const line of readFileSync(opts.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.feed.push(JSON.parse(line));
        } catch {
          // a torn last line after a crash; skip it
        }
      }
      this.feed = this.feed.slice(-KEEP);
      this.nextId = (this.feed.at(-1)?.id ?? 0) + 1;
    }
    try {
      this.lastRead = Number(readFileSync(`${opts.file}.read`, "utf8")) || 0;
    } catch {
      this.lastRead = 0;
    }
  }

  push(input: NotificationInput): Notification | null {
    const now = Date.now();
    const { dedupeKey, dedupeMs, ...rest } = input;
    if (dedupeKey) {
      const until = this.dedupe.get(dedupeKey);
      if (until && until > now) return null;
      this.dedupe.set(dedupeKey, now + (dedupeMs ?? 10 * 60_000));
    }
    const n: Notification = { id: this.nextId++, at: new Date(now).toISOString(), ...rest };
    this.feed.push(n);
    if (this.feed.length > KEEP) this.feed.splice(0, this.feed.length - KEEP);
    if (this.opts.file) {
      mkdirSync(dirname(this.opts.file), { recursive: true });
      appendFileSync(this.opts.file, JSON.stringify(n) + "\n", "utf8");
    }
    this.opts.onNotify?.(n);
    if (n.level === "pulse") this.queuePulse(n);
    else this.queueToast(n);
    return n;
  }

  /** Forget a dedupe key, so the next notification with it is recorded (the mailbox came back). */
  clear(dedupeKey: string): boolean {
    return this.dedupe.delete(dedupeKey);
  }

  list(opts: { after?: number; limit?: number } = {}): Notification[] {
    const after = opts.after ?? 0;
    return this.feed.filter((n) => n.id > after).slice(-(opts.limit ?? 50));
  }

  unread(): number {
    return this.feed.filter((n) => n.id > this.lastRead && n.level !== "pulse").length;
  }

  markRead(upTo = this.nextId - 1): void {
    this.lastRead = Math.max(this.lastRead, upTo);
    if (this.opts.file) writeFileSync(`${this.opts.file}.read`, String(this.lastRead), "utf8");
  }

  close(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.toastTimer = this.pulseTimer = null;
  }

  private queueToast(n: Notification): void {
    if (!this.opts.toast) return;
    this.toastQueue.push(n);
    if (!this.toastTimer) this.toastTimer = setTimeout(() => this.flushToasts(), Math.max(0, this.lastToastAt + TOAST_GAP_MS - Date.now()));
  }

  /** One toast per gap; a burst becomes the worst of it plus a count, never a wall of popups. */
  private flushToasts(): void {
    this.toastTimer = null;
    const batch = this.toastQueue;
    this.toastQueue = [];
    if (!batch.length || !this.opts.toast) return;
    this.lastToastAt = Date.now();
    if (batch.length === 1) return this.opts.toast(batch[0].title, batch[0].body);
    const rank: Record<Level, number> = { error: 0, warn: 1, info: 2, pulse: 3 };
    const worst = [...batch].sort((a, b) => rank[a.level] - rank[b.level])[0];
    const others = batch.filter((n) => n !== worst).map((n) => n.title);
    this.opts.toast(worst.title, `${worst.body}\nAlso: ${others.join("; ")}`);
  }

  private queuePulse(n: Notification): void {
    if (!this.opts.toast || !this.opts.pulseDigestMs) return;
    this.pulse.set(n.hireId ?? n.title, n.title);
    if (!this.pulseTimer) this.pulseTimer = setTimeout(() => this.flushPulse(), this.opts.pulseDigestMs);
  }

  private flushPulse(): void {
    this.pulseTimer = null;
    if (!this.pulse.size || !this.opts.toast) return;
    const lines = [...this.pulse.values()];
    this.pulse.clear();
    this.opts.toast("Team pulse", lines.join(" · "));
  }
}
