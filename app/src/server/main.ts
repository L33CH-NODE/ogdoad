// The Ogdoad app server: the operator's UI and Ogdoad's own APIs on 127.0.0.1:3101, in front of the
// Ogdoad server (/api) and Horos (/horos). Horos runs it as a server, after the Ogdoad server.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BACKUP_DIR, backupNow, listBackups } from "./backup.js";
import { handleCenter, type CenterContext } from "./center.js";
import { recipientFor, recipientOfHire, recordCrossing, recordDirectCrossing } from "./crossings.js";
import { raisedFromTeam } from "./flow/team.js";
import { teamArtifacts } from "./teamArtifacts.js";
import { checkRequest, HttpError, sendError, sendJson } from "./http.js";
import { readJson } from "./http.js";
import { hire } from "./hire.js";
import { Keeper } from "./keeper.js";
import { OGDOAD_HOME } from "./money/db.js";
import { practiceStatement, resetPractice } from "./money/practice.js";
import { handleMoney } from "./money/routes.js";
import { Vault } from "./vault.js";
import { handleDashboards } from "./dash/routes.js";
import { CalendarSync } from "./work/calendar.js";
import { handleWork } from "./work/routes.js";
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

// The live stream: open pages hear when anything changes (and when the vault locks), so every zone
// of the control center stays current without polling.
const streams = new Set<ServerResponse>();
function broadcast(event: string, data: unknown): void {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of streams) s.write(chunk);
}
setInterval(() => {
  for (const s of streams) s.write(": still here\n\n");
}, 25_000).unref();

/** The team in Flow: on in the real app; the practice copy keeps to its made-up books unless asked. */
const TEAM_FLOW = (process.env.OGDOAD_TEAM_FLOW ?? (PRACTICE ? "0" : "1")) === "1";
const CLASSIC_URL = process.env.OGDOAD_CLASSIC_URL ?? SERVER_URL;
const center: CenterContext = {
  team: async () => {
    const s = TEAM_FLOW ? readSophia() : null;
    return s ? raisedFromTeam({ serverUrl: SERVER_URL, companyId: s.companyId, classicUrl: CLASSIC_URL }) : null;
  },
  teamArtifacts: async () => {
    const s = TEAM_FLOW ? readSophia() : null;
    return s ? teamArtifacts(SERVER_URL, s.companyId) : null;
  },
};

// The team doesn't write to this server, so Ogdoad looks: when what's waiting on the operator changes
// (a hire asks something, an approval lands), every open page hears it.
let teamSeen: string | null = null;
setInterval(async () => {
  if (!streams.size || !keeper.money) return;
  const raised = await center.team!();
  if (!raised) return;
  const sig = raised.map((r) => `${r.key}|${r.title}`).sort().join("\n");
  if (teamSeen !== null && sig !== teamSeen) broadcast("changed", { area: "team" });
  teamSeen = sig;
}, 20_000).unref();

// The calendar keeps in step by itself: a few seconds after a shift changes, and every ten minutes.
let calendarTimer: NodeJS.Timeout | null = null;
let calendarBusy = false;
function syncCalendarSoon(delay = 5000): void {
  if (calendarTimer) clearTimeout(calendarTimer);
  calendarTimer = setTimeout(async () => {
    calendarTimer = null;
    const money = keeper.money;
    if (PRACTICE || !money || calendarBusy) return;
    calendarBusy = true;
    try {
      const cal = new CalendarSync(money);
      if (cal.settings().kind === "none") return;
      const r = await cal.sync();
      if (r.moved || r.cancelled || r.errors.length) broadcast("changed", { area: "work" });
    } catch {
      // Locked mid-sync, say: the next one picks it up.
    } finally {
      calendarBusy = false;
    }
  }, delay);
  calendarTimer.unref();
}
setInterval(() => syncCalendarSoon(0), 10 * 60_000).unref();

// The books are backed up while they're open: whenever the newest copy is over an hour old.
// The practice copy's books are made up, so it doesn't.
function backupIfDue(): void {
  const money = keeper.money;
  if (PRACTICE || !money) return;
  const last = listBackups()[0];
  if (last && Date.now() - Date.parse(last.at) < 60 * 60_000) return;
  try {
    backupNow(money);
  } catch (err) {
    notify("A backup of your books failed", (err as Error).message);
  }
}
setInterval(backupIfDue, 10 * 60_000).unref();

const keeper = new Keeper(PRACTICE, PRACTICE ? null : new Vault(), Number(process.env.OGDOAD_LOCK_MINUTES ?? 30) * 60_000, (why) => {
  broadcast("locked", { why });
  for (const s of streams) s.end();
  streams.clear();
  notify("Ogdoad is locked", `${why.charAt(0).toUpperCase()}${why.slice(1)}. Your password or recovery phrase opens it again.`);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true, app: "ogdoad", unlocked: keeper.status().unlocked });
    checkRequest(req, ALLOWED_ORIGINS);
    // A change that went through tells every open page, once it has.
    const area = /^\/ogdoad\/(money|flow|work|dashboards|practice)\//.exec(`${url.pathname}/`)?.[1];
    if (area && req.method !== "GET" && req.method !== "HEAD") res.on("finish", () => {
      if (res.statusCode >= 400) return;
      broadcast("changed", { area });
      if (area === "work" && !url.pathname.startsWith("/ogdoad/work/calendar")) syncCalendarSoon();
    });

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
    if (url.pathname === "/ogdoad/stream" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    const money = keeper.money;
    if (url.pathname.startsWith("/ogdoad/money/")) {
      if (!money) throw new HttpError(401, "locked", "Ogdoad is locked.");
      return await handleMoney(money, req, res, url);
    }
    if (url.pathname === "/ogdoad/dashboards" || url.pathname.startsWith("/ogdoad/dashboards/")) {
      if (!money) throw new HttpError(401, "locked", "Ogdoad is locked.");
      return await handleDashboards(money, req, res, url);
    }
    if (url.pathname.startsWith("/ogdoad/work/")) {
      if (!money) throw new HttpError(401, "locked", "Ogdoad is locked.");
      return await handleWork(money, req, res, url, { practice: PRACTICE });
    }
    if (/^\/ogdoad\/(flow|signals|artifacts|monthly|crossings)(\/|$)/.test(url.pathname)) {
      if (!money) throw new HttpError(401, "locked", "Ogdoad is locked.");
      if (await handleCenter(money, req, res, url, center)) return;
    }
    if (url.pathname === "/ogdoad/backups" && money) {
      if (req.method === "GET") return sendJson(res, 200, { practice: PRACTICE, dir: BACKUP_DIR, list: PRACTICE ? [] : listBackups() });
      if (req.method === "POST") {
        if (PRACTICE) throw new HttpError(400, "practice", "The practice copy's books are made up, so they aren't backed up.");
        return sendJson(res, 201, backupNow(money));
      }
    }
    if (url.pathname === "/ogdoad/hire" && req.method === "POST") {
      // The practice copy's books are made up, but its team would be real: no hiring from there.
      if (PRACTICE) throw new HttpError(400, "practice", "Hire from your real Ogdoad: the practice copy shares the real team.");
      const input = await readJson(req);
      const made = (await hire({ base: HOROS_URL, headers: horos.headers! }, OGDOAD_HOME, input)) as { id: string; label?: string; harness?: string };
      // Its first message goes straight to its harness.
      if (money && String(input.brief ?? "").trim()) {
        recordDirectCrossing(money, made.id, String(input.brief), recipientOfHire(made.id, OGDOAD_HOME, { label: made.label, harness: String(input.harness ?? "") }));
        broadcast("changed", { area: "crossing" });
      }
      return sendJson(res, 201, made);
    }
    if (url.pathname === "/ogdoad/sophia" && req.method === "GET") return sendJson(res, 200, readSophia());
    if (PRACTICE && money && url.pathname === "/ogdoad/practice/reset" && req.method === "POST") return resetPractice(money), sendJson(res, 200, { ok: true });
    if (PRACTICE && money && url.pathname === "/ogdoad/practice/statement.csv" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="practice-statement.csv"', "cache-control": "no-store" });
      return void res.end(practiceStatement(money));
    }
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      // A message or an answer leaving for a hire is a crossing: noted once the server has it.
      const crossing = req.method === "POST" ? /^\/api\/issues\/([^/]+)\/(comments|interactions\/[^/]+\/respond)$/.exec(url.pathname) : null;
      const books = money;
      return proxyHttp(paperclip, req, res, crossing && books ? (status, body) => {
        if (status >= 400) return;
        void recipientFor(crossing[1], SERVER_URL).then((to) => {
          recordCrossing(books, crossing[1], crossing[2] === "comments" ? "message" : "answer", body, to);
          broadcast("changed", { area: "crossing" });
        }).catch(() => {});
      } : undefined);
    }
    if (url.pathname.startsWith("/horos/")) {
      // Typed straight into a hire's terminal: a crossing too, if that hire is a cloud model.
      const typed = req.method === "POST" ? /^\/horos\/v1\/hires\/([^/]+)\/prompt$/.exec(url.pathname) : null;
      const books = money;
      return proxyHttp(horos, req, res, typed && books ? (status, body) => {
        if (status >= 400) return;
        try {
          recordDirectCrossing(books, typed[1], String(JSON.parse(body.toString("utf8")).text ?? ""), recipientOfHire(typed[1]));
          broadcast("changed", { area: "crossing" });
        } catch {
          // Best effort, as with every crossing.
        }
      } : undefined);
    }
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
