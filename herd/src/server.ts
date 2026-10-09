// Herd's API: localhost only, every call carries the per-install token.
// Paperclip's local-trusted mode treats any loopback request as the operator, so herd adds its own
// check: a process (or a web page) that can reach 127.0.0.1 still can't drive hires without the token.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";

import { HARNESSES, detect, resolveCommand } from "./harnesses.js";
import { Hire, HerdError, type HireSpec } from "./hire.js";
import { planRestart } from "./restart.js";
import { loadRoster, resumeArgsFor, saveRoster, type RosterEntry } from "./roster.js";
import type { HireState } from "./rules.js";
import { Seat } from "./seat.js";

const DEFAULT_MAILBOX = process.env.LIVE_AGENT_MAILBOX ?? "http://127.0.0.1:3199";

export interface HerdServerOptions {
  port: number;
  host?: string;
  token: string;
  /** Called after POST /v1/shutdown has been answered. */
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
  /** Keep this hire: herd brings it back after a restart and when its session ends on its own. */
  keep?: boolean;
}

interface LaunchSpec {
  id?: string;
  harness: string;
  command?: string;
  args: string[];
  cwd: string;
  label?: string;
  env?: Record<string, string>;
}

export class Herd {
  readonly hires = new Map<string, Hire>();
  /** Seats by Paperclip agent id. */
  readonly seats = new Map<string, Seat>();
  private readonly subscribers = new Set<ServerResponse>();
  private roster: RosterEntry[];
  /** Hires the operator let go of: their exit is expected, never restarted. */
  private readonly released = new WeakSet<Hire>();
  private readonly exitHandled = new WeakSet<Hire>();
  private readonly resumed = new WeakSet<Hire>();
  private readonly restarts = new Map<string, number[]>();
  private shuttingDown = false;

  constructor(private readonly opts: { rosterFile?: string; log?: (event: string, data: unknown) => void } = {}) {
    this.roster = loadRoster(opts.rosterFile);
  }

  /** Bind a hire to a Paperclip agent on the live-agent adapter, so its jobs flow into the session. */
  bindSeat(agentId: string, hireId: string, mailbox = DEFAULT_MAILBOX): Seat {
    const hire = this.hires.get(hireId);
    if (!hire) throw new HerdError("no_such_hire", `No hire ${hireId}.`);
    this.seats.get(agentId)?.stop();
    const seat = new Seat(agentId, hire, mailbox, (event, data) => this.broadcast(event, data));
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
    this.updateEntry(seat.hire.id, (e) => delete e.seat);
  }

  spawn(body: SpawnBody): Hire {
    const hire = this.launch({ harness: body.harness, command: body.command, args: body.args ?? [], cwd: body.cwd, label: body.label, env: body.env });
    if (body.keep) {
      const args = body.args ?? [];
      this.roster.push({
        id: hire.id, harness: hire.harness, command: body.command, cwd: body.cwd, label: body.label, env: body.env, args,
        resumeArgs: resumeArgsFor(harnessSpec(hire.harness)?.resumeArgs, args), brief: body.brief, keptAt: new Date().toISOString(),
      });
      this.saveRoster();
    }
    if (body.brief) void this.deliverBrief(hire, body.brief);
    return hire;
  }

  /** Let a hire go: stop it, unbind its seat, and drop it from the roster. */
  release(hireId: string): void {
    const hire = this.hires.get(hireId);
    for (const seat of [...this.seats.values()]) if (seat.hire.id === hireId) this.unbindSeat(seat.agentId);
    if (hire) {
      this.released.add(hire);
      hire.kill();
      this.hires.delete(hireId);
    }
    if (this.roster.some((e) => e.id === hireId)) {
      this.roster = this.roster.filter((e) => e.id !== hireId);
      this.saveRoster();
    }
  }

  /** A hire told herd its session id: record how to resume it. */
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

  /** On herd start: bring every kept hire back, resumed where possible, and re-bind its seat. */
  async restore(): Promise<void> {
    for (const entry of this.roster) {
      if (this.hires.has(entry.id)) continue;
      try {
        this.revive(entry, false);
      } catch (err) {
        this.broadcast("restore_failed", { id: entry.id, label: entry.label, reason: (err as Error).message });
      }
      await sleep(500);
    }
  }

  /** Stop every hire without letting any of them go: they come back on the next start. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const seat of this.seats.values()) seat.stop();
    for (const hire of this.hires.values()) hire.kill();
  }

  private revive(entry: RosterEntry, fresh: boolean): Hire {
    const resume = !fresh && entry.resumeArgs !== null;
    if (fresh) this.renewSession(entry);
    const hire = this.launch({ id: entry.id, harness: entry.harness, command: entry.command, args: resume ? entry.resumeArgs! : entry.args, cwd: entry.cwd, label: entry.label, env: entry.env });
    if (resume) this.resumed.add(hire);
    else if (entry.brief) void this.deliverBrief(hire, entry.brief);
    if (entry.seat) this.bindSeat(entry.seat.agentId, hire.id, entry.seat.mailbox);
    this.broadcast("hire_restored", { id: hire.id, label: hire.label, resumed: resume });
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
    if (!command) throw new HerdError("unknown_harness", `Unknown harness "${o.harness}" and no command given.`);
    const resolved = resolveCommand(command);
    if (!resolved) throw new HerdError("not_installed", `"${command}" isn't on PATH.`);
    mkdirSync(o.cwd, { recursive: true });

    const hireSpec: HireSpec = {
      id: o.id,
      harness: spec?.id ?? "generic",
      file: resolved.file,
      args: [...resolved.prefix, ...o.args],
      cwd: o.cwd,
      env: o.env,
      label: o.label,
    };
    const hire = new Hire(hireSpec);
    this.hires.set(hire.id, hire);
    hire.on("state", (state: HireState) => {
      this.broadcast("status_changed", { id: hire.id, label: hire.label, state });
      if (state === "exited") this.onExit(hire);
    });
    this.broadcast("hire_spawned", hire.info());
    return hire;
  }

  private onExit(hire: Hire): void {
    if (this.exitHandled.has(hire)) return;
    this.exitHandled.add(hire);
    if (this.shuttingDown || this.released.has(hire) || this.hires.get(hire.id) !== hire) return;
    const entry = this.roster.find((e) => e.id === hire.id);
    if (!entry) return;

    const history = this.restarts.get(hire.id) ?? [];
    const plan = planRestart({ exitCode: hire.exitCode, ranForMs: Date.now() - hire.startedAt, recentRestarts: history, wasResume: this.resumed.has(hire) });
    if (!plan) {
      this.broadcast("hire_gave_up", { id: hire.id, label: hire.label, exitCode: hire.exitCode, restarts: history.length });
      return;
    }
    this.restarts.set(hire.id, [...history, Date.now()]);
    this.broadcast("hire_restarting", { id: hire.id, label: hire.label, exitCode: hire.exitCode, inMs: plan.delayMs, fresh: plan.fresh });
    setTimeout(() => {
      // Still ours to bring back? The operator may have let it go, or herd may be stopping.
      if (this.shuttingDown || this.hires.get(hire.id) !== hire || !this.roster.includes(entry)) return;
      try {
        this.revive(entry, plan.fresh);
      } catch (err) {
        this.broadcast("restore_failed", { id: entry.id, label: entry.label, reason: (err as Error).message });
      }
    }, plan.delayMs).unref();
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
  private async deliverBrief(hire: Hire, brief: string): Promise<void> {
    const ready = await hire.waitFor((s) => s === "idle" || s === "done" || s === "exited", 90_000);
    if (!ready || hire.state === "exited") {
      this.broadcast("brief_failed", { id: hire.id, reason: ready ? "exited" : "not ready within 90 s" });
      return;
    }
    hire.read(1); // acknowledge any startup "done"
    try {
      await hire.prompt(brief);
      this.broadcast("brief_delivered", { id: hire.id });
    } catch (err) {
      this.broadcast("brief_failed", { id: hire.id, reason: (err as Error).message });
    }
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
    if (size > 1_000_000) throw new HerdError("too_large", "Request body over 1 MB.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HerdError("bad_json", "Request body isn't valid JSON.");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startServer(herd: Herd, opts: HerdServerOptions) {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      // Browsers attach Origin; only same-machine pages may call, and they still need the token.
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: "origin_not_allowed" });

      if (url.pathname === "/v1/health") return send(res, 200, { ok: true, protocol: "ogdoad-herd/1", hires: herd.hires.size });

      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? null;
      // EventSource can't set headers, so the event stream also accepts ?token=.
      const given = bearer ?? (url.pathname === "/v1/events" ? url.searchParams.get("token") : null);
      if (!tokenMatches(given, opts.token)) return send(res, 401, { error: "unauthorized" });

      const parts = url.pathname.split("/").filter(Boolean); // ["v1", "hires", ":id", "action"]
      if (parts[0] !== "v1") return send(res, 404, { error: "not_found" });

      if (parts[1] === "events" && req.method === "GET") return herd.subscribe(res);
      if (parts[1] === "detect" && req.method === "GET") return send(res, 200, await detect());
      if (parts[1] === "roster" && req.method === "GET") return send(res, 200, herd.listRoster());
      if (parts[1] === "shutdown" && req.method === "POST") {
        send(res, 200, { ok: true });
        herd.shutdown();
        opts.onShutdown?.();
        return;
      }

      if (parts[1] === "seats") {
        if (parts.length === 2 && req.method === "GET") return send(res, 200, [...herd.seats.values()].map((s) => s.info()));
        if (parts.length === 2 && req.method === "POST") {
          const body = await readJson(req);
          if (!body.agentId || !body.hireId) throw new HerdError("bad_request", "agentId and hireId are required.");
          return send(res, 201, herd.bindSeat(String(body.agentId), String(body.hireId), body.mailbox).info());
        }
        const seat = herd.seats.get(parts[2] ?? "");
        if (!seat) return send(res, 404, { error: "no_such_seat" });
        // POST /v1/seats/:agentId/jobs/:jobId/done  {ok?, summary?}
        if (parts[3] === "jobs" && parts[4] && parts[5] === "done" && req.method === "POST") {
          const body = await readJson(req);
          const closed = await seat.close(parts[4], { ok: body.ok !== false, summary: body.summary });
          return send(res, closed ? 200 : 409, closed ? { ok: true } : { error: "not_current_job" });
        }
        if (parts.length === 3 && req.method === "DELETE") {
          herd.unbindSeat(seat.agentId);
          return send(res, 200, { ok: true });
        }
      }

      if (parts[1] === "hires" && parts.length === 2) {
        if (req.method === "GET") return send(res, 200, [...herd.hires.values()].map((h) => h.info()));
        if (req.method === "POST") {
          const body = (await readJson(req)) as SpawnBody;
          if (!body.harness || !body.cwd) throw new HerdError("bad_request", "harness and cwd are required.");
          return send(res, 201, herd.spawn(body).info());
        }
      }

      if (parts[1] === "hires" && parts[2]) {
        const hire = herd.hires.get(parts[2]);
        if (!hire) return send(res, 404, { error: "no_such_hire" });
        const action = parts[3];
        if (!action && req.method === "GET") return send(res, 200, hire.info());
        if (!action && req.method === "DELETE") {
          herd.release(hire.id);
          return send(res, 200, { ok: true });
        }
        if (action === "screen" && req.method === "GET") {
          const lines = Number(url.searchParams.get("lines") ?? 60);
          return send(res, 200, { state: hire.state, title: hire.title, lines: hire.read(Math.min(Math.max(lines, 1), 2000)) });
        }
        if (action === "prompt" && req.method === "POST") {
          const body = await readJson(req);
          if (typeof body.text !== "string" || !body.text) throw new HerdError("bad_request", "text is required.");
          const state = await hire.prompt(body.text, { wait: Boolean(body.wait), timeoutMs: body.timeoutMs });
          return send(res, 200, { state });
        }
        if (action === "keys" && req.method === "POST") {
          const body = await readJson(req);
          if (!Array.isArray(body.keys)) throw new HerdError("bad_request", "keys must be an array.");
          hire.keys(body.keys.map(String));
          return send(res, 200, { ok: true });
        }
        if (action === "report" && req.method === "POST") {
          const body = await readJson(req);
          if (!["working", "blocked", "idle"].includes(body.state)) throw new HerdError("bad_request", "state must be working, blocked or idle.");
          const accepted = hire.report({ state: body.state, source: String(body.source ?? "self"), seq: Number(body.seq ?? Date.now()), sessionId: body.sessionId, resumeArgs: body.resumeArgs });
          herd.noteSession(hire);
          return send(res, 200, { accepted, state: hire.state });
        }
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof HerdError) {
        const status = err.code === "hire_blocked" ? 409 : err.code === "not_installed" || err.code === "unknown_harness" ? 422 : err.code === "prompt_stalled" ? 504 : 400;
        return send(res, status, { error: err.code, message: err.message });
      }
      return send(res, 500, { error: "internal", message: (err as Error).message });
    }
  });
  server.listen(opts.port, host);
  return server;
}
