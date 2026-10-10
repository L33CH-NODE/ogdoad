// Project rooms, against a stand-in Ogdoad server (nothing real is created or woken): opening a room
// makes a project and its thread, parts hang under the thread and tell their hire who else is on the
// job, the room reads every thread in time order, and every message is noted for everyone it reaches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crossings, mentionsIn } from "../crossings.js";
import { openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";
import { Rooms } from "../rooms.js";

const CID = "co-1";

async function fakeEngine() {
  const projects: any[] = [{ id: "p-old", name: "Old idea", status: "backlog", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: "2026-10-02T00:00:00Z" }];
  const issues: any[] = [{ id: "i-other", title: "Not in any room", status: "todo", projectId: "p-elsewhere", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }];
  const comments: any[] = [];
  const agents = [{ id: "a-sophia", name: "SOPHIA - Claude Code", status: "active" }, { id: "a-scout", name: "Scout - grok CLI", status: "active" }, { id: "a-gone", name: "Gone", status: "terminated" }];
  let n = 0;
  let clock = Date.parse("2026-10-10T09:00:00Z");
  const now = () => new Date((clock += 1000)).toISOString();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => {
      const url = new URL(req.url!, "http://x");
      const body = raw ? JSON.parse(raw) : {};
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      let m: RegExpExecArray | null;
      if (url.pathname === `/api/companies/${CID}/projects`) {
        if (req.method === "POST") {
          const p = { id: `p-${++n}`, ...body, createdAt: now(), updatedAt: now() };
          projects.push(p);
          return send(201, p);
        }
        return send(200, projects);
      }
      if ((m = /^\/api\/projects\/([^/]+)$/.exec(url.pathname))) {
        const p = projects.find((x) => x.id === m![1]);
        return p ? send(200, p) : send(404, { error: "Project not found" });
      }
      if (url.pathname === `/api/companies/${CID}/issues`) {
        if (req.method === "POST") {
          const i = { id: `i-${++n}`, identifier: `SOL-${n}`, createdAt: now(), updatedAt: now(), createdByUserId: "local", ...body };
          issues.push(i);
          return send(201, i);
        }
        // Wrapped, to prove both list shapes are read.
        return send(200, { items: issues.filter((i) => !url.searchParams.get("projectId") || i.projectId === url.searchParams.get("projectId")) });
      }
      if ((m = /^\/api\/issues\/([^/]+)$/.exec(url.pathname))) return send(200, issues.find((i) => i.id === m![1]) ?? {});
      if ((m = /^\/api\/issues\/([^/]+)\/comments$/.exec(url.pathname))) {
        if (req.method === "POST") {
          const c = { id: `c-${++n}`, issueId: m[1], body: body.body, createdAt: now(), authorUserId: "local" };
          comments.push(c);
          return send(201, c);
        }
        return send(200, comments.filter((c) => c.issueId === m![1]).reverse());
      }
      if (url.pathname === `/api/companies/${CID}/agents`) return send(200, agents);
      if (url.pathname === `/api/companies/${CID}/live-runs`) return send(200, issues.filter((i) => i.assigneeAgentId === "a-scout").map((i) => ({ id: "r1", agentId: "a-scout", issueId: i.id, status: "running", startedAt: now() })));
      send(404, { error: "no" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const agentSays = (issueId: string, agentId: string, text: string) => comments.push({ id: `c-${++n}`, issueId, body: text, createdAt: now(), authorAgentId: agentId });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, projects, issues, comments, agentSays, close: () => server.close() };
}

function setup(practice = false) {
  const home = mkdtempSync(join(tmpdir(), "ogdoad-rooms-"));
  mkdirSync(join(home, "horos"));
  writeFileSync(join(home, "horos", "roster.json"), JSON.stringify([
    { id: "h-sophia", harness: "claude", label: "SOPHIA - Claude Code", seat: { agentId: "a-sophia" } },
    { id: "h-scout", harness: "grok", label: "Scout - grok CLI", seat: { agentId: "a-scout" } },
  ]));
  const money = new Money(openMoneyDb(":memory:"));
  return { home, money, practice };
}

test("mentions are read in the engine's own form, each once", () => {
  assert.deepEqual(mentionsIn("[@Scout](agent://a-scout) and [@SOPHIA](agent://a-sophia), [@Scout](agent://a-scout) again, @plain text"), ["a-scout", "a-sophia"]);
  assert.deepEqual(mentionsIn("no one here"), []);
});

test("a room is a project with its own thread, and parts tell their hire who else is on the job", async () => {
  const e = await fakeEngine();
  const { home, money } = setup();
  try {
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home });
    const opened = await rooms.open({ name: "Launch the price page", brief: "Ship the new price page this week.", leadAgentId: "a-sophia" });
    const project = e.projects.find((p) => p.id === opened.id)!;
    assert.deepEqual([project.name, project.status, project.leadAgentId], ["Launch the price page", "in_progress", "a-sophia"]);
    const thread = e.issues.find((i) => i.projectId === opened.id)!;
    assert.equal(thread.title, "The room: Launch the price page");
    assert.equal(thread.assigneeAgentId, "a-sophia");
    assert.match(thread.description, /^Ship the new price page this week\.\n\n---\n\nThis is the room/);
    assert.match(thread.description, /\[@Name\]\(agent:\/\/their-agent-id\)/, "the thread tells hires how to bring each other in");

    const part = await rooms.addPart(opened.id, { title: "Research competitor prices", brief: "Three competitors, monthly prices.", agentId: "a-scout" });
    const made = e.issues.find((i) => i.id === part.id)!;
    assert.deepEqual([made.parentId, made.projectId, made.assigneeAgentId, made.status], [thread.id, opened.id, "a-scout", "todo"]);
    assert.match(made.description, new RegExp(`Its room is ${thread.identifier}`));
    assert.match(made.description, /The others on this project: \[@SOPHIA\]\(agent:\/\/a-sophia\)\./, "its hire learns who else is on the job, mention-ready");

    // The part's hire answers on its part, and mentions SOPHIA: the room reads it all in order.
    e.agentSays(part.id, "a-scout", "Found three. [@SOPHIA](agent://a-sophia) want them in a table?");
    await rooms.say(opened.id, { body: "Yes please, a table. [@Scout](agent://a-scout)" });
    const room = await rooms.get(opened.id);
    assert.equal(room.threadId, thread.id);
    assert.deepEqual(room.parts.map((p) => [p.title, p.thread]), [["The room: Launch the price page", true], ["Research competitor prices", false]]);
    assert.deepEqual(room.messages.map((m) => (m.kind === "said" ? `${m.from}:${m.body.slice(0, 10)}` : `opened:${m.title}`)), [
      "opened:The room: Launch the price page",
      "opened:Research competitor prices",
      "agent:Found thre",
      "you:Yes please",
    ]);
    assert.deepEqual(room.members.map((m) => [m.name, m.hireId, m.where]).sort(), [["SOPHIA", "h-sophia", "cloud"], ["Scout", "h-scout", "cloud"]]);
    assert.ok(!room.everyone.some((m) => m.name === "Gone"), "a terminated agent can't be mentioned");
    assert.deepEqual(room.running.map((r) => [r.agentId, r.issueId]), [["a-scout", part.id]], "who is working on which part right now");
    assert.equal(room.openCount, 1);

    // Every message that left is noted for everyone it reached: the briefs, and the reply to both.
    assert.ok(crossings(money).some((c) => c.what === "Yes please, a table. @Scout"), "mentions read as names in the log");
    const seen = crossings(money).map((c) => `${c.who}:${c.what.slice(0, 18)}`).sort();
    assert.deepEqual(seen, [
      "SOPHIA:Ship the new price",
      "SOPHIA:Yes please, a tabl",
      "Scout:Research competito",
      "Scout:Yes please, a tabl",
    ]);

    // The rooms list: live projects only, never an archived one.
    const list = await rooms.list();
    assert.deepEqual(list.map((r) => [r.name, r.partCount, r.hasThread]), [["Launch the price page", 1, true]]);
  } finally {
    e.close();
  }
});

test("a project started elsewhere gets its thread when the operator first speaks, and parts stay in their room", async () => {
  const e = await fakeEngine();
  const { home, money } = setup();
  try {
    e.projects.push({ id: "p-sophia", name: "SOPHIA's own project", status: "planned", leadAgentId: "a-sophia", createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" });
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home });
    assert.equal((await rooms.get("p-sophia")).threadId, null);
    const said = await rooms.say("p-sophia", { body: "How's it going?" });
    const room = await rooms.get("p-sophia");
    assert.equal(room.threadId, said.issueId);
    assert.equal(e.issues.find((i) => i.id === said.issueId)!.assigneeAgentId, "a-sophia", "the project's lead reads its thread");
    await assert.rejects(() => rooms.say("p-sophia", { body: "hi", partId: "i-other" }), /isn't in this room/);
    await assert.rejects(() => rooms.say("p-sophia", { body: "   " }), /Nothing to send/);
  } finally {
    e.close();
  }
});

test("the practice copy can look at rooms but can't start work in them", async () => {
  const e = await fakeEngine();
  const { home, money } = setup(true);
  try {
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: true, home });
    await assert.rejects(() => rooms.open({ name: "Anything" }), /from your real Ogdoad/);
    e.projects.push({ id: "p-x", name: "Real project", status: "in_progress", createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" });
    await assert.rejects(() => rooms.addPart("p-x", { title: "A part" }), /from your real Ogdoad/);
    assert.equal((await rooms.list()).length, 1);
    assert.equal(e.issues.length, 1, "nothing was created");

    // A room the real app opened: the practice copy's books never saw its thread, but find it by name
    // (never opening a second one), and can speak in it.
    e.issues.push({ id: "i-room", identifier: "SOL-9", title: "The room: Real project", status: "todo", projectId: "p-x", parentId: null, assigneeAgentId: "a-sophia", createdAt: "2026-10-09T00:00:01Z", updatedAt: "2026-10-09T00:00:01Z" });
    e.issues.push({ id: "i-part", identifier: "SOL-10", title: "A part", status: "todo", projectId: "p-x", parentId: "i-room", assigneeAgentId: "a-scout", createdAt: "2026-10-09T00:00:02Z", updatedAt: "2026-10-09T00:00:02Z" });
    const room = await rooms.get("p-x");
    assert.equal(room.threadId, "i-room");
    assert.deepEqual(room.parts.filter((p) => !p.thread).map((p) => p.title), ["A part"]);
    const said = await rooms.say("p-x", { body: "From the practice copy" });
    assert.equal(said.issueId, "i-room");
    assert.equal(e.issues.length, 3, "no second thread");
  } finally {
    e.close();
  }
});
