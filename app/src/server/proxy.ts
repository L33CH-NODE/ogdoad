// Pass requests through to Nous (the Ogdoad server) and Horos: plain requests and streamed events
// (SSE). Headers are rewritten so each upstream sees a request from its own origin,
// and Horos gets its token added here, so the browser never holds it.

import { request, type IncomingMessage, type ServerResponse } from "node:http";

export interface Upstream {
  /** e.g. http://127.0.0.1:3100 */
  base: string;
  /** Path prefix to strip before forwarding (e.g. "/horos"). */
  strip?: string;
  /** Extra headers, such as Horos's bearer token (read fresh each time). */
  headers?: () => Record<string, string>;
}

function target(up: Upstream, path: string) {
  const url = new URL(up.base);
  const rest = up.strip && path.startsWith(up.strip) ? path.slice(up.strip.length) || "/" : path;
  return { url, path: rest };
}

function upstreamHeaders(req: IncomingMessage, up: Upstream, url: URL): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = v;
  headers.host = url.host;
  if (headers.origin) headers.origin = url.origin;
  if (headers.referer) delete headers.referer;
  // The operator's session is Ogdoad's alone: the engine and Horos never see the cookie that opens the vault.
  delete headers.cookie;
  Object.assign(headers, up.headers?.() ?? {});
  return headers;
}

/** sent: told the request body and the upstream's answer once it's through (for the crossings log). */
export function proxyHttp(up: Upstream, req: IncomingMessage, res: ServerResponse, sent?: (status: number, body: Buffer) => void): void {
  const { url, path } = target(up, req.url ?? "/");
  const chunks: Buffer[] = [];
  if (sent) req.on("data", (c: Buffer) => chunks.push(c));
  const out = request({ host: url.hostname, port: url.port, method: req.method, path, headers: upstreamHeaders(req, up, url) }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
    if (sent) upRes.on("end", () => {
      try {
        sent(upRes.statusCode ?? 502, Buffer.concat(chunks));
      } catch {
        // The log is best effort; the request itself went through.
      }
    });
  });
  out.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "upstream_down", message: `${url.host} isn't answering.` }));
  });
  req.pipe(out);
  res.on("close", () => out.destroy());
}
