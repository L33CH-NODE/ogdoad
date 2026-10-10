// The calendar sync: Work's shifts in the operator's own CalDAV calendar (Radicale, Baïkal or Nextcloud
// on a home box, reached over the tailnet), both ways. Ogdoad's shifts go out as events; an event moved
// in the calendar moves its shift, and one deleted there cancels a shift that hasn't happened yet.
// Events carry a stand-in ("Shift · C-0412") and the times, nothing else, unless the operator chooses
// to show names. The stand-in key is never sent: it's worked out here, from the shift's own client.

import { createHash } from "node:crypto";

import type { Raised } from "../flow/flow.js";
import { addDays, MoneyError, type Money } from "../money/service.js";
import { clockIn, standIn, Work, type Shift } from "./work.js";

export { standIn };

export interface CalendarSettings {
  kind: "none" | "caldav";
  url: string;
  username: string;
  /** Whether a password is kept (it's never sent back). */
  hasPassword: boolean;
  showNames: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SyncReport {
  created: number;
  updated: number;
  deleted: number;
  /** Shifts moved because their event was moved in the calendar. */
  moved: number;
  /** Shifts cancelled because their event was deleted in the calendar. */
  cancelled: number;
  errors: string[];
}

interface Remote { href: string; etag: string | null; ics: string }
type Fetch = typeof fetch;

/** Shifts this far back are still kept in step; older ones are left as they are. */
const KEEP_DAYS = 14;
const TIMEOUT_MS = 10_000;
const iso = () => new Date().toISOString();

function knownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** How far a timezone's wall clock is ahead of UTC at a moment, in ms. */
function offsetMs(tz: string, at: number): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const n = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
}

/** A wall-clock time in a timezone, as the moment it is (DST-safe: the offset is checked twice). */
export function zonedToUtc(day: string, time: string, tz: string): Date {
  const guess = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), Number(time.slice(0, 2)), Number(time.slice(3, 5)));
  let utc = guess - offsetMs(tz, guess);
  const again = offsetMs(tz, utc);
  if (guess - again !== utc) utc = guess - again;
  return new Date(utc);
}

function zoned(at: Date, tz: string): { day: string; time: string } {
  const c = clockIn(tz, at);
  return { day: c.day, time: `${String(Math.floor(c.minutes / 60)).padStart(2, "0")}:${String(c.minutes % 60).padStart(2, "0")}` };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** The event for a shift: times in UTC (every client reads those), and a stand-in unless names are on. */
export function shiftIcs(s: Shift, tz: string, uid: string, showNames: boolean, now = new Date()): string {
  const start = zonedToUtc(s.day, s.start, tz);
  // The end is its own wall-clock time (the next day when it runs past midnight), not start plus
  // minutes: on a daylight-saving night those differ by an hour.
  const endsNextDay = s.end <= s.start;
  const end = zonedToUtc(endsNextDay ? addDays(s.day, 1) : s.day, s.end, tz);
  const title = showNames ? `Shift · ${s.participantName || s.clientName}${s.participantName && s.participantName !== s.clientName ? ` (${s.clientName})` : ""}` : `Shift · ${s.standIn}`;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ogdoad//Work//EN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${escapeText(title)}`,
    "TRANSP:OPAQUE", "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

/** What's worth comparing in an event we sent: everything but the time it was written. */
const contentHash = (ics: string) => createHash("sha256").update(ics.replace(/^DTSTAMP:.*$/m, "")).digest("hex").slice(0, 24);

/** An event's UID and its times on the business's clock. null for all-day events, or ones that can't be read. */
export function parseEvent(ics: string, tz: string): { uid: string; day: string; start: string; end: string } | null {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const from = lines.findIndex((l) => l.trim() === "BEGIN:VEVENT");
  if (from < 0) return null;
  const prop = (name: string) => {
    const line = lines.slice(from).find((l) => l.toUpperCase().startsWith(`${name};`) || l.toUpperCase().startsWith(`${name}:`));
    if (!line) return null;
    const colon = line.indexOf(":");
    const params = line.slice(name.length, colon);
    return { value: line.slice(colon + 1).trim(), tzid: /;TZID="?([^;:"]+)"?/i.exec(params)?.[1] ?? null, date: /VALUE=DATE(?!-)/i.test(params) };
  };
  const uid = prop("UID")?.value;
  const s = prop("DTSTART");
  const e = prop("DTEND");
  if (!uid || !s || !e || s.date || e.date) return null;
  const moment = (p: { value: string; tzid: string | null }): Date | null => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(p.value);
    if (!m) return null;
    if (m[7]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    const zone = p.tzid && knownZone(p.tzid) ? p.tzid : tz;
    return zonedToUtc(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}`, zone);
  };
  const a = moment(s);
  const b = moment(e);
  if (!a || !b || b <= a || b.getTime() - a.getTime() > 86_400_000) return null;
  const za = zoned(a, tz);
  return { uid, day: za.day, start: za.time, end: zoned(b, tz).time };
}

/** The bits of a CalDAV multistatus answer: each event's href, etag and data. */
export function parseMultistatus(xml: string): Remote[] {
  const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#13;/g, "\r").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
  const out: Remote[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/g)) {
    const block = m[1];
    const pick = (tag: string) => new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`).exec(block)?.[1] ?? null;
    const href = pick("href");
    const data = pick("calendar-data");
    if (!href || !data) continue;
    const etag = pick("getetag");
    out.push({ href: decode(href).trim(), etag: etag ? decode(etag).trim() : null, ics: decode(data) });
  }
  return out;
}

const QUERY = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter>
</c:calendar-query>`;

export class CalendarSync {
  constructor(private readonly money: Money, private readonly fetchImpl: Fetch = fetch) {}

  private get db() {
    return this.money.db;
  }

  private row(): any {
    return this.db.prepare("SELECT * FROM calendar WHERE id = 1").get();
  }

  settings(): CalendarSettings {
    const r = this.row();
    return { kind: r.kind, url: r.url, username: r.username, hasPassword: !!r.password, showNames: !!r.show_names, lastSyncAt: r.last_sync_at, lastError: r.last_error };
  }

  /** Set the calendar up (or turn it off). A password is only replaced when a new one is given. */
  configure(patch: { kind?: string; url?: string; username?: string; password?: string; showNames?: boolean }): CalendarSettings {
    const cur = this.row();
    const kind = patch.kind ?? cur.kind;
    if (kind !== "none" && kind !== "caldav") throw new MoneyError("bad_kind", "The calendar is either off or a CalDAV calendar.");
    let url = String(patch.url ?? cur.url).trim();
    if (kind === "caldav") {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new MoneyError("bad_url", "That isn't a web address. It looks like http://homebox:5232/you/shifts/");
      }
      if (!/^https?:$/.test(parsed.protocol)) throw new MoneyError("bad_url", "The calendar's address starts with http:// or https://.");
      if (parsed.username || parsed.password) throw new MoneyError("bad_url", "Put the login in its own boxes, not in the address.");
      if (!url.endsWith("/")) url += "/";
    }
    const password = patch.password ? String(patch.password) : cur.password;
    this.db.prepare("UPDATE calendar SET kind = ?, url = ?, username = ?, password = ?, show_names = ?, last_error = NULL, updated_at = ? WHERE id = 1")
      .run(kind, url, String(patch.username ?? cur.username).trim(), kind === "none" ? "" : password, (patch.showNames ?? !!cur.show_names) ? 1 : 0, iso());
    // A different calendar (or names switched on or off) means every event goes out afresh.
    if (kind === "none" || url !== cur.url || (patch.showNames !== undefined && patch.showNames !== !!cur.show_names)) {
      this.db.prepare("UPDATE shifts SET calendar_hash = NULL").run();
      if (url !== cur.url || kind === "none") this.db.prepare("UPDATE shifts SET calendar_uid = NULL, calendar_etag = NULL").run();
    }
    this.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'calendar_set', NULL, ?)").run(iso(), kind === "none" ? "off" : new URL(url).host);
    return this.settings();
  }

  private async call(method: string, href: string, opts: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const r = this.row();
    const headers: Record<string, string> = { ...opts.headers };
    if (r.username) headers.authorization = `Basic ${Buffer.from(`${r.username}:${r.password}`).toString("base64")}`;
    return this.fetchImpl(href, { method, headers, body: opts.body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  }

  private async list(base: string): Promise<Map<string, Remote>> {
    const res = await this.call("REPORT", base, { body: QUERY, headers: { depth: "1", "content-type": "application/xml; charset=utf-8" } });
    if (res.status === 401 || res.status === 403) throw new Error("The calendar refused the login.");
    if (res.status !== 207) throw new Error(`The calendar answered ${res.status} when asked for its events.`);
    const map = new Map<string, Remote>();
    for (const r of parseMultistatus(await res.text())) {
      const uid = /^UID:(.+)$/m.exec(r.ics.replace(/\r?\n[ \t]/g, ""))?.[1]?.trim();
      if (uid) map.set(uid, { ...r, href: new URL(r.href, base).toString() });
    }
    return map;
  }

  /** Bring the calendar and Work into step, both ways. */
  async sync(): Promise<SyncReport> {
    const cfg = this.row();
    const report: SyncReport = { created: 0, updated: 0, deleted: 0, moved: 0, cancelled: 0, errors: [] };
    if (cfg.kind !== "caldav") return report;
    const tz = this.money.settings().timezone;
    const work = new Work(this.money, "calendar");
    const keep = this.db.prepare("UPDATE shifts SET calendar_uid = ?, calendar_etag = ?, calendar_hash = ? WHERE id = ?");
    const own = this.db.prepare("SELECT calendar_uid, calendar_etag, calendar_hash FROM shifts WHERE id = ?");
    const fail = (what: string, err: unknown) => report.errors.push(`${what}: ${(err as Error).message ?? err}`);

    try {
      const remote = await this.list(cfg.url);
      const put = async (s: Shift, uid: string, etag: string | null, create: boolean) => {
        const ics = shiftIcs(s, tz, uid, !!cfg.show_names);
        const href = remote.get(uid)?.href ?? new URL(`${encodeURIComponent(uid)}.ics`, cfg.url).toString();
        const res = await this.call("PUT", href, { body: ics, headers: { "content-type": "text/calendar; charset=utf-8", ...(create ? { "if-none-match": "*" } : etag ? { "if-match": etag } : {}) } });
        if (res.status === 412) return; // changed in the calendar meanwhile: the next sync sorts it out
        if (!res.ok) throw new Error(`the calendar answered ${res.status}`);
        keep.run(uid, res.headers.get("etag"), contentHash(ics), s.id);
        create ? report.created++ : report.updated++;
      };

      for (const s of work.shifts({ from: addDays(this.money.today(), -KEEP_DAYS) })) {
        const mine = own.get(s.id) as { calendar_uid: string | null; calendar_etag: string | null; calendar_hash: string | null };
        // A shift's event always has the same UID, so one Ogdoad lost track of (sync turned off and on
        // again, say) is found again rather than made twice.
        const uid = mine.calendar_uid ?? `ogdoad-${s.id}@ogdoad`;
        const there = remote.get(uid);
        try {
          if (s.status === "cancelled") {
            if (there) {
              const res = await this.call("DELETE", there.href, { headers: there.etag ? { "if-match": there.etag } : {} });
              if (!res.ok && res.status !== 404) throw new Error(`the calendar answered ${res.status}`);
              report.deleted++;
            }
            if (mine.calendar_uid) keep.run(null, null, null, s.id);
            continue;
          }
          if (!there) {
            // Gone from a calendar it was in: a shift still ahead is cancelled; one that's happened (or is
            // billed) goes back. Never in this calendar: it goes in.
            if (mine.calendar_uid && s.phase === "ahead" && !s.billed) {
              work.setCancelled(s.id, true);
              keep.run(null, null, null, s.id);
              report.cancelled++;
            } else {
              await put(s, uid, null, true);
            }
            continue;
          }
          if (!mine.calendar_uid || !mine.calendar_etag) {
            // There, but Ogdoad doesn't know its version (it lost track, or the server gave no ETag last
            // time): Ogdoad's shift is the record, so its version goes over the top.
            await put(s, uid, there.etag, false);
            continue;
          }
          if (there.etag !== mine.calendar_etag) {
            // Changed in the calendar: take its times if the shift can still change, then write Ogdoad's
            // own version back, so the event says only what Ogdoad would say (a stand-in, unless names
            // are on) and a shift that can't move goes back where it is.
            const ev = parseEvent(there.ics, tz);
            let now = s;
            if (ev && !s.billed && (ev.day !== s.day || ev.start !== s.start || ev.end !== s.end)) {
              now = work.update(s.id, { day: ev.day, start: ev.start, end: ev.end });
              report.moved++;
            }
            await put(now, uid, there.etag, false);
            continue;
          }
          if (contentHash(shiftIcs(s, tz, uid, !!cfg.show_names)) !== mine.calendar_hash) await put(s, uid, there.etag, false);
        } catch (err) {
          fail(`${s.day} ${s.start}`, err);
        }
      }
    } catch (err) {
      fail("calendar", err);
    }
    const error = report.errors.length ? (report.errors.length > 1 ? `${report.errors[0]} (and ${report.errors.length - 1} more)` : report.errors[0]) : null;
    this.db.prepare("UPDATE calendar SET last_sync_at = ?, last_error = ? WHERE id = 1").run(iso(), error);
    return report;
  }
}

/** A calendar that's set up but failing is work for the operator. */
export function raisedFromCalendar(money: Money): Raised[] {
  const s = new CalendarSync(money).settings();
  if (s.kind === "none" || !s.lastError) return [];
  return [{ key: "work:calendar", title: "The calendar sync isn't working", context: s.lastError, source: "work", ref: "/work/calendar", urgency: 1 }];
}
