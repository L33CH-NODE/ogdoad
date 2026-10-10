// Dashboards' HTTP API, under /ogdoad/dashboards: the panels with their results, a preview for a
// recipe that isn't saved yet, and the shape of the curated tables (for a hire to write against).

import type { IncomingMessage, ServerResponse } from "node:http";

import { HttpError, readJson, sendJson } from "../http.js";
import type { Money } from "../money/service.js";
import { schemaText } from "./curated.js";
import { Dashboards } from "./recipes.js";

export async function handleDashboards(money: Money, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const [id] = url.pathname.split("/").filter(Boolean).slice(2); // after /ogdoad/dashboards
  const method = req.method ?? "GET";
  const dash = new Dashboards(money);
  if (!id && method === "GET") return sendJson(res, 200, await dash.withResults());
  if (!id && method === "POST") return sendJson(res, 201, await dash.add(await readJson(req)));
  if (id === "preview" && method === "POST") return sendJson(res, 200, await dash.preview(await readJson(req)));
  if (id === "schema" && method === "GET") return sendJson(res, 200, { text: schemaText() });
  if (id && method === "DELETE") return dash.remove(id), sendJson(res, 200, { ok: true });
  throw new HttpError(404, "not_found", "No such Dashboards route.");
}
