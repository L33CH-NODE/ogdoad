// Horos's API: localhost only, every call carries the per-install token.
// Paperclip's local-trusted mode treats any loopback request as the operator, so Horos adds its own
// check: a process (or a web page) that can reach 127.0.0.1 still can't drive hires without the token.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HARNESSES, detect, resolveCommand } from "./harnesses.js";
import { Hire, HorosError, type HireSpec } from "./hire.js";
import { Notifier, type NotificationInput } from "./notify.js";
import { planRestart } from "./restart.js";
import { ROSTER_FILE, loadRoster, resumeArgsFor, saveRoster, type RosterEntry } from "./roster.js";
import type { HireState } from "./rules.js";
import { Seat } from "./seat.js";

const DEFAULT_MAILBOX = process.env.LIVE_AGENT_MAILBOX ?? "http://127.0.0.1:3199";

export interface HorosServerOptions {
  port: number;
  host?: string;
  token: string;
  /** Called once Horos has stopped (after POST /v1/shutdown). */
  onShutdown?: () => void;
}

interface SpawnBody {
  harness: string;
  args?: string[];
  command?: string;
  cwd: string;
  label?: string;
  env?: Record<string, string>;
  /** Text to paste as the first prompt once the hire is ready (a role brief, for example). */
  brief?: string;
  /** Keep this hire: Horos brings it back after a restart and when its session ends on its own. */
  keep?: boolean;
  /** "server": a service the hires depend on (the Ogdoad server). Started first, stopped last, with Ctrl+C. */
  role?: "server";
  /** For a server: the URL that answers 200 once it is up. */
  health?: string;
  /** For a server: start only when a hire needs what it provides; rest when unused. */
  onDemand?: boolean;
  /** For a server: the capability it provides (e.g. "ollama"). */
  provides?: string;
  /** For a hire: capabilities that must be running before it starts. */
  needs?: string[];
}

/** Loaded into node servers so Horos can ask for their own graceful shutdown (see hooks/graceful-hook.cjs). */
const GRACEFUL_HOOK = fileURLToPath(new URL("../hooks/graceful-hook.cjs", import.meta.url)).replace(/\\/g, "/");

interface LaunchSpec {
  id?: string;
  /** A server: node servers get the graceful-stop hook. */
  server?: boolean;
  harness: string;
  command?: string;
  args: string[];
  cwd: string;
  label?: string;
  env?: Record<string, string>;
}

export interface HorosOptions {
  rosterFile?: string;
  log?: (event: string, data: unknown) => void;
  /** Where the operator hears about everything; defaults to a quiet in-memory feed. */
  notifier?: Notifier;
  /** How long an on-demand server stays up after the last hire that needed it has gone. */
  onDemandIdleMs?: number;
}

const STATE_WORDS: Partial<Record<HireState, string>> = { working: "working", idle: "idle", done: "finished, result unread" };

export class Horos {
  readonly hires = new Map<string, Hire>();
  /** Seats by Paperclip agent id. */
  readonly seats = new Map<string, Seat>();
  readonly notifier: Notifier;
  private readonly subscribers = new Set<ServerResponse>();
  private roster: RosterEntry[];
  /** Hires the operator let go of: their exit is expected, never restarted. */
  private readonly released = new WeakSet<Hire>();
  private readonly exitHandled = new WeakSet<Hire>();
  private readonly resumed = new WeakSet<Hire>();
  private readonly restarts = new Map<string, number[]>();
  private readonly pendingRestart = new Map<string, NodeJS.Timeout>();
  /** Servers that got the graceful-stop hook (node servers). */
  private readonly hooked = new Set<string>();
  /** On-demand servers being started, by capability, so concurrent needs share one start. */
  private readonly starting = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /** Sessions Horos stopped on purpose (an unused on-demand server): their exit isn't a crash. */
  private readonly rested = new WeakSet<Hire>();
  /** Needs of hires that aren't on the roster. */
  private readonly spawnNeeds = new Map<string, string[]>();
  private shuttingDown = false;

  constructor(private readonly opts: HorosOptions = {}) {
    this.roster = loadRoster(opts.rosterFile);
    this.notifier = opts.notifier ?? new Notifier();
  }

  notify(input: NotificationInput): void {
    const n = this.notifier.push(input);
    if (n) this.broadcast("notification", n);
  }

  /** Bind a hire to a Paperclip agent on the live-agent adapter, so its jobs flow into the session. */
  bindSeat(agentId: string, hireId: string, mailbox = DEFAULT_MAILBOX): Seat {
    const hire = this.hires.get(hireId) ?? null;
    const entry = this.roster.find((e) => e.id === hireId);
    if (!hire && !entry) throw new HorosError("no_such_hire", `No hire ${hireId}.`);
    this.seats.get(agentId)?.stop();
    const seat = new Seat({
      agentId, hireId, hire: hire && hire.state !== "exited" ? hire : null, cwd: hire?.cwd ?? entry!.cwd, mailboxUrl: mailbox,
      log: (event, data) => this.seatEvent(event, data as Record<string, any>),
      // A kept hire's seat outlives its sessions: work for it starts it again.
      wake: entry ? () => this.wake(hireId, "work") : undefined,
    });
    this.seats.set(agentId, seat);
    this.updateEntry(hireId, (e) => (e.seat = { agentId, mailbox: mailbox === DEFAULT_MAILBOX ? undefined : mailbox }));
    this.broadcast("seat_bound", seat.info());
    return seat;
  }

  unbindSeat(agentId: string): void {
    const seat = this.seats.get(agentId);
    if (!seat) return;
    seat.stop();
    this.seats.delete(agentId);
    this.updateEntry(seat.hireId, (e) => delete e.seat);
  }

  spawn(body: SpawnBody): Hire {
    const hire = this.launch({ server: body.role === "server", harness: body.harness, command: body.command, args: body.args ?? [], cwd: body.cwd, label: body.label, env: body.env });
    if (body.keep) {
      const args = body.args ?? [];
      this.roster.push({
        id: hire.id, harness: hire.harness, command: body.command, cwd: body.cwd, label: body.label, env: body.env, args,
        resumeArgs: resumeArgsFor(harnessSpec(hire.harness)?.resumeArgs, args), brief: body.brief, keptAt: new Date().toISOString(),
        ...(body.role === "server" ? { role: "server" as const, health: body.health, onDemand: body.onDemand || undefined, provides: body.provides } : {}),
        ...(body.needs?.length ? { needs: body.needs } : {}),
      });
      this.saveRoster();
    }
    if (body.needs?.length) this.spawnNeeds.set(hire.id, body.needs);
    if (body.brief) this.deliverBrief(hire, body.brief);
    return hire;
  }

  /** Put an on-demand server on the roster without starting it: it starts when a hire needs it. */
  register(body: SpawnBody): RosterEntry {
    if (body.role !== "server" || !body.onDemand || !body.provides) throw new HorosError("bad_request", "Only on-demand servers (role server, onDemand, provides) can be registered without starting.");
    const entry: RosterEntry = {
      id: randomUUID().slice(0, 8), harness: harnessSpec(body.harness)?.id ?? "generic", command: body.command, cwd: body.cwd, label: body.label, env: body.env,
      args: body.args ?? [], resumeArgs: null, keptAt: new Date().toISOString(), role: "server", health: body.health, onDemand: true, provides: body.provides,
    };
    this.roster.push(entry);
    this.saveRoster();
    this.notify({ level: "info", kind: "server_registered", title: `${entry.label ?? entry.id} is on call`, body: `It provides "${entry.provides}" and starts when a hire needs it.`, hireId: entry.id });
    return entry;
  }

  /** Let a hire go: stop it, unbind its seat, and drop it from the roster. */
  release(hireId: string): void {
    const hire = this.hires.get(hireId);
    for (const seat of [...this.seats.values()]) if (seat.hireId === hireId) this.unbindSeat(seat.agentId);
    this.cancelRestart(hireId);
    if (hire) {
      this.released.add(hire);
      hire.kill();
      this.hires.delete(hireId);
    }
    if (this.roster.some((e) => e.id === hireId)) {
      this.roster = this.roster.filter((e) => e.id !== hireId);
      this.saveRoster();
      this.notify({ level: "info", kind: "hire_released", title: `${hire?.label ?? hireId} was let go`, body: "Stopped and taken off the roster.", hireId });
    }
    this.scheduleIdleStops();
  }

  /** A hire told Horos its session id: record how to resume it. */
  noteSession(hire: Hire): void {
    if (!hire.sessionId && !hire.resumeArgs) return;
    this.updateEntry(hire.id, (e) => (e.resumeArgs = hire.resumeArgs ?? resumeArgsFor(harnessSpec(e.harness)?.resumeArgs, e.args, hire.sessionId)));
  }

  /** The kept hires, without their briefs and env (the roster file has those). */
  listRoster() {
    return this.roster.map(({ brief: _brief, env: _env, ...e }) => {
      const hire = this.hires.get(e.id);
      return { ...e, running: !!hire && hire.state !== "exited", resumable: e.resumeArgs !== null };
    });
  }

  /** Start a resting (or crashed) kept hire now. Returns the live session. */
  async wake(hireId: string, why: "work" | "operator"): Promise<Hire | null> {
    const live = this.hires.get(hireId);
    if (live && live.state !== "exited") return live;
    const entry = this.roster.find((e) => e.id === hireId);
    if (!entry || this.shuttingDown) return null;
    this.cancelRestart(hireId);
    try {
      await this.ensureNeeds(this.needsOf(entry), entry.label ?? hireId);
      return this.revive(entry, false, why === "work" ? "woke for new work" : "started by you");
    } catch (err) {
      this.notify({ level: "error", kind: "wake_failed", title: `${entry.label ?? hireId} couldn't start`, body: (err as Error).message, hireId });
      return null;
    }
  }

  /** On horos start: servers first (and up), then every kept hire, resumed where possible, with its seat. */
  async restore(): Promise<void> {
    const back: string[] = [];
    const resting: string[] = [];
    const servers = this.roster.filter((e) => e.role === "server");
    const others = this.roster.filter((e) => e.role !== "server");
    // Servers always come up when Horos starts, even after a crash loop: starting Ogdoad means wanting them.
    for (const entry of servers) {
      if (this.hires.has(entry.id) || entry.onDemand) continue;
      const name = entry.label ?? entry.id;
      try {
        this.revive(entry, false, "started", { quiet: true });
        if (entry.health && !(await waitHealthy(entry.health, 180_000))) {
          this.notify({ level: "error", kind: "server_not_up", title: `${name} isn't answering`, body: `It started but ${entry.health} didn't answer within 3 minutes. See it with: horos screen ${entry.id}`, hireId: entry.id });
        }
        back.push(name);
      } catch (err) {
        this.notify({ level: "error", kind: "restore_failed", title: `${name} couldn't be started`, body: (err as Error).message, hireId: entry.id });
      }
    }
    for (const entry of others) {
      if (this.hires.has(entry.id)) continue;
      const name = entry.label ?? entry.id;
      try {
        if (entry.dormant) {
          // Resting hires stay down; their seats listen so work can start them.
          if (entry.seat) this.bindSeat(entry.seat.agentId, entry.id, entry.seat.mailbox);
          resting.push(name);
        } else {
          await this.ensureNeeds(this.needsOf(entry), name);
          this.revive(entry, false, "back after Horos restarted", { quiet: true });
          back.push(name);
        }
      } catch (err) {
        this.notify({ level: "error", kind: "restore_failed", title: `${name} couldn't be brought back`, body: (err as Error).message, hireId: entry.id });
      }
      await sleep(500);
    }
    const parts = [back.length ? `Back: ${back.join(", ")}.` : "", resting.length ? `Resting until work arrives: ${resting.join(", ")}.` : ""].filter(Boolean);
    this.notify({ level: "info", kind: "horos_started", title: "Horos is running", body: parts.join(" ") || "No kept hires yet." });
  }

  /**
   * Stop a server through its own ordered shutdown: the stop file (node servers, via the hook), then
   * Ctrl+C, and only then a kill. Returns true when it had to be killed.
   */
  async stopServer(server: Hire, timeoutMs: number): Promise<boolean> {
    if (server.state === "exited") return false;
    if (this.hooked.has(server.id)) {
      writeFileSync(this.stopFileFor(server.id), new Date().toISOString(), "utf8");
      if (await server.waitFor((s) => s === "exited", timeoutMs)) return false;
    }
    server.keys(["ctrl+c"]);
    if (await server.waitFor((s) => s === "exited", this.hooked.has(server.id) ? 10_000 : timeoutMs)) return false;
    server.kill();
    this.notify({ level: "error", kind: "server_forced", title: `${server.label} had to be killed`, body: "It didn't finish its own shutdown in time. Its database recovers on the next start; check: horos screen " + server.id, hireId: server.id });
    return true;
  }

  /** Stop at once, except servers, which still get their own ordered shutdown (so no database is killed). */
  async quickShutdown(serverTimeoutMs = 120_000): Promise<void> {
    this.shuttingDown = true;
    for (const id of this.pendingRestart.keys()) this.cancelRestart(id);
    for (const seat of this.seats.values()) seat.stop();
    const isServer = (h: Hire) => this.roster.some((e) => e.id === h.id && e.role === "server");
    for (const hire of this.hires.values()) if (!isServer(hire)) hire.kill();
    await Promise.all([...this.hires.values()].filter(isServer).map((h) => this.stopServer(h, serverTimeoutMs)));
    this.notifier.close();
  }

  /** What a hire needs running first: its own declared needs plus its harness's. */
  needsOf(entry: { harness: string; needs?: string[] }): string[] {
    return [...new Set([...(entry.needs ?? []), ...(harnessSpec(entry.harness)?.needs ?? [])])];
  }

  /** Start (or find already running) whatever provides each capability, and wait until it answers. */
  async ensureNeeds(needs: string[], forLabel: string): Promise<void> {
    for (const cap of needs) await this.ensureServer(cap, forLabel);
  }

  private async ensureServer(cap: string, forLabel: string): Promise<void> {
    const entry = this.roster.find((e) => e.role === "server" && e.provides === cap);
    if (!entry) throw new HorosError("no_provider", `Nothing on the roster provides "${cap}" for ${forLabel}.`);
    const idle = this.idleTimers.get(entry.id);
    if (idle) clearTimeout(idle);
    this.idleTimers.delete(entry.id);
    // Already answering (ours, or started outside Horos)?
    if (entry.health && (await isHealthy(entry.health))) return;
    const pending = this.starting.get(cap);
    if (pending) return pending;
    const start = (async () => {
      const live = this.hires.get(entry.id);
      if (!live || live.state === "exited") this.revive(entry, false, `started for ${forLabel}`);
      if (entry.health && !(await waitHealthy(entry.health, 180_000))) {
        throw new HorosError("provider_not_up", `${entry.label ?? cap} didn't answer at ${entry.health} within 3 minutes.`);
      }
    })();
    this.starting.set(cap, start);
    try {
      await start;
    } finally {
      this.starting.delete(cap);
    }
  }

  /** Rest any on-demand server that no live hire needs, after the idle grace. */
  private scheduleIdleStops(): void {
    if (this.shuttingDown) return;
    for (const entry of this.roster) {
      if (entry.role !== "server" || !entry.onDemand || !entry.provides || this.idleTimers.has(entry.id)) continue;
      const server = this.hires.get(entry.id);
      if (!server || server.state === "exited" || this.inUse(entry.provides)) continue;
      this.idleTimers.set(entry.id, setTimeout(() => {
        this.idleTimers.delete(entry.id);
        const now = this.hires.get(entry.id);
        if (this.shuttingDown || !now || now.state === "exited" || this.inUse(entry.provides!)) return;
        this.rested.add(now);
        void this.stopServer(now, 60_000);
      }, this.opts.onDemandIdleMs ?? 10 * 60_000));
    }
  }

  private inUse(cap: string): boolean {
    return [...this.hires.values()].some((h) => {
      if (h.state === "exited") return false;
      const e = this.roster.find((r) => r.id === h.id);
      if (e?.role === "server") return false;
      return this.needsOf(e ?? { harness: h.harness, needs: this.spawnNeeds.get(h.id) }).includes(cap);
    });
  }

  private stopFileFor(id: string): string {
    return join(dirname(this.opts.rosterFile ?? ROSTER_FILE), `stop-${id}`);
  }

  /** Stop every hire at once, without letting any go: they come back on the next start. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const id of this.pendingRestart.keys()) this.cancelRestart(id);
    for (const seat of this.seats.values()) seat.stop();
    for (const hire of this.hires.values()) hire.kill();
    this.notifier.close();
  }

  /**
   * The operator's graceful shutdown: no new work is taken, running jobs finish and save, each hire
   * quits through its own exit command (so the harness saves its session), and only then does
   * anything get stopped. Kept hires stay on the roster and come back on the next start.
   */
  async gracefulShutdown(opts: { workTimeoutMs?: number; exitTimeoutMs?: number; serverTimeoutMs?: number } = {}): Promise<void> {
    const workTimeout = opts.workTimeoutMs ?? 15 * 60_000;
    const exitTimeout = opts.exitTimeoutMs ?? 20_000;
    this.shuttingDown = true;
    for (const id of this.pendingRestart.keys()) this.cancelRestart(id);
    const isServer = (h: Hire) => this.roster.some((e) => e.id === h.id && e.role === "server");
    const live = () => [...this.hires.values()].filter((h) => h.state !== "exited" && !isServer(h));
    const liveServers = () => [...this.hires.values()].filter((h) => h.state !== "exited" && isServer(h));
    this.notify({ level: "info", kind: "shutdown_started", title: "Shutting down", body: `Letting running work finish, then closing ${live().length} session(s) cleanly${liveServers().length ? ", then the server" : ""}.` });

    // 1. Finish the jobs in hand; take no new ones.
    const drained = await Promise.all([...this.seats.values()].map((s) => s.drain(workTimeout)));
    if (drained.includes(false)) this.notify({ level: "warn", kind: "shutdown_job_unfinished", title: "A job didn't finish in time", body: "Shutting down anyway; that job will be retried when Ogdoad is back." });

    // 2. Let each hire come to rest (a hire waiting on a decision holds the shutdown until answered or timed out).
    await Promise.all(live().map(async (hire) => {
      if (hire.state === "blocked") this.notify({ level: "warn", kind: "shutdown_waiting", title: `Shutdown is waiting on ${hire.label}`, body: "It's waiting on a decision. Answer it, or it will be closed when the wait runs out.", hireId: hire.id });
      await hire.waitFor((s) => s === "idle" || s === "done" || s === "exited", workTimeout);
    }));

    // 3. Quit each through its own exit command, so its session is saved; stop what won't quit.
    await Promise.all(live().map(async (hire) => {
      const line = harnessSpec(hire.harness)?.exitLine;
      if (line) await hire.typeLine(line);
      else hire.keys(["ctrl+c", "ctrl+c"]);
      if (!(await hire.waitFor((s) => s === "exited", exitTimeout))) hire.kill();
    }));
    for (const seat of this.seats.values()) seat.stop();

    // 4. Servers last, once nothing depends on them: Ctrl+C runs their own ordered shutdown
    //    (the Ogdoad server drains its runs, then stops Postgres cleanly).
    const forced = (await Promise.all(liveServers().map((server) => this.stopServer(server, opts.serverTimeoutMs ?? 120_000)))).includes(true);
    this.notify({ level: forced ? "warn" : "info", kind: "shutdown_done", title: "Ogdoad is shut down", body: forced ? "Every session closed; one server had to be killed." : "Every session and server closed cleanly. They come back on the next start." });
    await sleep(2000); // let the last toast go out
    this.notifier.close();
  }

  private revive(entry: RosterEntry, fresh: boolean, why: string, opts: { quiet?: boolean } = {}): Hire {
    const resume = !fresh && entry.resumeArgs !== null;
    if (fresh) this.renewSession(entry);
    if (entry.dormant) {
      entry.dormant = false;
      this.saveRoster();
    }
    const hire = this.launch({ id: entry.id, server: entry.role === "server", harness: entry.harness, command: entry.command, args: resume ? entry.resumeArgs! : entry.args, cwd: entry.cwd, label: entry.label, env: entry.env });
    if (resume) this.resumed.add(hire);
    else if (entry.brief) this.deliverBrief(hire, entry.brief);
    if (entry.seat) {
      const seat = this.seats.get(entry.seat.agentId);
      if (seat && !seat.stopped) seat.attach(hire);
      else this.bindSeat(entry.seat.agentId, hire.id, entry.seat.mailbox);
    }
    this.broadcast("hire_restored", { id: hire.id, label: hire.label, resumed: resume });
    if (!opts.quiet) {
      const how = resume ? "Resumed its session." : "Started a fresh session and re-sent its brief.";
      this.notify({ level: "info", kind: "hire_back", title: `${hire.label} ${why}`, body: how, hireId: hire.id });
    }
    return hire;
  }

  /** A fresh start can't reuse the old session id (the harness would refuse it), so mint a new one. */
  private renewSession(entry: RosterEntry): void {
    const i = entry.args.indexOf("--session-id");
    if (i < 0) return;
    entry.args = [...entry.args];
    entry.args[i + 1] = randomUUID();
    entry.resumeArgs = resumeArgsFor(harnessSpec(entry.harness)?.resumeArgs, entry.args);
    this.saveRoster();
  }

  private launch(o: LaunchSpec): Hire {
    const spec = harnessSpec(o.harness);
    const command = o.command ?? spec?.commands[0];
    if (!command) throw new HorosError("unknown_harness", `Unknown harness "${o.harness}" and no command given.`);
    const resolved = resolveCommand(command);
    if (!resolved) throw new HorosError("not_installed", `"${command}" isn't on PATH.`);
    mkdirSync(o.cwd, { recursive: true });

    const id = o.id ?? randomUUID().slice(0, 8);
    let env = o.env;
    if (o.server && /^node(\.exe)?$/i.test(basename(resolved.path))) {
      // Forward slashes: NODE_OPTIONS treats backslashes inside quotes as escapes.
      const require = GRACEFUL_HOOK.includes(" ") ? `--require "${GRACEFUL_HOOK}"` : `--require ${GRACEFUL_HOOK}`;
      env = { ...env, NODE_OPTIONS: [process.env.NODE_OPTIONS, env?.NODE_OPTIONS, require].filter(Boolean).join(" "), OGDOAD_STOP_FILE: this.stopFileFor(id) };
      this.hooked.add(id);
    }

    const hireSpec: HireSpec = {
      id,
      harness: spec?.id ?? "generic",
      file: resolved.file,
      args: [...resolved.prefix, ...o.args],
      cwd: o.cwd,
      env,
      label: o.label,
    };
    const hire = new Hire(hireSpec);
    this.hires.set(hire.id, hire);
    hire.on("state", (state: HireState) => {
      this.broadcast("status_changed", { id: hire.id, label: hire.label, state });
      if (state === "exited") return this.onExit(hire);
      // A server's log scrolling isn't news; only its exits (and failures to come up) are.
      if (this.roster.some((e) => e.id === hire.id && e.role === "server")) return;
      if (state === "blocked") {
        this.notify({ level: "warn", kind: "needs_you", title: `${hire.label} needs you`, body: `It's waiting on a decision. See it with: horos screen ${hire.id}`, hireId: hire.id, dedupeKey: `blocked:${hire.id}`, dedupeMs: 5_000 });
      } else if (STATE_WORDS[state]) {
        this.notify({ level: "pulse", kind: "status", title: `${hire.label} ${STATE_WORDS[state]}`, body: "", hireId: hire.id });
      }
    });
    this.broadcast("hire_spawned", hire.info());
    return hire;
  }

  private onExit(hire: Hire): void {
    if (this.exitHandled.has(hire)) return;
    this.exitHandled.add(hire);
    // A server's last words are the only record of why it stopped; keep them in Horos's log.
    if (this.roster.some((e) => e.id === hire.id && e.role === "server")) {
      this.opts.log?.("server_exit_screen", { id: hire.id, label: hire.label, exitCode: hire.exitCode, tail: hire.read(2000, false) });
    }
    if (this.shuttingDown || this.released.has(hire) || this.hires.get(hire.id) !== hire) return;
    this.scheduleIdleStops();
    if (this.rested.has(hire)) {
      this.notify({ level: "info", kind: "server_rested", title: `${hire.label} is resting`, body: "Nothing needed it any more. It starts again when a hire needs it.", hireId: hire.id });
      return;
    }
    const entry = this.roster.find((e) => e.id === hire.id);
    const code = hire.exitCode === null ? "killed" : `exit ${hire.exitCode}`;
    if (!entry) {
      this.notify({ level: hire.exitCode === 0 ? "info" : "warn", kind: "hire_exited", title: `${hire.label} exited`, body: `Its session ended (${code}). It isn't kept, so it stays down.`, hireId: hire.id });
      return;
    }
    // A provider whose port is already served by someone else (WSL's own systemd Ollama, say) exits at
    // once with "address in use". That isn't a crash: what hires need is up.
    if (entry.role === "server" && entry.provides && entry.health) {
      void isHealthy(entry.health).then((up) => {
        if (up) this.notify({ level: "info", kind: "served_elsewhere", title: `${hire.label} is already served`, body: `Something else answers at ${entry.health}, so Horos uses that instead of running its own.`, hireId: hire.id });
        else this.planExit(hire, entry, code);
      });
      return;
    }
    this.planExit(hire, entry, code);
  }

  /** A kept hire's session ended on its own: rest it or bring it back, per planRestart, and say so. */
  private planExit(hire: Hire, entry: RosterEntry, code: string): void {
    const history = this.restarts.get(hire.id) ?? [];
    const plan = planRestart({ exitCode: hire.exitCode, ranForMs: Date.now() - hire.startedAt, recentRestarts: history, wasResume: this.resumed.has(hire) });
    if (plan.action === "rest") {
      entry.dormant = true;
      this.saveRoster();
      const wakes = entry.seat ? "It starts again when a task is assigned to it." : `Start it again with: horos wake ${hire.id}`;
      if (plan.why === "signed_off") {
        this.notify({ level: "info", kind: "hire_signed_off", title: `${hire.label} signed off`, body: `It exited cleanly and is resting. ${wakes}`, hireId: hire.id });
      } else {
        this.notify({ level: "error", kind: "hire_down", title: `${hire.label} is down`, body: `It crashed ${history.length + 1} times in 10 minutes (last: ${code}), so Horos stopped restarting it. ${wakes}`, hireId: hire.id });
      }
      return;
    }

    this.restarts.set(hire.id, [...history, Date.now()]);
    const inSec = Math.round(plan.delayMs / 1000);
    const body = plan.fresh
      ? `Its resumed session died within 20 s (${code}), so it starts a fresh session in ${inSec} s. Its earlier conversation isn't carried over; its brief is re-sent.`
      : `Its session ended unexpectedly (${code}). Restarting it in ${inSec} s, resuming where it was.`;
    this.notify({ level: plan.fresh ? "error" : "warn", kind: plan.fresh ? "hire_resume_failed" : "hire_restarting", title: plan.fresh ? `${hire.label} couldn't resume` : `${hire.label} stopped`, body, hireId: hire.id });
    this.pendingRestart.set(hire.id, setTimeout(() => {
      this.pendingRestart.delete(hire.id);
      // Still ours to bring back? The operator may have let it go, or Horos may be stopping.
      if (this.shuttingDown || this.hires.get(hire.id) !== hire || !this.roster.includes(entry)) return;
      void this.ensureNeeds(this.needsOf(entry), hire.label)
        .then(() => this.revive(entry, plan.fresh, "is back"))
        .catch((err) => this.notify({ level: "error", kind: "restore_failed", title: `${hire.label} couldn't be restarted`, body: (err as Error).message, hireId: hire.id }));
    }, plan.delayMs));
  }

  private cancelRestart(hireId: string): void {
    const timer = this.pendingRestart.get(hireId);
    if (timer) clearTimeout(timer);
    this.pendingRestart.delete(hireId);
  }

  /** Seat events: streamed as they are, and turned into notifications for the operator. */
  private seatEvent(event: string, d: Record<string, any>): void {
    this.broadcast(event, d);
    const who = this.hires.get(d.hireId)?.label ?? d.agentName ?? "A seat";
    const refs = { hireId: d.hireId, agentId: d.agentId, jobId: d.jobId };
    switch (event) {
      case "seat_job_received":
        this.notify({ level: "info", kind: "job_started", title: `${who} picked up work`, body: d.wakeReason ? `Reason: ${d.wakeReason}.` : "A new job arrived.", ...refs });
        break;
      case "seat_job_closed":
        if (d.how === "done" || d.how === "settled") this.notify({ level: "info", kind: "job_done", title: `${who} finished a job`, body: "Closed and reported back to Ogdoad.", ...refs });
        else if (d.how === "lost") this.notify({ level: "warn", kind: "job_lost", title: `${who} lost a job`, body: "Its lease ran out before it reported back. Ogdoad will retry the work.", ...refs });
        else this.notify({ level: "error", kind: "job_failed", title: `${who}'s job failed`, body: d.summary ? String(d.summary) : "The seat reported a failure.", ...refs });
        break;
      case "seat_job_cancel_requested":
        this.notify({ level: "info", kind: "job_cancelled", title: `${who}'s job was cancelled`, body: "Horos pressed Esc in its session.", ...refs });
        break;
      case "seat_mailbox_unreachable":
        this.notify({ level: "error", kind: "mailbox_down", title: `Can't reach ${who}'s job mailbox`, body: `${d.error ?? "No answer"}. Is Ogdoad running? Horos keeps retrying.`, ...refs, dedupeKey: `mailbox:${d.agentId}`, dedupeMs: 60 * 60_000 });
        break;
      case "seat_mailbox_reachable":
        if (this.notifier.clear(`mailbox:${d.agentId}`)) this.notify({ level: "info", kind: "mailbox_back", title: `${who}'s job mailbox is back`, body: "Jobs flow again.", ...refs });
        break;
    }
  }

  private updateEntry(hireId: string, change: (e: RosterEntry) => void): void {
    const entry = this.roster.find((e) => e.id === hireId);
    if (!entry) return;
    change(entry);
    this.saveRoster();
  }

  private saveRoster(): void {
    saveRoster(this.roster, this.opts.rosterFile);
  }

  /** Paste the brief once the harness has finished starting up and is idle at its prompt. */
  private deliverBrief(hire: Hire, brief: string): void {
    hire.briefing = (async () => {
      const ready = await hire.waitFor((s) => s === "idle" || s === "done" || s === "exited", 90_000);
      if (!ready || hire.state === "exited") {
        this.notify({ level: "error", kind: "brief_failed", title: `${hire.label} didn't get its brief`, body: ready ? "It exited before it was ready." : "It wasn't ready within 90 s.", hireId: hire.id });
        return;
      }
      hire.read(1); // acknowledge any startup "done"
      try {
        await hire.prompt(brief);
        this.broadcast("brief_delivered", { id: hire.id });
      } catch (err) {
        this.notify({ level: "error", kind: "brief_failed", title: `${hire.label} didn't get its brief`, body: (err as Error).message, hireId: hire.id });
      }
    })();
  }

  broadcast(event: string, data: unknown): void {
    this.opts.log?.(event, data);
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.subscribers) res.write(frame);
  }

  subscribe(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: snapshot\ndata: ${JSON.stringify([...this.hires.values()].map((h) => h.info()))}\n\n`);
    this.subscribers.add(res);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    res.on("close", () => {
      clearInterval(keepAlive);
      this.subscribers.delete(res);
    });
  }
}

function harnessSpec(id: string) {
  return HARNESSES.find((h) => h.id === id);
}

/** One health check: does the URL answer 2xx right now? */
async function isHealthy(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** Poll a health URL until it answers 2xx, or give up after timeoutMs. */
async function waitHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tokenMatches(given: string | null, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HorosError("too_large", "Request body over 1 MB.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HorosError("bad_json", "Request body isn't valid JSON.");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startServer(horos: Horos, opts: HorosServerOptions) {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      // Browsers attach Origin; only same-machine pages may call, and they still need the token.
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: "origin_not_allowed" });

      if (url.pathname === "/v1/health") return send(res, 200, { ok: true, protocol: "horos/1", hires: horos.hires.size });

      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
      // EventSource can't set headers, so the event stream also accepts ?token=.
      const given = bearer ?? (url.pathname === "/v1/events" ? url.searchParams.get("token") : null);
      if (!tokenMatches(given, opts.token)) return send(res, 401, { error: "unauthorized" });

      const parts = url.pathname.split("/").filter(Boolean); // ["v1", "hires", ":id", "action"]
      if (parts[0] !== "v1") return send(res, 404, { error: "not_found" });

      if (parts[1] === "events" && req.method === "GET") return horos.subscribe(res);
      if (parts[1] === "detect" && req.method === "GET") return send(res, 200, await detect());
      if (parts[1] === "roster" && req.method === "GET") return send(res, 200, horos.listRoster());
      // POST /v1/shutdown {graceful?: true}: graceful lets work finish and quits each hire cleanly.
      if (parts[1] === "shutdown" && req.method === "POST") {
        const body = await readJson(req);
        if (body.graceful) {
          send(res, 202, { ok: true, graceful: true });
          void horos.gracefulShutdown().finally(() => opts.onShutdown?.());
        } else {
          send(res, 200, { ok: true });
          void horos.quickShutdown().finally(() => opts.onShutdown?.());
        }
        return;
      }
      if (parts[1] === "notifications") {
        if (parts.length === 2 && req.method === "GET") {
          const after = Number(url.searchParams.get("after") ?? 0);
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
          return send(res, 200, { unread: horos.notifier.unread(), items: horos.notifier.list({ after, limit }) });
        }
        if (parts[2] === "read" && req.method === "POST") {
          const body = await readJson(req);
          horos.notifier.markRead(body.upTo === undefined ? undefined : Number(body.upTo));
          return send(res, 200, { unread: horos.notifier.unread() });
        }
        // Hires (SOPHIA, say) can put something in front of the operator too.
        if (parts.length === 2 && req.method === "POST") {
          const body = await readJson(req);
          if (typeof body.title !== "string" || !body.title.trim()) throw new HorosError("bad_request", "title is required.");
          const level = body.level === "warn" ? "warn" : "info";
          horos.notify({ level, kind: "from_hire", title: body.title.slice(0, 120), body: String(body.body ?? "").slice(0, 600), hireId: body.hireId ? String(body.hireId) : undefined });
          return send(res, 201, { ok: true });
        }
      }
      if (parts[1] === "roster" && parts[2] && parts[3] === "wake" && req.method === "POST") {
        const hire = await horos.wake(parts[2], "operator");
        return hire ? send(res, 200, hire.info()) : send(res, 404, { error: "not_kept", message: "No kept hire with that id (or Horos is shutting down)." });
      }

      if (parts[1] === "seats") {
        if (parts.length === 2 && req.method === "GET") return send(res, 200, [...horos.seats.values()].map((s) => s.info()));
        if (parts.length === 2 && req.method === "POST") {
          const body = await readJson(req);
          if (!body.agentId || !body.hireId) throw new HorosError("bad_request", "agentId and hireId are required.");
          return send(res, 201, horos.bindSeat(String(body.agentId), String(body.hireId), body.mailbox).info());
        }
        const seat = horos.seats.get(parts[2] ?? "");
        if (!seat) return send(res, 404, { error: "no_such_seat" });
        // POST /v1/seats/:agentId/jobs/:jobId/done  {ok?, summary?}
        if (parts[3] === "jobs" && parts[4] && parts[5] === "done" && req.method === "POST") {
          const body = await readJson(req);
          const closed = await seat.close(parts[4], { ok: body.ok !== false, summary: body.summary });
          return send(res, closed ? 200 : 409, closed ? { ok: true } : { error: "not_current_job" });
        }
        if (parts.length === 3 && req.method === "DELETE") {
          horos.unbindSeat(seat.agentId);
          return send(res, 200, { ok: true });
        }
      }

      if (parts[1] === "hires" && parts.length === 2) {
        if (req.method === "GET") return send(res, 200, [...horos.hires.values()].map((h) => h.info()));
        if (req.method === "POST") {
          const body = (await readJson(req)) as SpawnBody;
          if (!body.harness || !body.cwd) throw new HorosError("bad_request", "harness and cwd are required.");
          if (body.role === "server" && body.onDemand) return send(res, 201, horos.register(body));
          await horos.ensureNeeds(horos.needsOf(body), body.label ?? body.harness);
          return send(res, 201, horos.spawn(body).info());
        }
      }

      if (parts[1] === "hires" && parts[2]) {
        const hire = horos.hires.get(parts[2]);
        if (!hire) return send(res, 404, { error: "no_such_hire" });
        const action = parts[3];
        if (!action && req.method === "GET") return send(res, 200, hire.info());
        if (!action && req.method === "DELETE") {
          horos.release(hire.id);
          return send(res, 200, { ok: true });
        }
        if (action === "screen" && req.method === "GET") {
          const lines = Number(url.searchParams.get("lines") ?? 60);
          return send(res, 200, { state: hire.state, title: hire.title, lines: hire.read(Math.min(Math.max(lines, 1), 2000)) });
        }
        if (action === "prompt" && req.method === "POST") {
          const body = await readJson(req);
          if (typeof body.text !== "string" || !body.text) throw new HorosError("bad_request", "text is required.");
          const state = await hire.prompt(body.text, { wait: Boolean(body.wait), timeoutMs: body.timeoutMs });
          return send(res, 200, { state });
        }
        if (action === "keys" && req.method === "POST") {
          const body = await readJson(req);
          if (!Array.isArray(body.keys)) throw new HorosError("bad_request", "keys must be an array.");
          hire.keys(body.keys.map(String));
          return send(res, 200, { ok: true });
        }
        if (action === "report" && req.method === "POST") {
          const body = await readJson(req);
          if (!["working", "blocked", "idle"].includes(body.state)) throw new HorosError("bad_request", "state must be working, blocked or idle.");
          const accepted = hire.report({ state: body.state, source: String(body.source ?? "self"), seq: Number(body.seq ?? Date.now()), sessionId: body.sessionId, resumeArgs: body.resumeArgs });
          horos.noteSession(hire);
          return send(res, 200, { accepted, state: hire.state });
        }
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof HorosError) {
        const status = err.code === "hire_blocked" ? 409 : err.code === "not_installed" || err.code === "unknown_harness" ? 422 : err.code === "prompt_stalled" ? 504 : 400;
        return send(res, status, { error: err.code, message: err.message });
      }
      return send(res, 500, { error: "internal", message: (err as Error).message });
    }
  });
  server.listen(opts.port, host);
  return server;
}
