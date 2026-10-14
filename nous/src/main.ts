// Nous: Ogdoad's engine, as a service Horos keeps up. It starts locked (its store is encrypted, and
// only the app holds the key); the app hands the key over on unlock, and Nous keeps it in memory until
// it stops: "after first unlock", like a phone. Only the operator (with the operator's token) and
// hires on their runs (with a run's token) are anyone here; being on this machine is no one.
//
//   NOUS_HOME (default ~/.ogdoad/nous), NOUS_PORT (default 3100), NOUS_HOST (default 127.0.0.1)

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { nativeRoutes } from "./api.js";
import { compatRoutes } from "./compat.js";
import { Engine, NousError, type Who } from "./engine.js";
import { compatSocket, streamChanges } from "./events.js";
import { needOperator, needSomeone, readJson, Reply, Router, send, sendError } from "./http.js";
import { openStore } from "./store.js";
import { PROTOCOL, Work } from "./work.js";

const HOME = process.env.NOUS_HOME ?? join(process.env.OGDOAD_HOME ?? join(homedir(), ".ogdoad"), "nous");
const PORT = Number(process.env.NOUS_PORT ?? 3100);
const HOST = process.env.NOUS_HOST ?? "127.0.0.1";
const TOKEN_FILE = join(HOME, "operator.token");
/** Each member's mailbox key, for its seat (Horos) or live worker to read. */
const KEYS_DIR = join(HOME, "keys");

/** The operator's token: made the first time, readable by this account only (on Unix; on Windows the profile's ACL). */
function operatorToken(): string {
  mkdirSync(HOME, { recursive: true });
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  try {
    chmodSync(TOKEN_FILE, 0o600);
  } catch {
    // Windows: the file sits under the user's profile.
  }
  return token;
}

const TOKEN = Buffer.from(operatorToken());
let engine: Engine | null = null;
let work: Work | null = null;

function unlocked(): Engine {
  if (!engine) throw new NousError(423, "locked", "Nous is locked until Ogdoad is unlocked.");
  return engine;
}
function working(): Work {
  unlocked();
  return work!;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function who(req: IncomingMessage): Who | null {
  const token = bearer(req);
  if (!token) return null;
  const given = Buffer.from(token);
  if (given.length === TOKEN.length && timingSafeEqual(given, TOKEN)) return { kind: "operator" };
  // A run's token: that member, on that run, while the run is running.
  const w = work?.whoForToken(token) ?? null;
  // The old engine's hires also send the run's id; if they do, it has to be that run.
  const runHeader = req.headers["x-paperclip-run-id"];
  if (w && w.kind === "member" && typeof runHeader === "string" && runHeader !== w.runId) return null;
  return w;
}

const router = new Router();
router.on("GET", "/v1/health", () => ({ ok: true, protocol: "nous/1", locked: !engine }));
router.on("GET", "/api/health", () => ({ status: "ok", locked: !engine }));
router.on("POST", "/v1/unlock", async (c) => {
  needOperator(c);
  const key = Buffer.from(String((await c.body()).key ?? ""), "hex");
  if (key.length !== 32) throw new NousError(400, "bad_key", "The key is 32 bytes, in hex.");
  if (!engine) {
    try {
      engine = new Engine(openStore(join(HOME, "nous.db"), key), { keysDir: KEYS_DIR });
    } catch (err) {
      throw new NousError(403, "wrong_key", (err as Error).message);
    }
    work = new Work(engine, { apiUrl: `http://${HOST}:${PORT}` });
    console.log(`${new Date().toISOString()} unlocked`);
  }
  return { ok: true, locked: false };
});
nativeRoutes(router, unlocked, working);
compatRoutes(router, unlocked, working);

// The mailbox: how seats and live workers take jobs, with a member's mailbox key (never an API credential).
const mailbox = new Router();
const memberFor = (req: IncomingMessage) => {
  const key = bearer(req);
  if (!key) throw new NousError(401, "no_key", "missing bearer mailbox key");
  return unlocked().memberByMailboxKey(key);
};
mailbox.on("GET", "/mailbox/v1/health", () => ({ ok: true, protocol: PROTOCOL }));
mailbox.on("GET", "/mailbox/v1/next", async (c) => {
  const m = memberFor(c.req);
  if (!m) throw new NousError(401, "unknown_key", "That mailbox key isn't anyone's.");
  const job = await working().next(m, Number(c.url.searchParams.get("wait") ?? 25));
  return job ?? undefined;
});
for (const action of ["heartbeat", "log", "done"] as const) {
  mailbox.on("POST", `/mailbox/v1/jobs/:id/${action}`, async (c) => {
    const m = memberFor(c.req);
    if (!m) throw new NousError(404, "no_such_job", "no such job");
    return working().touch(m, c.params.id, action, await c.body());
  });
}

const OPEN = new Set(["/v1/health", "/api/health", "/v1/unlock", "/mailbox/v1/health"]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const isMailbox = url.pathname.startsWith("/mailbox/");
  const isCompat = url.pathname.startsWith("/api/") || isMailbox;
  try {
    const ctx = { req, url, params: {} as Record<string, string>, who: who(req), body: () => readJson(req) };
    if (!OPEN.has(url.pathname)) unlocked();
    const events = /^\/v1\/companies\/([^/]+)\/events$/.exec(url.pathname);
    if (events && req.method === "GET") {
      const w = needSomeone(ctx);
      unlocked().company(events[1], w);
      return streamChanges(unlocked(), events[1], req, res);
    }
    const hit = (isMailbox ? mailbox : router).match(req.method ?? "GET", url.pathname);
    if (!hit) throw new NousError(404, "no_route", `Nous has no ${req.method} ${url.pathname}.`);
    ctx.params = hit.params;
    const out = await hit.handler(ctx);
    if (out instanceof Reply) send(res, out.status, out.body);
    else if (out === undefined) send(res, 204);
    else send(res, 200, out);
  } catch (err) {
    // The old engine's callers read the sentence from `error`; Nous's own read the code from it.
    if (isCompat && err instanceof NousError) send(res, err.status, { error: err.message, code: err.code });
    else sendError(res, err);
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const m = /^\/api\/companies\/([^/]+)\/events\/ws$/.exec(url.pathname);
  const w = who(req);
  try {
    if (!m || !w || !engine) throw new Error("refused");
    engine.company(m[1], w);
    compatSocket(engine, m[1], req, socket, head);
  } catch {
    socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
  }
});

server.listen(PORT, HOST, () => console.log(`${new Date().toISOString()} Nous on http://${HOST}:${PORT} (locked until the app hands over the key; home ${HOME})`));
