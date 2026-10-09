// The Ogdoad app server: the operator's UI and Ogdoad's own APIs on 127.0.0.1:3101, in front of the
// Ogdoad server (/api) and Horos (/horos). Horos runs it as a server, after the Ogdoad server.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkRequest, HttpError, sendError, sendJson } from "./http.js";
import { openMoneyDb, OGDOAD_HOME } from "./money/db.js";
import { practiceStatement, resetPractice, seedPractice } from "./money/practice.js";
import { handleMoney } from "./money/routes.js";
import { Money } from "./money/service.js";
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

const money = new Money(openMoneyDb());
if (PRACTICE && !money.invoices().length) seedPractice(money);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, app: "ogdoad", money: true });
    checkRequest(req, ALLOWED_ORIGINS);
    if (url.pathname.startsWith("/ogdoad/money/")) return await handleMoney(money, req, res, url);
    if (url.pathname === "/ogdoad/sophia" && req.method === "GET") return sendJson(res, 200, readSophia());
    if (url.pathname === "/ogdoad/app" && req.method === "GET") return sendJson(res, 200, { practice: PRACTICE, realAppPort: 3101 });
    if (PRACTICE && url.pathname === "/ogdoad/practice/reset" && req.method === "POST") return resetPractice(money), sendJson(res, 200, { ok: true });
    if (PRACTICE && url.pathname === "/ogdoad/practice/statement.csv" && req.method === "GET") {
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
  const path = req.url ?? "/";
  if (path.startsWith("/api/")) return proxyUpgrade(paperclip, req, socket as import("node:net").Socket, head);
  socket.destroy();
});

server.listen(PORT, "127.0.0.1", () => console.log(`Ogdoad ${PRACTICE ? "PRACTICE copy" : "app"} on http://127.0.0.1:${PORT} (Money: ${money.invoices().length} invoices)`));

// Horos's stop hook (or Ctrl+C) asks for an orderly stop: finish requests, close the database.
const stop = () => {
  server.close(() => {
    money.db.close();
    process.exit(0);
  });
  setTimeout(() => {
    money.db.close();
    process.exit(0);
  }, 3000).unref();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
