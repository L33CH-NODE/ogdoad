// The dispatcher: a local model reads a job (stand-ins only: what the room's brief became on its way
// through the membrane) and the team, and proposes a lineup: which part each hire takes, and why. One
// rule is the law here, not the model's opinion: a part that needs the real records (the books, the
// clients, shift notes) goes only to a local hire, because cloud hires never see real data. The model
// proposes; the rule is checked in code; the operator approves the lineup, changes it, or denies it.

import { HttpError } from "../http.js";

/** Where the dispatcher's model listens (an OpenAI-compatible llama.cpp server, on call through Horos). */
export const DISPATCH_URL = process.env.OGDOAD_DISPATCH_URL ?? "http://127.0.0.1:11442";

export interface TeamMember {
  agentId: string;
  name: string;
  /** The harness behind it, in words ("Claude Code"). */
  via: string;
  /** cloud, local, either or unknown. */
  where: string;
  role: string;
  title: string | null;
  capabilities: string | null;
}

export interface ProposedPart {
  title: string;
  brief: string;
  agentId: string | null;
  why: string;
  needsRealData: boolean;
  /** What's wrong with this part as proposed (the rule broken, a hire that isn't on the team). */
  problem?: string;
}

export interface Lineup { parts: ProposedPart[]; seconds: number; model: string }

const local = (m: TeamMember | undefined) => m?.where === "local";

/** The rule, and the team: what can't stand is marked, and a part with real data is moved to a local hire when there is one. */
export function checkLineup(parts: ProposedPart[], team: TeamMember[]): ProposedPart[] {
  const byId = new Map(team.map((m) => [m.agentId, m]));
  const firstLocal = team.find(local);
  return parts.map((p) => {
    const out: ProposedPart = { ...p, title: p.title.trim().slice(0, 240), brief: p.brief.trim().slice(0, 4000), problem: undefined };
    if (out.agentId && !byId.has(out.agentId)) {
      out.agentId = null;
      out.problem = "The hire it named isn't on the team.";
    }
    if (out.needsRealData && !local(byId.get(out.agentId ?? ""))) {
      if (firstLocal) {
        out.problem = `It needs the real records, so it goes to a local hire: moved to ${firstLocal.name}.`;
        out.agentId = firstLocal.agentId;
      } else {
        out.problem = "It needs the real records, and there's no local hire on the team. Hire one (a local model), or keep this part yourself.";
        out.agentId = null;
      }
    }
    return out;
  });
}

/** Approving holds the operator to the same rule: a real-data part can't be handed to a cloud hire. */
export function refuseBroken(parts: ProposedPart[], team: TeamMember[]): void {
  const byId = new Map(team.map((m) => [m.agentId, m]));
  for (const p of parts) {
    if (!p.title.trim()) throw new HttpError(400, "title", "Every part needs a title.");
    if (p.agentId && !byId.has(p.agentId)) throw new HttpError(400, "hire", `"${p.title}" names a hire that isn't on the team.`);
    if (p.needsRealData && p.agentId && !local(byId.get(p.agentId))) {
      throw new HttpError(400, "real_data", `"${p.title}" needs the real records, so it can only go to a local hire (or nobody yet).`);
    }
  }
}

function prompt(job: { name: string; brief: string; existing: string[] }, team: TeamMember[]) {
  const system = [
    "You are the dispatcher for a small business run with AI agents. Split the job into 2 to 5 parts and give each part to the best agent on the team.",
    "Rules:",
    "- A part that needs the business's real records (invoices, clients, bank lines, shift notes, anyone's personal details) needs real data: set needsRealData true, and give it to an agent whose where is local.",
    "- Cloud agents only ever see stand-ins like C-4821 or EMAIL-2210. Keep stand-ins exactly as written; never ask for real names.",
    "- A local agent working with real records hands back only stand-ins or totals. So no part may put real names or details into anything a cloud agent then works on: keep those steps local, or last.",
    "- Don't repeat a part the job already has.",
    "- Use agentId \"nobody\" when no one on the team fits.",
    "- Titles under 8 words. Briefs one or two sentences, saying what done looks like. Why: one short sentence.",
  ].join("\n");
  const user = [
    "The team:",
    ...team.map((m) => `- ${m.agentId}: ${m.name} (${m.via}, ${m.where}): ${[m.title, m.role, m.capabilities].filter(Boolean).join("; ")}`),
    "",
    `The job: ${job.name}`,
    job.brief || "(no brief)",
    ...(job.existing.length ? ["", "Parts it already has:", ...job.existing.map((t) => `- ${t}`)] : []),
  ].join("\n");
  const schema = {
    type: "object",
    properties: {
      parts: {
        type: "array", minItems: 1, maxItems: 5,
        items: {
          type: "object",
          properties: {
            title: { type: "string" }, brief: { type: "string" },
            agentId: { type: "string", enum: [...team.map((m) => m.agentId), "nobody"] },
            why: { type: "string" }, needsRealData: { type: "boolean" },
          },
          required: ["title", "brief", "agentId", "why", "needsRealData"],
        },
      },
    },
    required: ["parts"],
  };
  return { system, user, schema };
}

/** Ask the model for a lineup. wake: start it if it's resting (it's on call through Horos). */
export async function propose(job: { name: string; brief: string; existing: string[] }, team: TeamMember[], opts: { url?: string | null; wake?: () => Promise<void> } = {}): Promise<Lineup> {
  const url = opts.url ?? DISPATCH_URL;
  if (!url || url === "off") throw new HttpError(503, "dispatch_off", "The dispatcher is turned off. Add parts by hand.");
  if (!team.length) throw new HttpError(409, "no_team", "There's nobody on the team to give parts to yet.");
  const { system, user, schema } = prompt(job, team);
  const ask = () => fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      temperature: 0.2, max_tokens: 1200, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_schema", json_schema: { name: "lineup", schema } },
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const started = Date.now();
  let r = await ask().catch(() => null);
  if (!r && opts.wake) {
    await opts.wake();
    r = await ask().catch(() => null);
  }
  if (!r) throw new HttpError(503, "dispatch_down", "The dispatcher's model didn't answer. Add parts by hand, or try again in a moment.");
  const body = (await r.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }>; model?: string } | null;
  let parsed: { parts?: Array<Record<string, unknown>> } = {};
  try {
    parsed = JSON.parse(body?.choices?.[0]?.message?.content ?? "");
  } catch {
    throw new HttpError(502, "dispatch_garbled", "The dispatcher answered with something that isn't a lineup. Try again, or add parts by hand.");
  }
  const parts: ProposedPart[] = (parsed.parts ?? []).map((p) => ({
    title: String(p.title ?? ""), brief: String(p.brief ?? ""), why: String(p.why ?? ""), needsRealData: p.needsRealData === true,
    agentId: p.agentId && p.agentId !== "nobody" ? String(p.agentId) : null,
  })).filter((p) => p.title.trim());
  if (!parts.length) throw new HttpError(502, "dispatch_empty", "The dispatcher didn't propose any parts. Add them by hand, or give the room a fuller brief.");
  return { parts: checkLineup(parts, team), seconds: Math.round((Date.now() - started) / 100) / 10, model: body?.model ?? "local" };
}
