// The Ogdoad app server: the operator's UI and Ogdoad's own APIs on 127.0.0.1:3101, in front of the
// Ogdoad server (/api) and Horos (/horos). Horos runs it as a server, after the Ogdoad server.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRequest, HttpError, sendError, sendJson } from "./http.js";
import { readJson } from "./http.js";
import { Keeper } from "./keeper.js";
import { OGDOAD_HOME } from "./money/db.js";
import { practiceStatement, resetPractice } from "./money/practice.js";
import { handleMoney } from "./money/routes.js";
import { Vault } from "./vault.js";
import { proxyHttp, proxyUpgrade, type Upstream } from "./proxy.js";

const PORT = Number(process.env.OGDOAD_APP_PORT ?? 3101);
/** The practice copy: its own made-up books, a ribbon in the UI, and a reset button. */
const PRACTICE = process.env.OGDOAD_PRACTICE === "1";
const SERVER_URL = process.env.OGDOAD_SERVER_URL ?? "http://127.0.0.1:3100";
const HOROS_URL = process.env.OGDOAD_HOROS_URL ?? "http://127.0.0.1:3198";
const HOROS_TOKEN_FILE = join(OGDOAD_HOME, "horos", "horos.token");
const WEB_DIR = resolve(fileURLToPath(new URL("../web/", import.meta.url)));

const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, "http://127.0.0.1:5173", "http://localhost:5173"]);

const paperclip: Upstream = { base: SERVER_URL };
const horos: Upstream = {
  base: HOROS_URL,
  strip: "/horos",
  headers: (): Record<string, string> => {
    try {
      return { authorization: `Bearer ${readFileSync(HOROS_TOKEN_FILE, "utf8").trim()}` };
    } catch {
      return {};
    }
  },
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

function serveStatic(pathname: string, res: import("node:http").ServerResponse): void {
  const file = normalize(join(WEB_DIR, decodeURIComponent(pathname)));
  const inside = file.startsWith(WEB_DIR);
  const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(WEB_DIR, "index.html");
  if (!existsSync(target)) return sendJson(res, 503, { error: "ui_not_built", message: "The UI isn't built yet: run npm run build in app/." });
  const hashed = /\/assets\//.test(target.replaceAll("\\", "/"));
  res.writeHead(200, { "content-type": TYPES[extname(target)] ?? "application/octet-stream", "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" });
  res.end(readFileSync(target));
}

/** Who SOPHIA is and where her conversation lives (written by the first-launch wizard). */
function readSophia(): { companyId: string; companyName: string; agentId: string; taskId: string; hireId: string } | null {
  try {
    const s = JSON.parse(readFileSync(join(OGDOAD_HOME, "sophia.json"), "utf8"));
    return { companyId: s.companyId, companyName: s.companyName, agentId: s.agentId, taskId: s.taskId, hireId: s.hireId };
  } catch {
    return null;
  }
}

/** Tell the operator through Horos's feed (and a desktop alert). Best effort. */
function notify(title: string, body: string): void {
  fetch(`${HOROS_URL}/v1/notifications`, { method: "POST", headers: { "content-type": "application/json", ...horos.headers!() }, body: JSON.stringify({ title, body, level: "info" }) }).catch(() => {});
}

const keeper = new Keeper(PRACTICE, PRACTICE ? null : new Vault(), Number(process.env.OGDOAD_LOCK_MINUTES ?? 30) * 60_000, (why) =>
  notify("Ogdoad is locked", `${why.charAt(0).toUpperCase()}${why.slice(1)}. Your password or recovery phrase opens it again.`));

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, app: "ogdoad", unlocked: keeper.status().unlocked });
    checkRequest(req, ALLOWED_ORIGINS);

    // Open to anyone on this machine: what the app is, and the way in.
    if (url.pathname === "/ogdoad/app" && req.method === "GET") return sendJson(res, 200, { practice: PRACTICE, realAppPort: 3101 });
    if (url.pathname === "/ogdoad/vault" && req.method === "GET") return sendJson(res, 200, keeper.status());
    if (url.pathname.startsWith("/ogdoad/vault/") && req.method === "POST") {
      const action = url.pathname.slice("/ogdoad/vault/".length);
      const body = await readJson(req);
      if (action === "prepare") return sendJson(res, 200, keeper.prepare(String(body.login ?? ""), String(body.password ?? "")));
      if (action === "confirm") {
        res.setHeader("set-cookie", keeper.confirm(body.words && typeof body.words === "object" ? body.words : {}));
        notify("Your vault is made", "Ogdoad's data is now encrypted with your key. Keep your recovery phrase safe.");
        return sendJson(res, 201, keeper.status());
      }
      if (action === "unlock") return res.setHeader("set-cookie", await keeper.unlock(String(body.login ?? ""), String(body.password ?? ""))), sendJson(res, 200, keeper.status());
      if (action === "recover") return res.setHeader("set-cookie", keeper.recover(String(body.phrase ?? ""), String(body.newPassword ?? ""))), sendJson(res, 200, keeper.status());
      if (action === "lock") return keeper.lock("locked by you"), res.setHeader("set-cookie", Keeper.clearCookie()), sendJson(res, 200, keeper.status());
    }

    // Everything else needs an unlocked session. The page itself still loads, so it can show the lock.
    const isPage = (req.method === "GET" || req.method === "HEAD") && !/^\/(api|horos|ogdoad)(\/|$)/.test(url.pathname);
    if (!isPage && !keeper.allows(req)) throw new HttpError(401, "locked", "Ogdoad is locked. Unlock it with your password.");

    if (url.pathname === "/ogdoad/vault/password" && req.method === "POST") {
      const body = await readJson(req);
      keeper.vault!.changePassword(String(body.oldPassword ?? ""), String(body.newPassword ?? ""));
      return sendJson(res, 200, { ok: true });
    }
    const money = keeper.money;
    if (url.pathname.startsWith("/ogdoad/money/")) {
      if (!money) throw new HttpError(401, "locked", "Ogdoad is locked.");
      return await handleMoney(money, req, res, url);
    }
    if (url.pathname === "/ogdoad/sophia" && req.method === "GET") return sendJson(res, 200, readSophia());
    if (PRACTICE && money && url.pathname === "/ogdoad/practice/reset" && req.method === "POST") return resetPractice(money), sendJson(res, 200, { ok: true });
    if (PRACTICE && money && url.pathname === "/ogdoad/practice/statement.csv" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="practice-statement.csv"', "cache-control": "no-store" });
      return void res.end(practiceStatement(money));
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") return proxyHttp(paperclip, req, res);
    if (url.pathname.startsWith("/horos/")) return proxyHttp(horos, req, res);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(404, "not_found", "Nothing here.");
    return serveStatic(url.pathname, res);
  } catch (err) {
    sendError(res, err);
  }
});

server.on("upgrade", (req, socket, head) => {
  try {
    checkRequest(req, ALLOWED_ORIGINS);
  } catch {
    return socket.destroy();
  }
  if (!keeper.allows(req)) return socket.destroy();
  const path = req.url ?? "/";
  if (path.startsWith("/api/")) return proxyUpgrade(paperclip, req, socket as import("node:net").Socket, head);
  socket.destroy();
});

server.listen(PORT, "127.0.0.1", () => console.log(`Ogdoad ${PRACTICE ? "PRACTICE copy" : "app"} on http://127.0.0.1:${PORT} (${keeper.status().exists ? "locked until unlocked" : "no vault yet: first launch"})`));

// Horos's stop hook (or Ctrl+C) asks for an orderly stop: finish requests, close the database.
const stop = () => {
  server.close(() => {
    keeper.lock("stopped");
    process.exit(0);
  });
  setTimeout(() => {
    keeper.lock("stopped");
    process.exit(0);
  }, 3000).unref();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
