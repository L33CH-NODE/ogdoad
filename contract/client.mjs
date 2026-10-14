// Talking to the engine under test, the way Ogdoad does: on this machine, as the operator (a local
// engine treats a loopback request with its own Origin as the board), or as an agent with its key.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const ENGINE = (process.env.ENGINE_URL ?? "http://127.0.0.1:3410").replace(/\/+$/, "");
export const MAILBOX = (process.env.CONTRACT_MAILBOX_URL ?? "http://127.0.0.1:3413").replace(/\/+$/, "");
const TOKEN = process.env.CONTRACT_OPERATOR_TOKEN;

/**
 * Where Ogdoad's own engine does better, a test is a `todo` on the engine Ogdoad started on (expected to
 * fail there) and a real test on Nous: pass its result as the test's options.
 */
export const better = (why) => ((process.env.CONTRACT_ENGINE ?? "paperclip") === "nous" ? {} : { todo: `Ogdoad's own engine: ${why}` });

/** How the operator signs a request: the engine's own Origin, and the operator's token where the engine asks for one. */
export const operatorHeaders = { origin: ENGINE, ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) };

/** One request: the status and the parsed body (or the raw text when it isn't JSON). */
export async function call(method, path, body, headers = {}) {
  const res = await fetch(`${ENGINE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...operatorHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

/** A request that must succeed: its body. */
export async function ok(method, path, body, headers) {
  const r = await call(method, path, body, headers);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

/** A company of its own for each test file, so runs never see each other's work. */
export async function freshCompany(label) {
  return ok("POST", "/api/companies", { name: `Contract ${label} ${randomUUID().slice(0, 8)}` });
}

/** An agent hired through the live-agent adapter, the way SOPHIA's wizard does it. */
export async function liveAgent(companyId, name = "Contract Agent", extra = {}) {
  return ok("POST", `/api/companies/${companyId}/agents`, { name, role: "general", title: name, adapterType: "live_agent", adapterConfig: {}, ...extra });
}

// --- The hire's side: its mailbox, and the engine as the agent sees it on a job. ---------------------

const KEYS_DIR = process.env.CONTRACT_KEYS_DIR;

/** The agent's mailbox key (made by the engine the first time it has work for that agent). */
export async function mailboxKey(agentId) {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const file = join(KEYS_DIR, `${agentId}.key`);
  await eventually(() => existsSync(file), { what: `${agentId}'s mailbox key` });
  return readFileSync(file, "utf8").trim();
}

/** The next job for an agent, as a live hire takes it: the payload, plus how to talk back. */
export async function nextJob(agentId, { timeoutMs = 30_000 } = {}) {
  const key = await mailboxKey(agentId);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${MAILBOX}/v1/next?wait=5`, { headers: { authorization: `Bearer ${key}` } });
    if (res.status === 200) {
      const job = await res.json();
      const asAgent = { authorization: `Bearer ${job.env.PAPERCLIP_API_KEY}`, "x-paperclip-run-id": job.env.PAPERCLIP_RUN_ID };
      const mailbox = async (action, body = {}) => {
        const r = await fetch(`${MAILBOX}/v1/jobs/${job.jobId}/${action}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
      };
      return { job, asAgent, done: (body = { ok: true, summary: "done" }) => mailbox("done", body), heartbeat: () => mailbox("heartbeat") };
    }
    assert.equal(res.status, 204, `the mailbox answered ${res.status}`);
  }
  assert.fail(`no job for ${agentId} within ${timeoutMs} ms`);
}

/** No job arrives for an agent within a while (it wasn't woken). */
export async function noJob(agentId, waitSec = 6) {
  const key = await mailboxKey(agentId);
  const res = await fetch(`${MAILBOX}/v1/next?wait=${waitSec}`, { headers: { authorization: `Bearer ${key}` } });
  if (res.status === 200) {
    const job = await res.json();
    return { woken: true, wakeReason: job.wakeReason };
  }
  return { woken: false };
}

/** Wait until a condition holds (the engine works in the background), or fail with what was last seen. */
export async function eventually(check, { timeoutMs = 20_000, everyMs = 300, what = "the condition" } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await check();
    if (last) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  assert.fail(`timed out waiting for ${what}`);
}
