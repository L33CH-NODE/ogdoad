// Project rooms, against a stand-in Ogdoad server (nothing real is created or woken): opening a room
// makes a project and its thread, parts hang under the thread and tell their hire who else is on the
// job, the room reads every thread in time order, and every message is noted for everyone it reaches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crossings, mentionsIn } from "../crossings.js";
import { checkLineup } from "../dispatch/dispatch.js";
import { openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";
import { raisedFromMembrane } from "../membrane/outbox.js";
import { Rooms, type Check } from "../rooms.js";
import { standIn } from "../work/work.js";

const CID = "co-1";

async function fakeEngine() {
  const projects: any[] = [{ id: "p-old", name: "Old idea", status: "backlog", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", archivedAt: "2026-10-02T00:00:00Z" }];
  const issues: any[] = [{ id: "i-other", title: "Not in any room", status: "todo", projectId: "p-elsewhere", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }];
  const comments: any[] = [];
  const typed: Array<{ hireId: string; text: string }> = [];
  const agents: any[] = [{ id: "a-sophia", name: "SOPHIA - Claude Code", status: "active" }, { id: "a-scout", name: "Scout - grok CLI", status: "active" }, { id: "a-gone", name: "Gone", status: "terminated" }];
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
      if ((m = /^\/api\/agents\/([^/]+)\/pause$/.exec(url.pathname)) && req.method === "POST") {
        const a = agents.find((x) => x.id === m![1]);
        if (a) a.status = "paused";
        return a ? send(200, a) : send(404, { error: "Agent not found" });
      }
      // Horos's prompt route, for what's typed into a hire's terminal.
      if ((m = /^\/v1\/hires\/([^/]+)\/prompt$/.exec(url.pathname)) && req.method === "POST") {
        typed.push({ hireId: m[1], text: body.text });
        return send(200, { ok: true });
      }
      if (url.pathname === `/api/companies/${CID}/live-runs`) return send(200, issues.filter((i) => i.assigneeAgentId === "a-scout").map((i) => ({ id: "r1", agentId: "a-scout", issueId: i.id, status: "running", startedAt: now() })));
      send(404, { error: "no" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const agentSays = (issueId: string, agentId: string, text: string) => comments.push({ id: `c-${++n}`, issueId, body: text, createdAt: now(), authorAgentId: agentId });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, projects, issues, comments, agents, typed, agentSays, close: () => server.close() };
}

function setup(practice = false) {
  const home = mkdtempSync(join(tmpdir(), "ogdoad-rooms-"));
  mkdirSync(join(home, "horos"));
  writeFileSync(join(home, "horos", "roster.json"), JSON.stringify([
    { id: "h-sophia", harness: "claude", label: "SOPHIA - Claude Code", seat: { agentId: "a-sophia" } },
    { id: "h-scout", harness: "grok", label: "Scout - grok CLI", seat: { agentId: "a-scout" } },
    { id: "h-ledger", harness: "ollama", label: "Ledger - Ollama" },
  ]));
  const money = new Money(openMoneyDb(":memory:"));
  return { home, money, practice };
}

/** What came back was sent, not held for a check. */
function sent<T>(x: T | { held: Check }): T {
  assert.ok(!(x && typeof x === "object" && "held" in x), "sent at once, not held");
  return x as T;
}
function held(x: unknown): Check {
  assert.ok(x && typeof x === "object" && "held" in x, "held for the operator's check");
  return (x as { held: Check }).held;
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
    const opened = sent(await rooms.open({ name: "Launch the price page", brief: "Ship the new price page this week.", leadAgentId: "a-sophia" }));
    const project = e.projects.find((p) => p.id === opened.id)!;
    assert.deepEqual([project.name, project.status, project.leadAgentId], ["Launch the price page", "in_progress", "a-sophia"]);
    const thread = e.issues.find((i) => i.projectId === opened.id)!;
    assert.equal(thread.title, "The room: Launch the price page");
    assert.equal(thread.assigneeAgentId, "a-sophia");
    assert.match(thread.description, /^Ship the new price page this week\.\n\n---\n\nThis is the room/);
    assert.match(thread.description, /\[@Name\]\(agent:\/\/their-agent-id\)/, "the thread tells hires how to bring each other in");

    const part = sent(await rooms.addPart(opened.id, { title: "Research competitor prices", brief: "Three competitors, monthly prices.", agentId: "a-scout" }));
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
    assert.deepEqual(room.messages.map((m) => (m.kind === "said" ? `${m.from}:${m.body.slice(0, 10)}` : m.kind === "opened" ? `opened:${m.title}` : `note:${m.body}`)), [
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
    const said = sent(await rooms.say("p-sophia", { body: "How's it going?" }));
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
    // (never opening a second one), and can speak in it, after a look: its made-up books can't know the
    // real clients, so everything it sends waits for one.
    e.issues.push({ id: "i-room", identifier: "SOL-9", title: "The room: Real project", status: "todo", projectId: "p-x", parentId: null, assigneeAgentId: "a-sophia", createdAt: "2026-10-09T00:00:01Z", updatedAt: "2026-10-09T00:00:01Z" });
    e.issues.push({ id: "i-part", identifier: "SOL-10", title: "A part", status: "todo", projectId: "p-x", parentId: "i-room", assigneeAgentId: "a-scout", createdAt: "2026-10-09T00:00:02Z", updatedAt: "2026-10-09T00:00:02Z" });
    const room = await rooms.get("p-x");
    assert.equal(room.threadId, "i-room");
    assert.deepEqual(room.parts.filter((p) => !p.thread).map((p) => p.title), ["A part"]);
    const check = held(await rooms.say("p-x", { body: "From the practice copy" }));
    assert.match(check.notes[0], /doesn't know your real clients/);
    const r = await rooms.sendHeld(check.id, check.digest);
    assert.ok("sent" in r);
    assert.equal((r.sent as { issueId: string }).issueId, "i-room");
    assert.equal(e.issues.length, 3, "no second thread");
  } finally {
    e.close();
  }
});

test("the membrane in a room: held for a check, sent as checked, kept local, and real details come back", async () => {
  const e = await fakeEngine();
  const { home, money } = setup();
  const alarms: string[] = [];
  try {
    const juniper = money.createClient({ name: "Juniper Ashgrove", participantName: "Juniper Ashgrove", email: "juniper.ashgrove@mail.example" }, "test");
    const j = standIn(juniper.id, "Juniper Ashgrove");
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home, onAlarm: (t) => alarms.push(t) });
    const opened = sent(await rooms.open({ name: "Chase the overdue", brief: "", leadAgentId: "a-sophia" }));
    const before = e.comments.length;

    // A real name: held, nothing posted, and Flow carries a card until it's decided.
    const check = held(await rooms.say(opened.id, { body: "Draft a gentle reminder for Juniper Ashgrove about invoice 106." }));
    assert.equal(e.comments.length, before, "nothing left yet");
    assert.equal(check.pieces[0].text, `Draft a gentle reminder for ${j} about invoice 106.`);
    assert.deepEqual(check.pieces[0].changes.map((c) => [c.original, c.token]), [["Juniper Ashgrove", j]]);
    assert.deepEqual(check.reaches.map((r) => r.who), ["SOPHIA"]);
    assert.ok(check.canKeep);
    assert.ok(raisedFromMembrane(money).some((r) => r.key === `membrane:check:${check.id}`));
    assert.deepEqual((await rooms.get(opened.id)).held.map((h) => h.id), [check.id]);

    // Changed words are checked again; a stale look can't send.
    const edited = await rooms.editHeld(check.id, ["Draft a firm reminder for Juniper's invoice 106."]);
    assert.equal(edited.pieces[0].text, `Draft a firm reminder for ${j}'s invoice 106.`);
    assert.ok("changed" in (await rooms.sendHeld(check.id, check.digest)));
    const r = await rooms.sendHeld(check.id, edited.digest);
    assert.ok("sent" in r);
    const posted = e.comments.at(-1)!;
    assert.equal(posted.body, `Draft a firm reminder for ${j}'s invoice 106.`, "the engine holds the stand-in only");
    assert.ok(!crossings(money).some((c) => c.what.includes("Juniper")), "and so does the crossings log");
    assert.ok(!raisedFromMembrane(money).some((x) => x.key === `membrane:check:${check.id}`), "the Flow card clears");
    await assert.rejects(() => rooms.sendHeld(check.id, edited.digest), /already dealt with/);

    // SOPHIA answers with the stand-in: the room knows who it is, on the operator's screen.
    e.agentSays(posted.issueId, "a-sophia", `Done: the reminder for ${j} is drafted.`);
    let room = await rooms.get(opened.id);
    assert.deepEqual(room.links[j], { real: "Juniper Ashgrove", kind: "who" });
    assert.equal(alarms.length, 0);

    // Kept local: a note in the room, never posted.
    const keep = held(await rooms.say(opened.id, { body: "Juniper prefers a call first." }));
    rooms.keepHeld(keep.id);
    room = await rooms.get(opened.id);
    assert.ok(room.messages.some((m) => m.kind === "note" && m.body === "Juniper prefers a call first."));
    assert.equal(e.comments.filter((c) => /prefers a call/.test(c.body)).length, 0);
    const drop = held(await rooms.say(opened.id, { body: "Email juniper.ashgrove@mail.example" }));
    rooms.dropHeld(drop.id);
    assert.equal((await rooms.get(opened.id)).held.length, 0);

    // A cloud hire writes a client's real name it was never sent: an alarm, once, and it's paused.
    e.agentSays(posted.issueId, "a-sophia", "I looked up Juniper Ashgrove online.");
    room = await rooms.get(opened.id);
    const leak = room.messages.find((m) => m.kind === "said" && m.body.includes("looked up"));
    assert.ok(leak && leak.kind === "said" && leak.warnings?.some((w) => w.kind === "real"));
    assert.equal(alarms.length, 1);
    assert.equal(e.agents.find((a) => a.id === "a-sophia").status, "paused");
    assert.ok(room.members.find((m) => m.agentId === "a-sophia")!.paused);
    assert.ok(raisedFromMembrane(money).some((x) => x.key === `membrane:alarm:${(leak as { id: string }).id}` && x.urgency === 3));
    await rooms.get(opened.id);
    assert.equal(alarms.length, 1, "once");
  } finally {
    e.close();
  }
});

test("the gate covers every way out: a room's brief, a task's thread, a hire's terminal", async () => {
  const e = await fakeEngine();
  const { home, money } = setup();
  try {
    money.createClient({ name: "Marlo Vance" }, "test");
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home, horos: { base: e.base, headers: () => ({}) } });

    // A room's brief: the project is made only once it's checked, with stand-ins.
    const check = held(await rooms.open({ name: "Marlo's plan review", brief: "Summarise Marlo Vance's goals.", leadAgentId: "a-sophia" }));
    assert.equal(e.projects.length, 1, "nothing made yet");
    assert.deepEqual(check.pieces.map((p) => p.label), ["Name", "Brief"]);
    await rooms.sendHeld(check.id, check.digest);
    const project = e.projects.at(-1)!;
    assert.match(project.name, /^C-\d{4}'s plan review$/);
    assert.match(project.description, /^Summarise C-\d{4}'s goals\.$/);
    // The operator reads it with the name back: the whole name, since a first name stood in for the person.
    assert.equal((await rooms.list()).find((x) => x.id === project.id)!.name, "Marlo Vance's plan review");

    // A message on any task (what the browser posts as a comment): plain goes straight, a phone waits.
    const plain = sent(await rooms.sayOn("i-other", { body: "Morning. Anything blocked?" }));
    assert.equal(plain.issueId, "i-other");
    assert.ok(held(await rooms.sayOn("i-other", { body: "Ring them on 0412 345 678." })).pieces[0].text.startsWith("Ring them on PHONE-"));

    // A local model's terminal may read Tier 0; a cloud CLI's goes through the membrane.
    sent(await rooms.prompt("h-ledger", "Total Marlo Vance's hours this month."));
    assert.deepEqual(e.typed.at(-1), { hireId: "h-ledger", text: "Total Marlo Vance's hours this month." });
    const typed = held(await rooms.prompt("h-scout", "Look into Marlo Vance's provider."));
    assert.equal(typed.reaches[0].where, "cloud");
    await rooms.sendHeld(typed.id, typed.digest);
    assert.match(e.typed.at(-1)!.text, /^Look into C-\d{4}'s provider\.$/);
  } finally {
    e.close();
  }
});

test("the operator has the last word: what goes is theirs to edit, and a real detail goes only on a second yes", async () => {
  const e = await fakeEngine();
  const { home, money } = setup();
  try {
    const juniper = money.createClient({ name: "Juniper Ashgrove", participantName: "Juniper Ashgrove" }, "test");
    const j = standIn(juniper.id, "Juniper Ashgrove");
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home });
    const opened = sent(await rooms.open({ name: "Reminders", brief: "", leadAgentId: "a-sophia" }));

    // They rewrite what goes, keeping the stand-in: sent exactly as they wrote it.
    const a = held(await rooms.say(opened.id, { body: "Remind Juniper Ashgrove about invoice 106." }));
    const mine = await rooms.setOutgoing(a.id, [`Please draft a kind reminder to ${j} (invoice 106).`]);
    assert.ok(mine.pieces[0].edited);
    assert.deepEqual(mine.pieces[0].exposed, []);
    assert.deepEqual(mine.links[j], { real: "Juniper Ashgrove", kind: "who" });
    await rooms.sendHeld(a.id, mine.digest);
    assert.equal(e.comments.at(-1)!.body, `Please draft a kind reminder to ${j} (invoice 106).`);

    // They put the real name back: the card points it out, with its stand-in, and approving takes a second yes.
    const b = held(await rooms.say(opened.id, { body: "Juniper Ashgrove asked for a copy." }));
    const back = await rooms.setOutgoing(b.id, ["Juniper Ashgrove asked for a copy."]);
    assert.deepEqual(back.pieces[0].exposed!.map((x) => [x.original, x.token]), [["Juniper Ashgrove", j]]);
    await assert.rejects(() => rooms.sendHeld(b.id, back.digest), /Approve again/);
    await rooms.sendHeld(b.id, back.digest, true);
    assert.equal(e.comments.at(-1)!.body, "Juniper Ashgrove asked for a copy.", "their call, sent as written");

    // Handing it back to the membrane, and denying: each decision is noted, for a local decider to learn from.
    const c = held(await rooms.say(opened.id, { body: "Juniper Ashgrove again." }));
    await rooms.setOutgoing(c.id, ["Something else entirely."]);
    assert.equal((await rooms.setOutgoing(c.id, null)).pieces[0].text, `${j} again.`);
    rooms.dropHeld(c.id);
    const decisions = (money.db.prepare("SELECT kind, detail FROM events WHERE kind LIKE 'held_%' AND kind <> 'held' ORDER BY id").all() as Array<{ kind: string; detail: string }>).map((r) => [r.kind, JSON.parse(r.detail).decision, JSON.parse(r.detail).edited, JSON.parse(r.detail).exposed ?? 0]);
    assert.deepEqual(decisions, [["held_sent", "approved", true, 0], ["held_sent", "approved", true, 1], ["held_dropped", "denied", false, 0]]);
  } finally {
    e.close();
  }
});

test("the dispatcher's rule: real records go only to a local hire, whatever the model says", () => {
  const team = [
    { agentId: "a-sophia", name: "SOPHIA", via: "Claude Code", where: "cloud", role: "ceo", title: null, capabilities: null },
    { agentId: "a-ledger", name: "Ledger", via: "Ollama", where: "local", role: "bookkeeper", title: null, capabilities: null },
  ];
  const [moved, unknown, fine] = checkLineup([
    { title: "Read last quarter's invoices", brief: "", agentId: "a-sophia", why: "", needsRealData: true },
    { title: "Something", brief: "", agentId: "a-ghost", why: "", needsRealData: false },
    { title: "Write the copy", brief: "", agentId: "a-sophia", why: "", needsRealData: false },
  ], team);
  assert.equal(moved.agentId, "a-ledger");
  assert.match(moved.problem!, /moved to Ledger/);
  assert.equal(unknown.agentId, null);
  assert.equal(fine.problem, undefined);
  const [nobody] = checkLineup([{ title: "Read the books", brief: "", agentId: "a-sophia", why: "", needsRealData: true }], team.slice(0, 1));
  assert.equal(nobody.agentId, null);
  assert.match(nobody.problem!, /no local hire/);
});

test("a lineup from the local dispatcher: stand-ins in, the rule checked, the operator approves or denies", async () => {
  const e = await fakeEngine();
  const { home, money } = setup();
  const asked: string[] = [];
  let up = false;
  // A stand-in for the dispatcher's model (an OpenAI-shaped chat endpoint): it puts the invoice part on
  // SOPHIA, a cloud hire, which the rule must move.
  const llm = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => {
      if (!up) return res.destroy();
      asked.push(JSON.parse(raw).messages[1].content);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "qwen3.5-4b", choices: [{ message: { content: JSON.stringify({ parts: [
        { title: "Research competitor prices", brief: "Three competitors, monthly prices.", agentId: "a-scout", why: "Scout researches the web.", needsRealData: false },
        { title: "Read the invoices", brief: "What did the clients actually buy?", agentId: "a-sophia", why: "She plans.", needsRealData: true },
      ] }) } }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  let woken = 0;
  try {
    e.agents.push({ id: "a-ledger", name: "Ledger - Ollama", status: "active" });
    const roster = JSON.parse(readFileSync(join(home, "horos", "roster.json"), "utf8"));
    roster.push({ id: "h-ledger2", harness: "ollama", label: "Ledger - Ollama", seat: { agentId: "a-ledger" } });
    writeFileSync(join(home, "horos", "roster.json"), JSON.stringify(roster));
    const juniper = money.createClient({ name: "Juniper Ashgrove", participantName: "Juniper Ashgrove" }, "test");
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home, dispatch: { url, wake: async () => { woken++; up = true; } } });
    const check = held(await rooms.open({ name: "Price page", brief: "Three plans. Use Juniper Ashgrove's invoices to see what clients buy.", leadAgentId: "a-sophia" }));
    await rooms.sendHeld(check.id, check.digest);
    const room = e.projects.at(-1)!;

    // Resting at first: woken once, then asked. It's given stand-ins only.
    const lineup = await rooms.proposeLineup(room.id);
    assert.equal(woken, 1);
    assert.ok(asked[0].includes(standIn(juniper.id, "Juniper Ashgrove")) && !asked[0].includes("Juniper"), "the model sees the stand-in, never the name");
    assert.match(asked[0], /a-ledger: Ledger \(Ollama, local\)/);
    assert.deepEqual(lineup.parts.map((p) => [p.title, p.agentId]), [["Research competitor prices", "a-scout"], ["Read the invoices", "a-ledger"]], "the real-data part is moved to the local hire");

    // Approving holds the operator to the rule too.
    await assert.rejects(() => rooms.approveLineup(room.id, { parts: [{ ...lineup.parts[1], agentId: "a-sophia" }], proposed: lineup.parts }), /only go to a local hire/);
    const before = e.issues.length;
    const ok = await rooms.approveLineup(room.id, { parts: [lineup.parts[0], { ...lineup.parts[1], title: "Read last quarter's invoices" }], proposed: lineup.parts });
    assert.equal(ok.added, 2);
    assert.equal(e.issues.length, before + 2);
    assert.match(e.issues.at(-1)!.description, /stays with a local hire/);
    rooms.denyLineup(room.id, { proposed: lineup.parts });
    const notes = (money.db.prepare("SELECT detail FROM events WHERE kind = 'lineup_decided' ORDER BY id").all() as Array<{ detail: string }>).map((r) => JSON.parse(r.detail));
    assert.deepEqual(notes.map((n) => [n.decision, n.changed ?? null]), [["approved", 1], ["denied", null]]);

    // Down and not waking: a plain message, not a hang.
    up = false;
    const resting = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home, dispatch: { url: "http://127.0.0.1:9", wake: async () => {} } });
    await assert.rejects(() => resting.proposeLineup(room.id), /didn't answer/);
  } finally {
    llm.close();
    e.close();
  }
});

test("a local hire may hold real records, but not where cloud hires read them", async () => {
  const e = await fakeEngine();
  const { home, money } = setup();
  const alarms: string[] = [];
  try {
    e.agents.push({ id: "a-ledger", name: "Ledger - Ollama", status: "active" });
    const roster = JSON.parse(readFileSync(join(home, "horos", "roster.json"), "utf8"));
    roster.push({ id: "h-ledger3", harness: "ollama", label: "Ledger - Ollama", seat: { agentId: "a-ledger" } });
    writeFileSync(join(home, "horos", "roster.json"), JSON.stringify(roster));
    money.createClient({ name: "Juniper Ashgrove" }, "test");
    const rooms = new Rooms(money, { serverUrl: e.base, companyId: CID, practice: false, home, onAlarm: (t) => alarms.push(t) });

    // A room SOPHIA (cloud) leads: Ledger's real name in it is exposed to the cloud.
    const shared = sent(await rooms.open({ name: "Thank-you notes", brief: "", leadAgentId: "a-sophia" }));
    const part = sent(await rooms.addPart(shared.id, { title: "Tally the year", brief: "", agentId: "a-ledger" }));
    e.agentSays(part.id, "a-ledger", "Top client this year: Juniper Ashgrove.");
    await rooms.get(shared.id);
    assert.deepEqual(alarms, ["Ledger put a real detail where the cloud can read it"]);
    assert.equal(e.agents.find((a) => a.id === "a-ledger").status, "active", "a local hire isn't paused for holding real data");
    assert.ok(raisedFromMembrane(money).some((r) => r.urgency === 3 && /works locally/.test(r.context)));

    // A room only local hires read: the same message is fine.
    const own = sent(await rooms.open({ name: "Books", brief: "", leadAgentId: "a-ledger" }));
    const thread = e.issues.find((i) => i.projectId === own.id)!;
    e.agentSays(thread.id, "a-ledger", "Juniper Ashgrove paid in full.");
    await rooms.get(own.id);
    assert.equal(alarms.length, 1);
  } finally {
    e.close();
  }
});
