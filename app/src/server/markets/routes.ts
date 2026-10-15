// Markets' HTTP API, under /ogdoad/markets: the watchlist's prices, a live stream of them (which is
// also what keeps the feeds running), a symbol's path over a range, and the watchlist itself.

import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpError, readJson, sendJson } from "../http.js";
import type { Markets } from "./service.js";
import { RANGES, type Range } from "./sources.js";

export async function handleMarkets(markets: Markets, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const [sub] = url.pathname.split("/").filter(Boolean).slice(2); // after /ogdoad/markets
  const method = req.method ?? "GET";

  if (!sub && method === "GET") return sendJson(res, 200, { watchlist: markets.watchlist(), quotes: markets.snapshot() });

  if (sub === "stream" && method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write("retry: 5000\n\n");
    send("snapshot", { watchlist: markets.watchlist(), quotes: markets.snapshot() });
    const off = markets.subscribe((e) => (e.type === "closed" ? res.end() : send(e.type, e)));
    // A comment now and then, so nothing between here and the page closes a quiet stream.
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
    return;
  }

  if (sub === "history" && method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    const range = (url.searchParams.get("range") ?? "1D") as Range;
    if (!RANGES.includes(range)) throw new HttpError(400, "bad_range", `The range is one of: ${RANGES.join(", ")}.`);
    return sendJson(res, 200, await markets.history(id, range));
  }

  if (sub === "watchlist" && method === "POST") {
    const b = await readJson(req);
    const added = await markets.add(String(b?.symbol ?? ""));
    return sendJson(res, 201, { added, watchlist: markets.watchlist() });
  }
  if (sub === "watchlist" && method === "PUT") {
    const b = await readJson(req);
    if (!Array.isArray(b?.ids)) throw new HttpError(400, "bad_request", "Send the watchlist as { ids: [...] }.");
    return sendJson(res, 200, { watchlist: markets.setWatchlist(b.ids) });
  }
  throw new HttpError(404, "not_found", "No such Markets route.");
}
