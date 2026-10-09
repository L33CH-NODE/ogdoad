#!/usr/bin/env node
// horos: run the Horos daemon, or drive it.
//   horos start                  (Horos in the background, logging to ~/.ogdoad/horos/horos.log)
//   horos stop [--now]           (graceful: work finishes, each hire quits with its own /exit;
//                                 --now stops at once. Kept hires come back on the next start)
//   horos notifications [--limit 20] [--read]   (the operator's feed: errors, needs-you, jobs, restarts)
//   horos wake <id>              (start a resting kept hire now)
//   horos serve [--port 3198]    (Horos in this terminal)
//   horos detect
//   horos ls
//   horos spawn <harness> --cwd <dir> [--label name] [--brief-file f] [--keep] [-- harness args...]
//   horos spawn generic --command node --server --health <url> --cwd <dir> --label "Ogdoad server" -- <server args...>
//                                (a server: started first and up before hires, stopped last with Ctrl+C)
//   horos spawn generic --command wsl --server --on-demand --provides ollama --health <url> --cwd <dir> --label "Ollama" -- <args>
//                                (on call: registered now, started when a hire needs it, rested when unused)
//   horos spawn <harness> --needs ollama ...   (a hire that needs a capability: its provider starts first)
//   horos roster                 (kept hires: brought back after a restart)
//   horos screen <id> [--lines 60]
//   horos prompt <id> <text...> [--wait]
//   horos keys <id> <key...>     (enter, esc, up, down, tab, ctrl+c, or literal text)
//   horos kill <id>              (lets the hire go: stopped, unseated, dropped from the roster)
//   horos seat <hireId> --agent <paperclip agent id>   (jobs for that agent flow into the hire)
//   horos seats
//   horos done <jobId> --agent <agentId> [--summary "..."] [--fail]
//   horos sophia [--company <id> | --company-name "Name"] [--trust private|balanced|power] [--yes] [--no-browser] [--show]
//   horos events

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LOG_FILE, startDetached } from "./daemon.js";
import { detect } from "./harnesses.js";
import { NOTIFICATIONS_FILE, Notifier } from "./notify.js";
import { DEFAULT_PORT, TOKEN_FILE, isElevated, migrateFromHerd, readOrCreateToken } from "./paths.js";
import { Horos, startServer } from "./server.js";
import { desktopToast } from "./toast.js";
import { readSophiaState, runWizard } from "./sophia/wizard.js";

const argv = process.argv.slice(2);
const command = argv[0];

// Horos's own flags come before a bare "--"; everything after it belongs to the harness.
const ownArgs = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv;
function flag(name: string): string | undefined {
  const i = ownArgs.indexOf(`--${name}`);
  return i >= 0 ? ownArgs[i + 1] : undefined;
}
function has(name: string): boolean {
  return ownArgs.includes(`--${name}`);
}

const port = Number(flag("port") ?? DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${readOrCreateToken()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(`horos isn't running on ${base}. Start it with: horos serve`);
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${json.error}: ${json.message ?? ""}`.trim());
  return json;
}

async function main(): Promise<void> {
  migrateFromHerd();
  switch (command) {
    case "serve": {
      // Every notification lands in the feed; the ones that matter now also pop up on the desktop,
      // and status flips arrive as a digest at most once a minute.
      const notifier = new Notifier({ file: NOTIFICATIONS_FILE, toast: desktopToast(), pulseDigestMs: 60_000 });
      const horos = new Horos({ notifier, log: (event, data) => console.log(`${new Date().toISOString()} ${event} ${JSON.stringify(data)}`) });
      const exit = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      const server = startServer(horos, { port, token: readOrCreateToken(), onShutdown: exit });
      server.on("listening", () => {
        console.log(`${new Date().toISOString()} Horos listening on ${base} (token: ${TOKEN_FILE}, pid ${process.pid})`);
        if (isElevated()) {
          horos.notify({ level: "warn", kind: "elevated", title: "Horos is running with admin rights", body: "Every hire and the Ogdoad server inherit them, and the server's database refuses to start as admin. Stop it (horos stop) and start Ogdoad with OGDOAD-START, which drops admin rights first." });
        }
        void horos.restore();
      });
      // Ctrl+C on Horos itself: hires stop at once, servers still get their own ordered shutdown.
      const shutdown = () => void horos.quickShutdown().finally(exit);
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "start": {
      const { pid, already } = await startDetached(port);
      console.log(already ? `horos is already running on ${base}` : `horos started on ${base} (pid ${pid}, log ${LOG_FILE})`);
      return;
    }
    case "stop": {
      if (has("now")) {
        await api("POST", "/v1/shutdown");
        return console.log("Horos stopped");
      }
      await api("POST", "/v1/shutdown", { graceful: true });
      console.log("Shutting down gracefully: running work finishes, then each hire quits cleanly.");
      // Horos answers health until the last hire has quit.
      for (let i = 0; i < 20 * 60; i++) {
        if (!(await fetch(`${base}/v1/health`).then((r) => r.ok, () => false))) return console.log("Horos stopped");
        await new Promise((r) => setTimeout(r, 1000));
      }
      return console.log("Still shutting down after 20 minutes; check: horos notifications");
    }
    case "notifications": {
      if (has("read")) {
        await api("POST", "/v1/notifications/read", {});
        return console.log("All marked read.");
      }
      const out = await api("GET", `/v1/notifications?limit=${flag("limit") ?? 20}`);
      if (!out.items.length) return console.log("No notifications.");
      for (const n of out.items) {
        const when = new Date(n.at).toLocaleTimeString();
        console.log(`#${n.id} ${when} ${n.level.toUpperCase().padEnd(5)} ${n.title}${n.body ? `: ${n.body}` : ""}`);
      }
      console.log(`${out.unread} unread`);
      return;
    }
    case "wake": {
      if (!argv[1]) throw new Error("usage: wake <hire id>");
      const hire = await api("POST", `/v1/roster/${argv[1]}/wake`);
      console.log(`${hire.id}  ${hire.state}  ${hire.label}`);
      return;
    }
    case "roster": {
      const roster = await api("GET", "/v1/roster");
      if (!roster.length) return console.log("No kept hires.");
      for (const e of roster) {
        const status = e.running ? "running" : e.onDemand ? "on call" : e.dormant ? "resting" : "down";
        const what = e.role === "server" ? `server${e.provides ? `, provides ${e.provides}` : ""}` : e.seat ? `seat ${e.seat.agentId}` : "no seat";
        console.log(`${e.id}  ${status.padEnd(8)} ${(e.resumable ? "resumes" : "fresh").padEnd(8)} ${(e.label ?? e.harness).padEnd(24)} ${what}`);
      }
      return;
    }
    case "detect": {
      const inv = await detect();
      for (const h of inv.harnesses) console.log(`${h.id.padEnd(9)} ${h.privacy.padEnd(6)} ${h.name}  (${h.path})`);
      for (const m of inv.localModels) console.log(`${"model".padEnd(9)} local  ${m.name} via ${m.runtime}${m.sizeBytes ? `  ${(m.sizeBytes / 1e9).toFixed(1)} GB` : ""}`);
      if (!inv.harnesses.length && !inv.localModels.length) console.log("No harnesses or local model servers found.");
      return;
    }
    case "ls": {
      const hires = await api("GET", "/v1/hires");
      if (!hires.length) return console.log("No hires.");
      for (const h of hires) console.log(`${h.id}  ${h.state.padEnd(8)} ${h.label.padEnd(16)} pid ${h.pid}  ${h.cwd}`);
      return;
    }
    case "spawn": {
      const harness = argv[1];
      const cwd = resolve(flag("cwd") ?? process.cwd());
      const dashdash = argv.indexOf("--");
      const args = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
      const briefFile = flag("brief-file");
      const hire = await api("POST", "/v1/hires", {
        harness,
        cwd,
        args,
        label: flag("label"),
        brief: briefFile ? readFileSync(briefFile, "utf8") : undefined,
        keep: has("keep") || has("server"),
        command: flag("command"),
        role: has("server") ? "server" : undefined,
        health: flag("health"),
        onDemand: has("on-demand") || undefined,
        provides: flag("provides"),
        needs: flag("needs")?.split(",").map((s) => s.trim()).filter(Boolean),
      });
      if (hire.onDemand) return console.log(`${hire.id}  on call  ${hire.label}  (provides ${hire.provides}; starts when a hire needs it)`);
      console.log(`${hire.id}  ${hire.state}  ${hire.label}  pid ${hire.pid}`);
      return;
    }
    case "screen": {
      const out = await api("GET", `/v1/hires/${argv[1]}/screen?lines=${flag("lines") ?? 60}`);
      console.log(`[${out.state}] ${out.title}`);
      console.log(out.lines.join("\n"));
      return;
    }
    case "prompt": {
      const words = argv.slice(2).filter((a) => a !== "--wait");
      const out = await api("POST", `/v1/hires/${argv[1]}/prompt`, { text: words.join(" "), wait: has("wait") });
      console.log(out.state);
      return;
    }
    case "keys": {
      await api("POST", `/v1/hires/${argv[1]}/keys`, { keys: argv.slice(2) });
      return;
    }
    case "kill": {
      await api("DELETE", `/v1/hires/${argv[1]}`);
      return;
    }
    case "seat": {
      const agentId = flag("agent");
      if (!argv[1] || !agentId) throw new Error("usage: seat <hireId> --agent <paperclip agent id> [--mailbox URL]");
      const seat = await api("POST", "/v1/seats", { hireId: argv[1], agentId, mailbox: flag("mailbox") });
      console.log(`seat bound: agent ${seat.agentId} -> hire ${seat.hireId} (${seat.mailbox})`);
      return;
    }
    case "seats": {
      const seats = await api("GET", "/v1/seats");
      if (!seats.length) return console.log("No seats.");
      for (const s of seats) console.log(`${s.agentId}  hire ${s.hireId}  job ${s.currentJob ?? "-"}  handled ${s.jobsHandled}`);
      return;
    }
    case "sophia": {
      if (has("show")) return console.log(JSON.stringify(readSophiaState(), null, 2) ?? "No SOPHIA yet.");
      const trust = flag("trust");
      if (trust && !["private", "balanced", "power"].includes(trust)) throw new Error("--trust is private, balanced or power");
      await runWizard({
        companyId: flag("company"),
        companyName: flag("company-name"),
        trust: trust as "private" | "balanced" | "power" | undefined,
        yes: has("yes"),
        openBrowser: !has("no-browser"),
      });
      return;
    }
    case "done": {
      const agentId = flag("agent");
      if (!argv[1] || !agentId) throw new Error('usage: done <jobId> --agent <agentId> [--summary "..."] [--fail]');
      await api("POST", `/v1/seats/${agentId}/jobs/${argv[1]}/done`, { ok: !has("fail"), summary: flag("summary") });
      console.log(`closed job ${argv[1]}`);
      return;
    }
    case "events": {
      const res = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${readOrCreateToken()}` } });
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      for await (const chunk of res.body) process.stdout.write(Buffer.from(chunk as Uint8Array).toString("utf8"));
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//   ")).map((l) => l.slice(3)).join("\n"));
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
