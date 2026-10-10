// Work's HTTP API, under /ogdoad/work: shifts, their notes, and billing finished shifts. Operator-only,
// like Money: the operator's own UI is the only caller.

import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpError, readJson, sendJson } from "../http.js";
import type { Money } from "../money/service.js";
import { CalendarSync } from "./calendar.js";
import { Work } from "./work.js";

export async function handleWork(money: Money, req: IncomingMessage, res: ServerResponse, url: URL, opts: { practice?: boolean } = {}): Promise<void> {
  const [resource, id, action] = url.pathname.split("/").filter(Boolean).slice(2); // after /ogdoad/work
  const method = req.method ?? "GET";
  const work = new Work(money);
  const range = { from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined };

  if (resource === "shifts") {
    if (!id && method === "GET") return sendJson(res, 200, work.shifts(range));
    if (!id && method === "POST") return sendJson(res, 201, work.add(await readJson(req)));
    if (id && !action && method === "GET") return sendJson(res, 200, work.shift(id));
    if (id && !action && method === "PUT") return sendJson(res, 200, work.update(id, await readJson(req)));
    if (id && action === "cancel" && method === "POST") return sendJson(res, 200, work.setCancelled(id, true));
    if (id && action === "restore" && method === "POST") return sendJson(res, 200, work.setCancelled(id, false));
    if (id && action === "note" && method === "PUT") return sendJson(res, 200, work.writeNote(id, await readJson(req)));
    if (id && action === "incident-reported" && method === "POST") return sendJson(res, 200, work.incidentReported(id));
  }
  if (resource === "billable" && method === "GET") return sendJson(res, 200, work.billable());
  if (resource === "bill" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 201, work.bill(String(body.clientId ?? ""), { from: body.from || undefined, to: body.to || undefined }));
  }
  if (resource === "calendar") {
    const cal = new CalendarSync(money);
    if (!id && method === "GET") return sendJson(res, 200, cal.settings());
    // The practice copy has no vault to keep a calendar password in, and its shifts are made up.
    if (opts.practice && method !== "GET") throw new HttpError(400, "practice", "The practice copy doesn't sync a calendar: its shifts are made up.");
    if (!id && method === "PUT") {
      const settings = cal.configure(await readJson(req));
      const report = settings.kind === "caldav" ? await cal.sync() : null;
      return sendJson(res, 200, { settings: cal.settings(), report });
    }
    if (id === "sync" && method === "POST") {
      const report = await cal.sync();
      return sendJson(res, 200, { settings: cal.settings(), report });
    }
  }
  throw new HttpError(404, "not_found", "No such Work route.");
}
