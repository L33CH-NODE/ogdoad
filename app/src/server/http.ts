// Small HTTP helpers for the app server: JSON in and out, errors as plain sentences, and the
// request checks every route shares.

import type { IncomingMessage, ServerResponse } from "node:http";

import { MoneyError } from "./money/service.js";
import { VaultError } from "./vault.js";

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

export async function readJson(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "That's more than the app accepts in one request.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "The request body isn't valid JSON.");
  }
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Every request must be addressed to this machine (blocks DNS rebinding), and a browser request
 * must come from Ogdoad's own pages (blocks other sites). Changes must be JSON, which a plain web
 * form can't send.
 */
export function checkRequest(req: IncomingMessage, allowedOrigins: Set<string>): void {
  if (!LOCAL_HOST.test(req.headers.host ?? "")) throw new HttpError(421, "wrong_host", "This server only answers on 127.0.0.1.");
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, "origin_not_allowed", "Requests from other sites aren't accepted.");
  const mutating = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (mutating && (req.headers["content-length"] ?? "0") !== "0" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "json_only", "Changes are sent as JSON.");
  }
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code, message: err.message });
  if (err instanceof VaultError) {
    const status = err.code === "wrong_password" || err.code === "wrong_phrase" ? 401 : err.code === "exists" ? 409 : err.code === "locked" ? 423 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  if (err instanceof MoneyError) {
    const status = err.code.startsWith("no_") && /invoice|client|account/.test(err.code) ? 404 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  console.error(err);
  return sendJson(res, 500, { error: "internal", message: "Something went wrong in the app server. It's in its log." });
}
