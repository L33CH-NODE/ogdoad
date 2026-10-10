// Hiring from the control center: the operator picks a harness (a cloud CLI under their own login, or a
// local model), names the hire and says what it's for. Ogdoad makes it a folder of its own under
// ~/.ogdoad/seats and asks Horos to start it there. The same thing SOPHIA does through Horos.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HttpError } from "./http.js";

export interface HireInput { harness?: unknown; model?: unknown; label?: unknown; brief?: unknown; keep?: unknown }
interface Detected { harnesses: Array<{ id: string; name: string; privacy: string }>; localModels: Array<{ runtime: string; name: string }> }

export async function hire(horos: { base: string; headers: () => Record<string, string> }, home: string, input: HireInput): Promise<unknown> {
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${horos.base}${path}`, { ...init, headers: { "content-type": "application/json", ...horos.headers(), ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(60_000) });
    const data = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new HttpError(r.status, data?.error ?? "horos", data?.message ?? `Horos answered ${r.status}.`);
    return data;
  };
  const harness = String(input.harness ?? "");
  const found: Detected = await call("/v1/detect");
  const spec = found.harnesses.find((h) => h.id === harness);
  if (!spec) throw new HttpError(400, "no_harness", "That harness isn't on this machine.");
  const label = String(input.label ?? "").trim().slice(0, 60) || spec.name;
  let args: string[] | undefined;
  if (harness === "ollama") {
    const model = String(input.model ?? "");
    if (!found.localModels.some((m) => m.runtime === "ollama" && m.name === model)) throw new HttpError(400, "no_model", "Pick one of the local models on this machine.");
    args = ["run", model];
  }
  const brief = String(input.brief ?? "").trim().slice(0, 8000);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || harness;
  const cwd = join(home, "seats", `${slug}-${randomBytes(3).toString("hex")}`);
  mkdirSync(cwd, { recursive: true });
  if (brief) writeFileSync(join(cwd, "BRIEF.md"), `# ${label}\n\n${brief}\n`);
  return call("/v1/hires", {
    method: "POST",
    body: JSON.stringify({ harness, cwd, label: `${label} - ${spec.name}`, keep: input.keep !== false, ...(args ? { args } : {}), ...(brief ? { brief } : {}) }),
  });
}
