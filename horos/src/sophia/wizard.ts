// First launch: choose SOPHIA, the CEO, then brief her, seat her and open the UI.
//   horos sophia [--company <id> | --company-name "Name"] [--trust private|balanced|power] [--yes]
// Interactive by default; the flags let it run unattended (tests, scripted installs).

import { randomUUID } from "node:crypto";
import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { startDetached } from "../daemon.js";
import type { Inventory } from "../harnesses.js";
import { DEFAULT_PORT, OGDOAD_HOME, TOKEN_FILE, readOrCreateToken } from "../paths.js";
import { renderBrief } from "./brief.js";
import { candidatesFrom, recommendSophia, type Candidate, type Trust } from "./recommend.js";

const HOROS_CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
/** Nous, Ogdoad's engine: the company, its members and their tasks. */
const OGDOAD_URL = (process.env.OGDOAD_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
/** The control center, where SOPHIA's task opens. */
const APP_URL = (process.env.OGDOAD_APP_URL ?? "http://127.0.0.1:3101").replace(/\/+$/, "");
/** The wizard signs as the operator: being on this machine isn't enough for Nous. */
function nousAuth(): Record<string, string> {
  const file = join(process.env.OGDOAD_NOUS_HOME?.trim() || join(OGDOAD_HOME, "nous"), "operator.token");
  return { authorization: `Bearer ${readFileSync(file, "utf8").trim()}` };
}
const HOROS_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export interface WizardOptions {
  companyId?: string;
  companyName?: string;
  trust?: Trust;
  yes?: boolean;
  openBrowser?: boolean;
}

async function ogdoad(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${OGDOAD_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...nousAuth() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ogdoad ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function horos(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${HOROS_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${readOrCreateToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`horos ${method} ${path}: ${json.error} ${json.message ?? ""}`);
  return json;
}

/** Nous's state: down (null), or up and whether it's still locked. */
async function nousHealth(): Promise<{ locked: boolean } | null> {
  try {
    const r = await fetch(`${OGDOAD_URL}/v1/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? { locked: ((await r.json()) as { locked?: boolean }).locked !== false } : null;
  } catch {
    return null;
  }
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    spawnProcess(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // the fallback link below covers it
  }
}

export async function runWizard(opts: WizardOptions): Promise<void> {
  const rl = process.stdin.isTTY && !opts.yes ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (q: string, fallback: string) => (rl ? (await rl.question(q)).trim() || fallback : fallback);
  const say = (s = "") => console.log(s);

  try {
    say("0GD0AD: choosing SOPHIA, your CEO\n");
    const health = await nousHealth();
    if (!health) throw new Error(`Ogdoad isn't answering at ${OGDOAD_URL}. Start it first (OGDOAD-START).`);
    // Nous opens with the key the operator's vault hands it, so the vault comes first.
    if (health.locked) throw new Error(`Ogdoad is locked. Open ${APP_URL}, make your key (or unlock), then run this again.`);
    await startDetached();

    // 1. Company.
    let company: { id: string; name: string };
    if (opts.companyId) {
      company = await ogdoad("GET", `/v1/companies/${opts.companyId}`);
    } else {
      const name = opts.companyName ?? (await ask("What's the company called? ", "My Company"));
      company = await ogdoad("POST", "/v1/companies", { name });
      say(`Created company "${company.name}".`);
    }

    // 2. Who could be SOPHIA, and how much does the operator trust the cloud?
    const inventory = (await horos("GET", "/v1/detect")) as Inventory;
    const candidates = candidatesFrom(inventory);
    if (!candidates.length) throw new Error("No agent harnesses or local models found. Install Claude Code, Codex, grok, opencode or Ollama, then run this again.");
    let trust = opts.trust;
    if (!trust) {
      say("How much do you trust the cloud with your business?");
      say("  1. Private: nothing leaves this machine");
      say("  2. Balanced: cloud for planning, company data stays local");
      say("  3. Power: use the strongest model available");
      trust = (["private", "balanced", "power"] as const)[Math.max(0, Math.min(2, Number(await ask("Choose 1-3 [2]: ", "2")) - 1))];
    }

    // 3. Recommend, then let the operator confirm or choose.
    const rec = recommendSophia(trust, candidates);
    if (!rec) throw new Error(`Nothing installed fits "${trust}". For private, install a local model (Ollama or LM Studio).`);
    say(`\nRecommended SOPHIA: ${rec.pick.name}\n  ${rec.why}`);
    let pick: Candidate = rec.pick;
    if (rl) {
      say("\nOr choose another:");
      candidates.forEach((c, i) => say(`  ${i + 1}. ${c.name} (${c.privacy})`));
      const choice = await ask(`Press Enter for ${rec.pick.name}, or a number: `, "");
      const n = Number(choice);
      if (n >= 1 && n <= candidates.length) pick = candidates[n - 1];
      if (trust === "private" && pick.privacy === "cloud") throw new Error(`${pick.name} is a cloud harness, and you chose private.`);
    }

    // 4. SOPHIA as a member: her harness takes her jobs through a seat, so Ogdoad holds no provider login.
    // Nous writes her mailbox key itself.
    const sessionName = `SOPHIA - ${company.name}`;
    const agent = await ogdoad("POST", `/v1/companies/${company.id}/members`, {
      name: "SOPHIA",
      role: "ceo",
      title: "CEO",
      capabilities: `CEO seat, run by ${pick.name} through Horos.`,
    });
    const mailbox = `${OGDOAD_URL}/mailbox`;

    // 5. Brief and spawn her.
    const seatDir = join(OGDOAD_HOME, "seats", `sophia-${company.id.slice(0, 8)}`);
    mkdirSync(seatDir, { recursive: true });
    const brief = renderBrief({
      companyName: company.name, companyId: company.id, agentId: agent.id, apiUrl: OGDOAD_URL,
      horosUrl: HOROS_URL, horosTokenFile: TOKEN_FILE, horosCli: HOROS_CLI, trust, mailbox,
    });
    const briefFile = join(seatDir, "SOPHIA.md");
    writeFileSync(briefFile, brief, "utf8");

    const sessionId = randomUUID();
    let spawnBody: Record<string, unknown>;
    if (pick.kind === "harness" && pick.id === "claude") {
      // Claude Code: role in the system prompt, Remote Control always on, named and resumable.
      spawnBody = {
        harness: "claude",
        args: ["--remote-control", sessionName, "--name", sessionName, "--session-id", sessionId, "--append-system-prompt-file", briefFile],
        brief: `You are SOPHIA, CEO of ${company.name}. Your role brief is in your system prompt. Greet the operator in one line, then wait: your first job (the setup interview) arrives as an [Ogdoad job] note.`,
      };
    } else if (pick.kind === "local-model") {
      spawnBody = { harness: "ollama", args: ["run", pick.id], brief };
    } else {
      spawnBody = { harness: pick.id, args: [], brief };
    }
    // Kept: Horos brings SOPHIA back (resumed, same seat) whenever it restarts.
    const hire = await horos("POST", "/v1/hires", {
      ...spawnBody,
      keep: true,
      cwd: seatDir,
      label: sessionName,
      env: { OGDOAD_COMPANY_ID: company.id, OGDOAD_AGENT_ID: agent.id, OGDOAD_API_URL: OGDOAD_URL },
    });
    say(`\nSOPHIA is starting on ${pick.name} (hire ${hire.id}).`);

    // 6. Seat her, then give her the setup task; the engine wakes her and the job flows through Horos.
    await horos("POST", "/v1/seats", { agentId: agent.id, hireId: hire.id, mailbox });
    const task = await ogdoad("POST", `/v1/companies/${company.id}/tasks`, {
      title: "Set up the company with SOPHIA",
      description: `SOPHIA interviews the operator with multiple-choice questions about ${company.name} and about how Ogdoad should be set up, then writes a company profile and proposes the first hires.`,
      status: "todo",
      priority: "high",
      assigneeId: agent.id,
    });

    const state = { companyId: company.id, companyName: company.name, agentId: agent.id, hireId: hire.id, harness: pick.id, sessionId, sessionName, seatDir, taskId: task.id, trust, engine: "nous" };
    writeFileSync(join(OGDOAD_HOME, "sophia.json"), JSON.stringify(state, null, 2));

    // 7. Open the control center on SOPHIA's task.
    const url = `${APP_URL}/team/task/${task.id}`;
    if (opts.openBrowser !== false) openInBrowser(url);
    say(`\nOgdoad is opening in your browser.`);
    say(`Didn't open? Click here: ${url}`);
  } finally {
    rl?.close();
  }
}

/** For `sophia --show`: what's recorded about the current SOPHIA. */
export function readSophiaState(): unknown {
  try {
    return JSON.parse(readFileSync(join(OGDOAD_HOME, "sophia.json"), "utf8"));
  } catch {
    return null;
  }
}
