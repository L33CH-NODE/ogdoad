#!/usr/bin/env node
// ogdoad-herd: run the herd daemon, or drive it.
//   ogdoad-herd start                       (herd in the background, logging to ~/.ogdoad/herd/herd.log)
//   ogdoad-herd stop [--now]                (graceful: work finishes, each hire quits with its own /exit;
//                                            --now stops at once. Kept hires come back on the next start)
//   ogdoad-herd notifications [--limit 20] [--read]   (the operator's feed: errors, needs-you, jobs, restarts)
//   ogdoad-herd wake <id>                   (start a resting kept hire now)
//   ogdoad-herd serve [--port 3198]         (herd in this terminal)
//   ogdoad-herd detect
//   ogdoad-herd ls
//   ogdoad-herd spawn <harness> --cwd <dir> [--label name] [--brief-file f] [--keep] [-- harness args...]
//   ogdoad-herd roster                      (kept hires: brought back after a restart)
//   ogdoad-herd screen <id> [--lines 60]
//   ogdoad-herd prompt <id> <text...> [--wait]
//   ogdoad-herd keys <id> <key...>          (enter, esc, up, down, tab, ctrl+c, or literal text)
//   ogdoad-herd kill <id>                   (lets the hire go: stopped, unseated, dropped from the roster)
//   ogdoad-herd seat <hireId> --agent <paperclip agent id>   (jobs for that agent flow into the hire)
//   ogdoad-herd seats
//   ogdoad-herd done <jobId> --agent <agentId> [--summary "..."] [--fail]
//   ogdoad-herd sophia [--company <id> | --company-name "Name"] [--trust private|balanced|power] [--yes] [--no-browser] [--show]
//   ogdoad-herd events

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LOG_FILE, startDetached } from "./daemon.js";
import { detect } from "./harnesses.js";
import { NOTIFICATIONS_FILE, Notifier } from "./notify.js";
import { DEFAULT_PORT, TOKEN_FILE, readOrCreateToken } from "./paths.js";
import { Herd, startServer } from "./server.js";
import { desktopToast } from "./toast.js";
import { readSophiaState, runWizard } from "./sophia/wizard.js";

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return argv.includes(`--${name}`);
}

const port = Number(flag("port") ?? DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${readOrCreateToken()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(`herd isn't running on ${base}. Start it with: ogdoad-herd serve`);
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${json.error}: ${json.message ?? ""}`.trim());
  return json;
}

async function main(): Promise<void> {
  switch (command) {
    case "serve": {
      // Every notification lands in the feed; the ones that matter now also pop up on the desktop,
      // and status flips arrive as a digest at most once a minute.
      const notifier = new Notifier({ file: NOTIFICATIONS_FILE, toast: desktopToast(), pulseDigestMs: 60_000 });
      const herd = new Herd({ notifier, log: (event, data) => console.log(`${new Date().toISOString()} ${event} ${JSON.stringify(data)}`) });
      const exit = () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      const server = startServer(herd, { port, token: readOrCreateToken(), onShutdown: exit });
      server.on("listening", () => {
        console.log(`${new Date().toISOString()} herd listening on ${base} (token: ${TOKEN_FILE}, pid ${process.pid})`);
        void herd.restore();
      });
      const shutdown = () => {
        herd.shutdown();
        exit();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "start": {
      const { pid, already } = await startDetached(port);
      console.log(already ? `herd is already running on ${base}` : `herd started on ${base} (pid ${pid}, log ${LOG_FILE})`);
      return;
    }
    case "stop": {
      if (has("now")) {
        await api("POST", "/v1/shutdown");
        return console.log("herd stopped");
      }
      await api("POST", "/v1/shutdown", { graceful: true });
      console.log("Shutting down gracefully: running work finishes, then each hire quits cleanly.");
      // Herd answers health until the last hire has quit.
      for (let i = 0; i < 20 * 60; i++) {
        if (!(await fetch(`${base}/v1/health`).then((r) => r.ok, () => false))) return console.log("herd stopped");
        await new Promise((r) => setTimeout(r, 1000));
      }
      return console.log("Still shutting down after 20 minutes; check: ogdoad-herd notifications");
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
      for (const e of roster) console.log(`${e.id}  ${(e.running ? "running" : e.dormant ? "resting" : "down").padEnd(8)} ${(e.resumable ? "resumes" : "fresh").padEnd(8)} ${(e.label ?? e.harness).padEnd(16)} ${e.seat ? `seat ${e.seat.agentId}` : "no seat"}`);
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
        keep: has("keep"),
      });
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
