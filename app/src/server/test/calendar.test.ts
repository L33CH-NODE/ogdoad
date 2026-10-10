// The calendar sync, against a stand-in CalDAV server: shifts go out as stand-in events with their
// times, changes go out once, a move in the calendar moves the shift, a deletion there cancels a shift
// still ahead, and a cancelled shift's event is removed. Times survive timezones and daylight saving.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { syncFlow } from "../center.js";
import { Flow } from "../flow/flow.js";
import { openMoneyDb } from "../money/db.js";
import { addDays, Money } from "../money/service.js";
import { CalendarSync, parseEvent, parseMultistatus, shiftIcs, standIn, zonedToUtc } from "../work/calendar.js";
import { Work } from "../work/work.js";

test("wall-clock times become the right moments, across daylight saving", () => {
  assert.equal(zonedToUtc("2026-10-10", "09:00", "Australia/Brisbane").toISOString(), "2026-10-09T23:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-10", "09:00", "Australia/Sydney").toISOString(), "2026-10-09T22:00:00.000Z", "Sydney is on daylight time");
  assert.equal(zonedToUtc("2026-09-30", "09:00", "Australia/Sydney").toISOString(), "2026-09-29T23:00:00.000Z", "and wasn't a week earlier");
});

test("events are read in any of the usual shapes; all-day ones are left alone", () => {
  const tz = "Australia/Brisbane";
  const ev = (start: string, end: string) => `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x1\r\n${start}\r\n${end}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  assert.deepEqual(parseEvent(ev("DTSTART:20261009T230000Z", "DTEND:20261010T023000Z"), tz), { uid: "x1", day: "2026-10-10", start: "09:00", end: "12:30" });
  assert.deepEqual(parseEvent(ev("DTSTART;TZID=Australia/Sydney:20261010T100000", "DTEND;TZID=Australia/Sydney:20261010T133000"), tz), { uid: "x1", day: "2026-10-10", start: "09:00", end: "12:30" }, "another zone's clock, read as ours");
  assert.deepEqual(parseEvent(ev("DTSTART:20261010T220000", "DTEND:20261011T070000"), tz), { uid: "x1", day: "2026-10-10", start: "22:00", end: "07:00" }, "floating time is ours; past midnight is fine");
  assert.equal(parseEvent(ev("DTSTART;VALUE=DATE:20261010", "DTEND;VALUE=DATE:20261011"), tz), null);
  const folded = "BEGIN:VEVENT\r\nUID:long-\r\n uid\r\nDTSTART:20261009T230000Z\r\nDTEND:20261010T000000Z\r\nEND:VEVENT";
  assert.equal(parseEvent(folded, tz)?.uid, "long-uid", "folded lines are unfolded");
});

test("a multistatus answer is read whatever its namespace prefixes", () => {
  const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <D:response><D:href>/me/shifts/a.ics</D:href><D:propstat><D:prop><D:getetag>"e1"</D:getetag><C:calendar-data>BEGIN:VCALENDAR&#13;
UID:a&#13;
END:VCALENDAR</C:calendar-data></D:prop></D:propstat></D:response>
    <response xmlns="DAV:"><href>/me/shifts/b.ics</href><propstat><prop><getetag>"e2"</getetag><calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[UID:b]]></calendar-data></prop></propstat></response>
  </D:multistatus>`;
  const r = parseMultistatus(xml);
  assert.deepEqual(r.map((x) => [x.href, x.etag]), [["/me/shifts/a.ics", '"e1"'], ["/me/shifts/b.ics", '"e2"']]);
  assert.match(r[0].ics, /UID:a/);
  assert.equal(r[1].ics, "UID:b");
});

/** A small CalDAV server: one collection, events in memory, etags that change on every write. */
async function fakeCalDav(opts: { etagOnPut?: boolean } = {}) {
  const items = new Map<string, { ics: string; etag: string }>();
  let n = 0;
  const auths: string[] = [];
  const server = createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? ""));
    const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      if (req.method === "REPORT" && path === "/me/shifts/") {
        const xml = [...items].map(([href, it]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${it.etag}</d:getetag><cal:calendar-data>${it.ics.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</cal:calendar-data></d:prop></d:propstat></d:response>`).join("");
        res.writeHead(207, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${xml}</d:multistatus>`);
      }
      const cur = items.get(path);
      if (req.method === "PUT") {
        if (req.headers["if-none-match"] === "*" && cur) return res.writeHead(412).end();
        if (req.headers["if-match"] && req.headers["if-match"] !== cur?.etag) return res.writeHead(412).end();
        const etag = `"v${++n}"`;
        items.set(path, { ics: body, etag });
        // Some servers change what they store and so leave the ETag out (RFC 4791 5.3.4).
        return res.writeHead(cur ? 204 : 201, opts.etagOnPut === false ? {} : { etag }).end();
      }
      if (req.method === "DELETE") return items.delete(path) ? res.writeHead(204).end() : res.writeHead(404).end();
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/me/shifts/`;
  return {
    url, items, auths, close: () => server.close(),
    /** What someone does in their calendar app: move an event, or delete it. */
    edit(uid: string, fn: (ics: string) => string | null) {
      const [href, it] = [...items].find(([, x]) => x.ics.includes(`UID:${uid}`))!;
      const next = fn(it.ics);
      if (next === null) items.delete(href);
      else items.set(href, { ics: next, etag: `"v${++n}"` });
    },
  };
}

function setup() {
  const m = new Money(openMoneyDb(":memory:"));
  m.updateSettings({ businessName: "Sample Co", timezone: "Australia/Brisbane" }, "operator");
  const harbour = m.createClient({ name: "Harbour Plan Managers", participantName: "Participant A" }, "operator");
  return { m, work: new Work(m), harbour, today: m.today() };
}

test("shifts go out as stand-ins, changes go out once, and the calendar's moves and deletions come back", async () => {
  const cal = await fakeCalDav();
  try {
    const { m, work, harbour, today } = setup();
    const [ahead] = work.add({ clientId: harbour.id, day: addDays(today, 3), start: "09:00", end: "12:30", support: "Community access" });
    const [later] = work.add({ clientId: harbour.id, day: addDays(today, 5), start: "13:00", end: "15:00" });
    const [old] = work.add({ clientId: harbour.id, day: addDays(today, -30), start: "09:00", end: "10:00" });
    const sync = new CalendarSync(m);
    assert.throws(() => sync.configure({ kind: "caldav", url: "ftp://nope" }), /starts with http/);
    sync.configure({ kind: "caldav", url: cal.url.slice(0, -1), username: "me", password: "not-a-real-secret" });
    assert.equal(sync.settings().url, cal.url, "the collection gets its trailing slash");
    assert.equal(sync.settings().hasPassword, true);
    assert.ok(!JSON.stringify(sync.settings()).includes("not-a-real-secret"), "the password never comes back");

    let r = await sync.sync();
    assert.deepEqual([r.created, r.updated, r.errors.length], [2, 0, 0], "the old shift is outside the window");
    assert.ok(cal.auths.every((a) => a === `Basic ${Buffer.from("me:not-a-real-secret").toString("base64")}`));
    const sent = [...cal.items.values()].map((x) => x.ics).join("\n");
    assert.match(sent, new RegExp(`SUMMARY:Shift · ${standIn(harbour.id, "Participant A")}`));
    assert.ok(!/Participant|Harbour|Community/.test(sent), "no names, no support type: a stand-in and the times");
    assert.ok(!sent.includes(old.id));

    r = await sync.sync();
    assert.deepEqual([r.created, r.updated], [0, 0], "nothing changed, nothing sent");

    work.update(ahead.id, { end: "13:00" });
    r = await sync.sync();
    assert.equal(r.updated, 1, "a change goes out once");

    // Moved in the calendar app to the next morning, an hour later.
    const uid = `ogdoad-${ahead.id}@ogdoad`;
    const nextDay = addDays(today, 4).replaceAll("-", "");
    cal.edit(uid, (ics) => ics.replace(/DTSTART:\d{8}T\d{6}Z/, `DTSTART;TZID=Australia/Brisbane:${nextDay}T100000`).replace(/DTEND:\d{8}T\d{6}Z/, `DTEND;TZID=Australia/Brisbane:${nextDay}T140000`));
    r = await sync.sync();
    assert.equal(r.moved, 1);
    const moved = work.shift(ahead.id);
    assert.deepEqual([moved.day, moved.start, moved.end], [addDays(today, 4), "10:00", "14:00"]);
    r = await sync.sync();
    assert.deepEqual([r.moved, r.updated], [0, 0], "and it settles");

    // Deleted in the calendar: the shift still ahead is cancelled.
    cal.edit(`ogdoad-${later.id}@ogdoad`, () => null);
    r = await sync.sync();
    assert.equal(r.cancelled, 1);
    assert.equal(work.shift(later.id).status, "cancelled");

    // Cancelled here: its event goes.
    work.setCancelled(ahead.id, true);
    r = await sync.sync();
    assert.equal(r.deleted, 1);
    assert.equal(cal.items.size, 0);

    // Names on, by choice: events go out afresh with them.
    work.setCancelled(ahead.id, false);
    sync.configure({ showNames: true });
    await sync.sync();
    assert.match([...cal.items.values()][0].ics, /SUMMARY:Shift · Participant A \(Harbour Plan Managers\)/);
  } finally {
    cal.close();
  }
});

test("a failing calendar says why, in Flow, until it works again", async () => {
  const { m, work, harbour, today } = setup();
  work.add({ clientId: harbour.id, day: addDays(today, 2), start: "09:00", end: "10:00" });
  const sync = new CalendarSync(m);
  sync.configure({ kind: "caldav", url: "http://127.0.0.1:9/nothing/" });
  const r = await sync.sync();
  assert.equal(r.errors.length, 1);
  await syncFlow(m, {});
  const open = () => { const v = new Flow(m).view(); return [v.now, ...v.next, ...v.later].map((t) => t?.key); };
  assert.ok(open().includes("work:calendar"));
  assert.ok(sync.settings().lastError);
  sync.configure({ kind: "none" });
  await syncFlow(m, {});
  assert.ok(!open().includes("work:calendar"), "turned off: nothing to fix");
});

test("names switched off are taken off events changed in the calendar; a lost track is picked up again; a daylight-saving night keeps its end", async () => {
  const cal = await fakeCalDav();
  try {
    const { m, work, harbour, today } = setup();
    const [s] = work.add({ clientId: harbour.id, day: addDays(today, 3), start: "09:00", end: "12:00" });
    const sync = new CalendarSync(m);
    sync.configure({ kind: "caldav", url: cal.url, showNames: true });
    await sync.sync();
    const uid = `ogdoad-${s.id}@ogdoad`;
    // Touched in a calendar app (a note added), then names switched off.
    cal.edit(uid, (ics) => ics.replace("TRANSP:OPAQUE", "TRANSP:OPAQUE\r\nDESCRIPTION:touched"));
    sync.configure({ showNames: false });
    await sync.sync();
    const now = [...cal.items.values()][0].ics;
    assert.ok(!now.includes("Participant A"), "the name is gone");
    assert.match(now, /SUMMARY:Shift · C-\d{4}/);

    // Turned off and on again with the same calendar: the event is picked up, not stuck.
    sync.configure({ kind: "none" });
    sync.configure({ kind: "caldav", url: cal.url });
    work.update(s.id, { end: "12:30" });
    const r = await sync.sync();
    assert.equal(r.errors.length, 0);
    assert.equal(cal.items.size, 1, "the same event, not a second one");
    assert.equal(parseEvent([...cal.items.values()][0].ics, "Australia/Brisbane")?.end, "12:30", "and it says what Ogdoad says");
  } finally {
    cal.close();
  }
  // 4 October 2026 is when Sydney's clocks go forward: 22:00 to 06:00 is still 22:00 to 06:00.
  const { m, work, harbour } = setup();
  m.updateSettings({ timezone: "Australia/Sydney" }, "operator");
  const [night] = work.add({ clientId: harbour.id, day: "2026-10-03", start: "22:00", end: "06:00" });
  const ev = parseEvent(shiftIcs(night, "Australia/Sydney", "x", false), "Australia/Sydney");
  assert.deepEqual([ev?.start, ev?.end], ["22:00", "06:00"]);
});

test("on a server that gives no ETag on writes, Ogdoad's own write is never mistaken for a change in the calendar", async () => {
  const cal = await fakeCalDav({ etagOnPut: false });
  try {
    const { m, work, harbour, today } = setup();
    const [s] = work.add({ clientId: harbour.id, day: addDays(today, 3), start: "09:00", end: "12:00" });
    const sync = new CalendarSync(m);
    sync.configure({ kind: "caldav", url: cal.url });
    await sync.sync();
    work.update(s.id, { end: "13:00" });
    const r = await sync.sync();
    assert.equal(r.moved, 0, "the shift isn't moved back");
    assert.equal(work.shift(s.id).end, "13:00");
    assert.equal(parseEvent([...cal.items.values()][0].ics, "Australia/Brisbane")?.end, "13:00", "and the calendar has the correction");
  } finally {
    cal.close();
  }
});
