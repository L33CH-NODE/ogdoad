// Which agent harnesses this machine can run, and how to launch them.
// Cloud CLIs run under the operator's own logins; local models never leave the machine.

import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export type Privacy = "local" | "cloud" | "either";

export interface HarnessSpec {
  id: string;
  name: string;
  /** Executables to look for on PATH, in order. */
  commands: string[];
  privacy: Privacy;
  vendor: string;
  /** Extra argv for a resumed session, given the harness's own session id. */
  resumeArgs?: (sessionId: string) => string[];
}

export const HARNESSES: HarnessSpec[] = [
  { id: "claude", name: "Claude Code", commands: ["claude"], privacy: "cloud", vendor: "Anthropic", resumeArgs: (id) => ["--resume", id] },
  { id: "codex", name: "Codex CLI", commands: ["codex"], privacy: "cloud", vendor: "OpenAI", resumeArgs: (id) => ["resume", id] },
  { id: "grok", name: "grok CLI", commands: ["grok"], privacy: "cloud", vendor: "xAI" },
  { id: "gemini", name: "Gemini CLI", commands: ["gemini"], privacy: "cloud", vendor: "Google" },
  { id: "opencode", name: "opencode", commands: ["opencode"], privacy: "either", vendor: "SST (any provider, including local)" },
  { id: "hermes", name: "Hermes", commands: ["hermes"], privacy: "either", vendor: "Nous Research (any provider, including local)" },
  { id: "ollama", name: "Ollama", commands: ["ollama"], privacy: "local", vendor: "local models" },
];

export interface Resolved {
  /** What to hand to the PTY as the program. */
  file: string;
  /** Args that must come before the harness's own args (e.g. cmd.exe /c for .cmd shims). */
  prefix: string[];
  /** The executable found on PATH. */
  path: string;
}

/** Find a command on PATH. On Windows, .cmd/.bat shims run through cmd.exe and .ps1 through pwsh. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): Resolved | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const isWindows = process.platform === "win32";
  const exts = isWindows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.PS1").toLowerCase().split(";").filter(Boolean) : [""];
  if (isWindows && !exts.includes(".ps1")) exts.push(".ps1");
  for (const dir of dirs) {
    for (const ext of extname(command) ? [""] : exts) {
      const candidate = join(dir, command + ext);
      if (!existsSync(candidate)) continue;
      const e = extname(candidate).toLowerCase();
      if (e === ".cmd" || e === ".bat") return { file: env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", candidate], path: candidate };
      if (e === ".ps1") return { file: "pwsh.exe", prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", candidate], path: candidate };
      return { file: candidate, prefix: [], path: candidate };
    }
  }
  return null;
}

export interface LocalModel {
  runtime: "ollama" | "lmstudio";
  name: string;
  /** Model size in bytes when the runtime reports it; a rough proxy for capability. */
  sizeBytes?: number;
  endpoint: string;
}

export interface Inventory {
  harnesses: Array<HarnessSpec & { path: string }>;
  localModels: LocalModel[];
}

async function getJson(url: string, timeoutMs = 1500): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What's installed and reachable right now. Local model servers are probed on loopback only. */
export async function detect(env: NodeJS.ProcessEnv = process.env): Promise<Inventory> {
  const harnesses: Inventory["harnesses"] = [];
  for (const spec of HARNESSES) {
    const found = spec.commands.map((c) => resolveCommand(c, env)).find(Boolean);
    if (found) harnesses.push({ ...spec, path: found.path });
  }

  const localModels: LocalModel[] = [];
  const ollamaUrl = env.OLLAMA_HOST ? `http://${env.OLLAMA_HOST.replace(/^https?:\/\//, "")}` : "http://127.0.0.1:11434";
  const tags = (await getJson(`${ollamaUrl}/api/tags`)) as { models?: Array<{ name: string; size?: number }> } | null;
  for (const m of tags?.models ?? []) localModels.push({ runtime: "ollama", name: m.name, sizeBytes: m.size, endpoint: ollamaUrl });
  const lms = (await getJson("http://127.0.0.1:1234/v1/models")) as { data?: Array<{ id: string }> } | null;
  for (const m of lms?.data ?? []) localModels.push({ runtime: "lmstudio", name: m.id, endpoint: "http://127.0.0.1:1234" });

  return { harnesses, localModels };
}
