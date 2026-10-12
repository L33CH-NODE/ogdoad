#!/usr/bin/env node
// `npx ogdoad`: set Ogdoad up on this machine, then run it. Plain Node, no dependencies of its own.
//   ogdoad                   the first time: set up, start and open. After that: start and open
//   ogdoad setup [--no-sophia] [--no-open] [--engine-port N] [--app-port N] [--horos-port N] [--mailbox-port N]
//   ogdoad start             Horos up, and through it the engine and the app
//   ogdoad stop [--now]      everything down (gracefully: work in flight finishes first)
//   ogdoad status
//   ogdoad open
//   ogdoad sophia [...]      choose SOPHIA, the CEO (the same wizard as horos sophia)
//   ogdoad horos <...>       drive Horos directly (ogdoad horos help)
//   ogdoad --version
//
// What goes where (all under ~/.ogdoad, or OGDOAD_HOME):
//   install/install.json     what was set up: version, ports, the two servers' roster ids
//   install/versions/<v>     Ogdoad itself, copied out of npx's cache (npm may clear that)
//   install/engines/<v>      the engine (Paperclip, pinned), with Ogdoad's patches applied
//   install/ogdoad, install/engine, install/live-agent
//                            links to the versions in use. Horos's roster points at these, so an
//                            upgrade only re-points them while everything is stopped.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readJson(join(PKG, "package.json")).version;
const ENGINE_VERSION = readJson(join(PKG, "runtime", "package.json")).dependencies.paperclipai;
const HOME = resolve(process.env.OGDOAD_HOME ?? join(homedir(), ".ogdoad"));
const INSTALL = join(HOME, "install");
const STATE_FILE = join(INSTALL, "install.json");
const LINKS = { ogdoad: join(INSTALL, "ogdoad"), engine: join(INSTALL, "engine"), adapter: join(INSTALL, "live-agent") };
const DEFAULT_PORTS = { engine: 3100, app: 3101, horos: 3198, mailbox: 3199 };
const ADAPTER = "paperclip-adapter-live-agent";
const LABELS = { engine: "Ogdoad server", app: "Ogdoad app" };

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "up";
const rest = argv[0] === command ? argv.slice(1) : argv;
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const say = (s = "") => console.log(s);
/** Stop here with a message. Thrown, not process.exit(): exiting while fetch's sockets close trips a libuv assert on Windows. */
class Stop extends Error {}
function fail(message) {
  throw new Stop(message);
}
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (port) => `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------------------------
// Checks before anything starts.

function elevated() {
  if (process.platform !== "win32") return typeof process.getuid === "function" && process.getuid() === 0;
  const net = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "net.exe");
  return spawnSync(net, ["session"], { stdio: "ignore", windowsHide: true }).status === 0;
}

function preflight() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) fail(`Ogdoad needs Node 22.5 or newer; this is Node ${process.versions.node}.`);
  // On Windows Horos is started without admin rights instead (startHoros); elsewhere, no root.
  if (process.platform !== "win32" && elevated()) {
    fail("This is running as root. The engine's database refuses to, and every agent Ogdoad hires would inherit it. Run it as yourself.");
  }
}

function portFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.once("listening", () => probe.close(() => done(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function up(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(url, what, minutes) {
  const until = Date.now() + minutes * 60_000;
  let dots = false;
  while (Date.now() < until) {
    if (await up(url)) {
      if (dots) process.stdout.write(" up\n");
      return true;
    }
    process.stdout.write(dots ? "." : `${what}...`);
    dots = true;
    await sleep(2000);
  }
  if (dots) process.stdout.write("\n");
  return false;
}

// ---------------------------------------------------------------------------------------------
// Where Ogdoad, the adapter and the engine live.

/** Ogdoad run by npx lives in a cache npm may clear: copy it (with its dependencies) somewhere that stays. */
function stableRoot() {
  if (!PKG.split(/[\\/]/).includes("_npx")) return PKG;
  const from = resolve(PKG, "..", "..");
  const to = join(INSTALL, "versions", VERSION);
  const root = join(to, "node_modules", "ogdoad");
  if (readJson(join(root, "package.json"), {}).version !== VERSION) {
    say(`Copying Ogdoad ${VERSION} out of npx's cache...`);
    const partial = `${to}.partial`;
    rmSync(partial, { recursive: true, force: true });
    cpSync(from, partial, { recursive: true, verbatimSymlinks: true });
    rmSync(to, { recursive: true, force: true });
    renameSync(partial, to);
  }
  return root;
}

/** A dependency, wherever npm put it: beside Ogdoad (hoisted) or inside it. */
function findPackage(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** Point a link (a junction on Windows: no admin rights needed) at a folder. */
function pointLink(link, target) {
  mkdirSync(dirname(link), { recursive: true });
  let stat = null;
  try {
    stat = lstatSync(link);
  } catch {
    // no link yet
  }
  if (stat) {
    if (!stat.isSymbolicLink()) fail(`${link} is in the way: Ogdoad expected a link there.`);
    if (existsSync(link) && realpathSync(link) === realpathSync(target)) return;
    unlinkSync(link);
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** npm itself, run by this same Node (a .cmd shim can't be spawned without a shell on Windows). */
function npm(args, cwd) {
  const nodeDir = dirname(process.execPath);
  const cli = [process.env.npm_execpath, join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find(
    (p) => p && /npm-cli\.js$/.test(p) && existsSync(p),
  );
  // Whatever npx was asked to do (global, a prefix) isn't meant for this install.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_(global|prefix|location)$/i.test(k)));
  const run = cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd, env, stdio: "inherit" })
    : spawnSync("npm", args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
  if (run.status !== 0) fail(`npm ${args.join(" ")} failed (in ${cwd}).`);
}

function ensureEngine(root) {
  const dir = join(INSTALL, "engines", ENGINE_VERSION);
  if (!existsSync(join(dir, "node_modules", "paperclipai", "dist", "index.js"))) {
    say(`Installing the engine (Paperclip ${ENGINE_VERSION}). The first time takes a few minutes...`);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, "package.json"), { name: "ogdoad-engine", private: true, dependencies: { paperclipai: ENGINE_VERSION } });
    npm(["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], dir);
  }
  spawnSync(process.execPath, [join(root, "runtime", "patches", "apply.mjs"), dir], { stdio: "inherit" });
  return dir;
}

function pruneOld(parent, keep) {
  if (!existsSync(parent)) return;
  for (const name of readdirSync(parent)) {
    if (keep.includes(name)) continue;
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
    } catch {
      // still in use: next time
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Horos, and the two servers it keeps: the engine and the app.

function horosEnv(state) {
  const env = { ...process.env, OGDOAD_HOME: HOME, OGDOAD_HOROS_PORT: String(state.ports.horos) };
  if (state.ports.mailbox !== DEFAULT_PORTS.mailbox) env.LIVE_AGENT_MAILBOX = local(state.ports.mailbox);
  if (state.paperclipHome) env.PAPERCLIP_HOME = state.paperclipHome;
  return env;
}

const horosCliPath = () => join(existsSync(LINKS.ogdoad) ? LINKS.ogdoad : PKG, "horos", "dist", "cli.js");

function horosCli(state, args, extraEnv = {}) {
  return spawnSync(process.execPath, [horosCliPath(), ...args], { stdio: "inherit", env: { ...horosEnv(state), ...extraEnv } }).status ?? 1;
}

/**
 * Horos in the background. From an admin terminal on Windows it's started with Administrators made
 * deny-only (runas /trustlevel): the engine's database refuses an admin token, and every hire would
 * inherit it. runas starts it in a fresh environment, so a small script carries Ogdoad's settings over.
 */
async function startHoros(state) {
  if (process.platform !== "win32" || !elevated()) return horosCli(state, ["start"]) === 0;
  if (await up(`${local(state.ports.horos)}/v1/health`)) return true;
  say("This terminal has admin rights: starting Ogdoad without them.");
  const env = horosEnv(state);
  const carried = ["OGDOAD_HOME", "OGDOAD_HOROS_PORT", "LIVE_AGENT_MAILBOX", "PAPERCLIP_HOME"].filter((k) => env[k]);
  const script = join(INSTALL, "start-horos.cmd");
  // UTF-8 for any non-ASCII path, and a batch file's % doubled.
  const bat = (s) => s.replace(/%/g, "%%");
  writeFileSync(script, ["@echo off", "chcp 65001 >nul", ...carried.map((k) => `set "${k}=${bat(env[k])}"`), `"${bat(process.execPath)}" "${bat(horosCliPath())}" start`, ""].join("\r\n"));
  const runas = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "runas.exe");
  spawnSync(runas, ["/trustlevel:0x20000", `cmd /c "${script}"`], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 60; i++) {
    if (await up(`${local(state.ports.horos)}/v1/health`)) return true;
    await sleep(500);
  }
  return false;
}

async function horos(state, method, path, body) {
  const token = readFileSync(join(HOME, "horos", "horos.token"), "utf8").trim();
  const res = await fetch(local(state.ports.horos) + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (res.status === 401) fail(`Something else answers as Horos on port ${state.ports.horos}. Choose another with --horos-port.`);
  if (!res.ok) throw new Error(`Horos ${method} ${path}: ${json?.error ?? res.status} ${json?.message ?? ""}`.trim());
  return json;
}

function serverSpecs(state) {
  const { engine, app, horos: horosPort, mailbox } = state.ports;
  const engineEnv = { PAPERCLIP_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", PAPERCLIP_UPDATE_CHECK: "0", PAPERCLIP_NO_BROWSER: "true", PORT: String(engine) };
  const appEnv = {};
  if (mailbox !== DEFAULT_PORTS.mailbox) engineEnv.LIVE_AGENT_MAILBOX_PORT = String(mailbox);
  if (app !== DEFAULT_PORTS.app) appEnv.OGDOAD_APP_PORT = String(app);
  if (engine !== DEFAULT_PORTS.engine) appEnv.OGDOAD_SERVER_URL = local(engine);
  if (horosPort !== DEFAULT_PORTS.horos) appEnv.OGDOAD_HOROS_URL = local(horosPort);
  if (state.paperclipHome) {
    engineEnv.PAPERCLIP_HOME = state.paperclipHome;
    appEnv.OGDOAD_ENGINE_BACKUPS = join(state.paperclipHome, "instances", "default", "data", "backups");
  }
  const server = { harness: "generic", command: process.execPath, cwd: HOME, keep: true, role: "server" };
  return {
    // `onboard --yes` sets the engine up the first time (quick defaults: this machine only, no
    // sign-in), and from then on keeps the config it finds and runs it.
    engine: { ...server, label: LABELS.engine, args: [join(LINKS.engine, "node_modules", "paperclipai", "dist", "index.js"), "onboard", "--yes", "--no-install-service"], health: `${local(engine)}/api/health`, env: engineEnv },
    app: { ...server, label: LABELS.app, args: [join(LINKS.ogdoad, "app", "dist", "server", "main.js")], health: `${local(app)}/healthz`, env: appEnv },
  };
}

/** The roster entry for a server: the one this install made, or one by the same name; spawned if neither. */
async function ensureServer(state, key, spec) {
  const roster = await horos(state, "GET", "/v1/roster");
  const found = roster.find((e) => e.id === state.ids?.[key]) ?? roster.find((e) => e.label === spec.label);
  if (found) return found.id;
  return (await horos(state, "POST", "/v1/hires", spec)).id;
}

/** The live-agent adapter, so agents are hired through a mailbox and the engine holds no provider logins. */
async function ensureAdapter(state) {
  const base = local(state.ports.engine);
  const headers = { "content-type": "application/json", origin: base };
  const adapters = await fetch(`${base}/api/adapters`, { headers }).then((r) => r.json(), () => []);
  if (Array.isArray(adapters) && adapters.some((a) => a.type === "live_agent")) return;
  const res = await fetch(`${base}/api/adapters/install`, { method: "POST", headers, body: JSON.stringify({ packageName: LINKS.adapter, isLocalPath: true }) });
  if (!res.ok) fail(`The engine wouldn't take the live-agent adapter: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function bringUp(state) {
  if (!(await startHoros(state))) fail(`Horos didn't start; see ${join(HOME, "horos", "horos.log")}.`);
  const specs = serverSpecs(state);
  state.ids = { ...state.ids };
  // Looked at before the engine starts: its first start writes this config straight away.
  const engineConfig = join(state.paperclipHome ?? join(homedir(), ".paperclip"), "instances", "default", "config.json");
  const starting = existsSync(engineConfig) ? "Starting the engine" : "Starting the engine (the first start creates its database)";
  state.ids.engine = await ensureServer(state, "engine", specs.engine);
  if (!(await waitFor(specs.engine.health, starting, 10))) {
    fail(`The engine didn't come up. See its screen: ogdoad horos screen ${state.ids.engine}`);
  }
  await ensureAdapter(state);
  state.ids.app = await ensureServer(state, "app", specs.app);
  if (!(await waitFor(specs.app.health, "Starting the app", 2))) fail(`The app didn't come up. See its screen: ogdoad horos screen ${state.ids.app}`);
  writeJson(STATE_FILE, state);
}

// ---------------------------------------------------------------------------------------------
// Commands.

/** Ogdoad set up by hand on this machine (its servers already on Horos's roster, no install record). */
function setUpByHand() {
  const roster = readJson(join(HOME, "horos", "roster.json"), []);
  return Array.isArray(roster) && roster.some((e) => e.label === LABELS.app || e.label === LABELS.engine);
}

function portsFromFlags() {
  const ports = { ...DEFAULT_PORTS };
  for (const key of Object.keys(ports)) {
    const value = flag(`${key}-port`);
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`--${key}-port needs a port number.`);
    ports[key] = n;
  }
  return ports;
}

async function setup() {
  preflight();
  const before = readJson(STATE_FILE, null);
  if (!before && setUpByHand()) {
    say("Ogdoad on this machine was set up by hand: its servers are already on Horos's roster. Start it the way you usually do;");
    say("`ogdoad status` shows what's running.");
    return null;
  }
  // A copy: `before` keeps the versions being upgraded from, for the prune at the end.
  const state = before ? { ...before } : { ports: portsFromFlags(), paperclipHome: process.env.PAPERCLIP_HOME ? resolve(process.env.PAPERCLIP_HOME) : null, ids: {} };
  if (!before) {
    for (const [key, port] of Object.entries(state.ports)) {
      if (!(await portFree(port))) fail(`Port ${port} (${key}) is taken. Choose another with --${key}-port.`);
    }
  }

  const root = stableRoot();
  const found = findPackage(root, ADAPTER) ?? (process.env.OGDOAD_LIVE_AGENT ? resolve(process.env.OGDOAD_LIVE_AGENT) : null);
  if (!found || !existsSync(join(found, "package.json"))) fail(`The live-agent adapter (${ADAPTER}) isn't installed alongside Ogdoad.`);
  const engineDir = ensureEngine(root);

  const upgrading = before && (before.version !== VERSION || before.engine !== ENGINE_VERSION);
  if (upgrading && (await up(`${local(state.ports.horos)}/v1/health`))) {
    say(`Upgrading Ogdoad ${before.version} to ${VERSION}: stopping it first (work in flight finishes)...`);
    horosCli(state, ["stop"]);
  }
  pointLink(LINKS.ogdoad, root);
  pointLink(LINKS.engine, engineDir);
  pointLink(LINKS.adapter, found);
  // Recorded before anything starts, so a run that fails partway is picked up by the next one.
  Object.assign(state, { version: VERSION, engine: ENGINE_VERSION, at: new Date().toISOString() });
  writeJson(STATE_FILE, state);

  await bringUp(state);
  if (upgrading && before.version !== VERSION) pruneOld(join(INSTALL, "versions"), [VERSION, before.version]);
  if (upgrading && before.engine !== ENGINE_VERSION) pruneOld(join(INSTALL, "engines"), [ENGINE_VERSION, before.engine]);
  if (!before) say(`\nOgdoad ${VERSION} is set up.`);
  return state;
}

/** The first time through: choose SOPHIA, the CEO. Offered until it's been done or declined. */
function welcome(state) {
  if (state.welcomed || existsSync(join(HOME, "sophia.json"))) return;
  if (!has("no-sophia")) {
    if (!process.stdin.isTTY) return;
    say("");
    if (horosCli(state, ["sophia", "--no-browser"], { OGDOAD_URL: local(state.ports.engine) }) !== 0) say("\nSOPHIA can be chosen any time: ogdoad sophia");
  }
  state.welcomed = true;
  writeJson(STATE_FILE, state);
}

function current() {
  const state = readJson(STATE_FILE, null);
  if (state) return state;
  if (setUpByHand()) return { ports: { ...DEFAULT_PORTS }, byHand: true };
  fail("Ogdoad isn't set up here yet. Run: npx ogdoad");
}

function openInBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // the printed link covers it
  }
}

function opened(state) {
  const url = local(state.ports.app);
  say(`\nOgdoad: ${url}`);
  if (!has("no-open")) openInBrowser(url);
}

async function status() {
  const state = current();
  say(`Ogdoad ${state.version ?? "(set up by hand)"}${state.engine ? `, engine Paperclip ${state.engine}` : ""}`);
  const rows = [
    ["Horos", `${local(state.ports.horos)}/v1/health`, local(state.ports.horos)],
    ["engine", `${local(state.ports.engine)}/api/health`, local(state.ports.engine)],
    ["app", `${local(state.ports.app)}/healthz`, local(state.ports.app)],
  ];
  for (const [name, health, url] of rows) say(`  ${name.padEnd(7)} ${(await up(health)) ? "up  " : "down"}  ${url}`);
}

async function main() {
  if (has("version") || argv[0] === "-v") return say(VERSION);
  switch (command) {
    case "up":
    case "setup": {
      const before = readJson(STATE_FILE, null);
      let state = before;
      if (command === "setup" || !before || before.version !== VERSION || before.engine !== ENGINE_VERSION) {
        state = await setup();
        if (!state) return;
      } else {
        preflight();
        await bringUp(state);
      }
      welcome(state);
      return opened(state);
    }
    case "start": {
      const state = current();
      if (state.byHand) fail("Ogdoad on this machine was set up by hand; start it the way you usually do.");
      preflight();
      await bringUp(state);
      return say(`Ogdoad is up: ${local(state.ports.app)}`);
    }
    case "stop": {
      const state = current();
      process.exitCode = horosCli(state, ["stop", ...(has("now") ? ["--now"] : [])]);
      return;
    }
    case "status":
      return status();
    case "open":
      return opened(current());
    case "sophia": {
      const state = current();
      process.exitCode = horosCli(state, ["sophia", ...rest], { OGDOAD_URL: local(state.ports.engine) });
      return;
    }
    case "horos":
      process.exitCode = horosCli(current(), rest);
      return;
    default:
      say(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//   ogdoad")).map((l) => l.slice(3)).join("\n"));
  }
}

main().catch((err) => {
  console.error(`\n${err instanceof Stop ? err.message : (err?.stack ?? String(err))}`);
  process.exitCode = 1;
});
