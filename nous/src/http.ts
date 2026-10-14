// A small router: routes by method and path pattern, JSON in and out, errors as plain sentences.

import type { IncomingMessage, ServerResponse } from "node:http";

import { NousError, type Who } from "./engine.js";

export interface Ctx {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  /** Who's asking (null: no valid credentials). */
  who: Who | null;
  body(): Promise<any>;
}

/** A handler returns what to send: a value (200), a Reply, or undefined (204). */
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

export class Reply {
  constructor(readonly status: number, readonly body: unknown) {}
}
export const created = (body: unknown) => new Reply(201, body);

interface Route { method: string; parts: string[]; handler: Handler }

export class Router {
  private readonly routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const segs = path.split("/").filter(Boolean).map(decodeURIComponent);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      if (r.parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = segs[i]), true) : p === segs[i]))) return { handler: r.handler, params };
    }
    return null;
  }
}

const MAX_BODY = 4 * 1024 * 1024;

export function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new NousError(413, "too_large", "That request is too large."));
      else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new NousError(400, "bad_json", "That request body isn't valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

export function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) }).end(text);
}

/** An error as the client sees it: a code to switch on, and a sentence to show. */
export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof NousError) return send(res, err.status, { error: err.code, message: err.message });
  console.error(err);
  send(res, 500, { error: "internal", message: "Something went wrong in Nous. It's in its log." });
}

/** Who may call a route. */
export function needOperator(ctx: Ctx): void {
  if (ctx.who?.kind !== "operator") throw new NousError(ctx.who ? 403 : 401, ctx.who ? "operator_only" : "unauthorized", ctx.who ? "Only the operator can do that." : "Sign the request with the operator's token or a run's token.");
}
export function needSomeone(ctx: Ctx): Who {
  if (!ctx.who) throw new NousError(401, "unauthorized", "Sign the request with the operator's token or a run's token.");
  return ctx.who;
}
