#!/usr/bin/env node
// ogdoad-herd: run the herd daemon, or drive it.
//   ogdoad-herd serve [--port 3198]
//   ogdoad-herd detect
//   ogdoad-herd ls
//   ogdoad-herd spawn <harness> --cwd <dir> [--label name] [--brief-file f] [-- harness args...]
//   ogdoad-herd screen <id> [--lines 60]
//   ogdoad-herd prompt <id> <text...> [--wait]
//   ogdoad-herd keys <id> <key...>          (enter, esc, up, down, tab, ctrl+c, or literal text)
//   ogdoad-herd kill <id>
//   ogdoad-herd seat <hireId> --agent <paperclip agent id>   (jobs for that agent flow into the hire)
//   ogdoad-herd seats
//   ogdoad-herd done <jobId> --agent <agentId> [--summary "..."] [--fail]
//   ogdoad-herd sophia [--company <id> | --company-name "Name"] [--trust private|balanced|power] [--yes] [--no-browser] [--show]
//   ogdoad-herd events

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { detect } from "./harnesses.js";
import { DEFAULT_PORT, TOKEN_FILE, readOrCreateToken } from "./paths.js";
import { Herd, startServer } from "./server.js";
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
      const herd = new Herd();
      const server = startServer(herd, { port, token: readOrCreateToken() });
      server.on("listening", () => {
        console.log(`herd listening on ${base} (token: ${TOKEN_FILE})`);
      });
      const shutdown = () => {
        for (const hire of herd.hires.values()) hire.kill();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
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
