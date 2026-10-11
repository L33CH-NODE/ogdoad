// /ogdoad/watch: what the hires ask permission for, and the operator's answers.

import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpError, readJson, sendJson } from "../http.js";
import type { Money } from "../money/service.js";
import { Watch, type HorosLink } from "./watch.js";

export async function handleWatch(money: Money, req: IncomingMessage, res: ServerResponse, url: URL, ctx: { horos: HorosLink; practice: boolean; home?: string }): Promise<void> {
  const [id, action] = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent); // after /ogdoad/watch
  const method = req.method ?? "GET";
  const watch = new Watch(money, ctx.horos, ctx.home);
  // The practice copy's books are made up, but its team is real: answering it is for the real app.
  const refuse = () => {
    if (ctx.practice) throw new HttpError(400, "practice", "Answer the team from your real Ogdoad: the practice copy shares the real team.");
  };
  if (!id && method === "GET") return sendJson(res, 200, { practice: ctx.practice, settings: watch.settings(), asks: watch.list() });
  if (id === "settings") {
    if (method === "GET") return sendJson(res, 200, watch.settings());
    if (method === "PUT") {
      refuse();
      return sendJson(res, 200, watch.setAuto((await readJson(req)).auto === true));
    }
  }
  if (id && !action && method === "GET") return sendJson(res, 200, watch.get(id));
  if (id && action === "answer" && method === "POST") {
    refuse();
    const body = await readJson(req);
    return sendJson(res, 200, await watch.answer(id, body.choice, body.confirm === true));
  }
  throw new HttpError(404, "not_found", "Nothing here.");
}
