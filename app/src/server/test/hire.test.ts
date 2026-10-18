// Hiring from the control center, against a stand-in Horos (nothing real is started): the hire gets a
// folder of its own with its brief, Horos is asked with its token, and a local model has to be one
// that's actually on the machine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hire } from "../hire.js";

async function fakeHoros() {
  const spawned: any[] = [];
  const auth: string[] = [];
  const server = createServer((req, res) => {
    auth.push(String(req.headers.authorization));
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/detect") {
        return res.end(JSON.stringify({ harnesses: [{ id: "claude", name: "Claude Code", privacy: "cloud" }, { id: "ollama", name: "Ollama", privacy: "local" }], localModels: [{ runtime: "ollama", name: "small-model" }] }));
      }
      if (req.url === "/v1/hires" && req.method === "POST") {
        spawned.push(JSON.parse(body));
        res.statusCode = 201;
        return res.end(JSON.stringify({ id: "h-new" }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, spawned, auth, close: () => server.close() };
}

test("a hire gets its own folder and brief, and Horos is asked with its token", async () => {
  const h = await fakeHoros();
  const home = mkdtempSync(join(tmpdir(), "ogdoad-hire-"));
  const horos = { base: h.base, headers: () => ({ authorization: "Bearer made-up-token" }) };
  try {
    const made = await hire(horos, home, { harness: "claude", label: "Scout", brief: "Find three local plan managers.", keep: true }) as { id: string };
    assert.equal(made.id, "h-new");
    const body = h.spawned[0];
    assert.equal(body.harness, "claude");
    assert.equal(body.label, "Scout - Claude Code");
    assert.equal(body.keep, true);
    assert.equal(body.brief, "Find three local plan managers.");
    assert.ok(body.cwd.startsWith(join(home, "seats", "scout-")), "a folder of its own under seats");
    assert.match(readFileSync(join(body.cwd, "BRIEF.md"), "utf8"), /^# Scout\n\nFind three local plan managers\./);
    assert.ok(h.auth.every((a) => a === "Bearer made-up-token"));

    await assert.rejects(() => hire(horos, home, { harness: "ollama", label: "Ledger", model: "not-here" }), /local models on this machine/);
    await hire(horos, home, { harness: "ollama", label: "Ledger", model: "small-model", keep: false });
    assert.deepEqual([h.spawned[1].args, h.spawned[1].keep, existsSync(join(h.spawned[1].cwd, "BRIEF.md"))], [["run", "small-model"], false, false]);
    await assert.rejects(() => hire(horos, home, { harness: "codex" }), /isn't on this machine/);
  } finally {
    h.close();
  }
});

test("the hires' documents reach the shelf with where they came from", async () => {
  const { teamArtifacts } = await import("../teamArtifacts.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "ogdoad-docs-"));
  mkdirSync(join(home, "horos"));
  writeFileSync(join(home, "horos", "roster.json"), JSON.stringify([{ id: "h1", harness: "claude", label: "SOPHIA - Claude Code", seat: { agentId: "ag-1" } }]));
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const at = "2026-10-10T01:00:00.000Z";
    if (req.url?.startsWith("/v1/companies/co/tasks")) return res.end(JSON.stringify({ items: [{ id: "i1", identifier: "OGD-1", title: "Set up", updatedAt: at }] }));
    if (req.url === "/v1/companies/co/members") return res.end(JSON.stringify({ items: [{ id: "ag-1", name: "SOPHIA - Claude Code" }] }));
    if (req.url === "/v1/tasks/i1/docs") return res.end(JSON.stringify({ items: [{ id: "d1", taskId: "i1", key: "profile", title: "Company profile", authorId: "ag-1", updatedAt: at }] }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found", message: "No such thing." }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const list = await teamArtifacts(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, "co", home);
    assert.equal(list?.length, 1);
    const [d] = list!;
    assert.deepEqual([d.kind, d.title, d.by, d.via, d.tier, d.ref], ["document", "Company profile · OGD-1", "SOPHIA", "Claude Code", "made by a cloud hire", "/team/task/i1"]);
    assert.deepEqual(d.source, { issueId: "i1", key: "profile" });
    assert.equal(await teamArtifacts("http://127.0.0.1:9", "other", home), null, "a server that can't be read gives nothing, not an error");
  } finally {
    server.close();
  }
});
