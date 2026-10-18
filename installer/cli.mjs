#!/usr/bin/env node
// `npx ogdoad`: set Ogdoad up on this machine, then run it. Plain Node, no dependencies of its own.
//   ogdoad                   the first time: set up, start and open. After that: start and open
//   ogdoad setup [--no-sophia] [--no-open] [--engine-port N] [--app-port N] [--horos-port N] [--new-engine]
//   ogdoad start             Horos up, and through it Nous and the app
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
//   install/ogdoad           a link to the version in use. Horos's roster points at it, so an upgrade
//                            only re-points it while everything is stopped.
//   nous/                    Nous's encrypted store, its keys and its backups
//
// Ogdoad runs on its own engine, Nous, which comes inside this package: nothing else is downloaded.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readJson(join(PKG, "package.json")).version;
const HOME = resolve(process.env.OGDOAD_HOME ?? join(homedir(), ".ogdoad"));
const NOUS_HOME = join(HOME, "nous");
const INSTALL = join(HOME, "install");
const STATE_FILE = join(INSTALL, "install.json");
const LINKS = { ogdoad: join(INSTALL, "ogdoad") };
/** What an install on the engine Ogdoad started on also linked: gone once it's on Nous. */
const OLD_LINKS = [join(INSTALL, "engine"), join(INSTALL, "live-agent")];
const DEFAULT_PORTS = { engine: 3100, app: 3101, horos: 3198 };
const LABELS = { engine: "Nous", app: "Ogdoad app" };
/** What the engine entry was called before Nous, for finding a hand-made or older install. */
const OLD_ENGINE_LABEL = "Ogdoad server";

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
    fail("This is running as root, and every agent Ogdoad hires would inherit it. Run it as yourself.");
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

/** Nous's state: null when it's down; otherwise whether it's still waiting for its key. */
async function nousState(state) {
  try {
    const r = await fetch(`${local(state.ports.engine)}/v1/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? { locked: (await r.json()).locked !== false } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Where Ogdoad lives.

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

function dropLink(link) {
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    // not there
  }
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
// Horos, and the two servers it keeps: Nous and the app.

function horosEnv(state) {
  const env = { ...process.env, OGDOAD_HOME: HOME, OGDOAD_HOROS_PORT: String(state.ports.horos), OGDOAD_URL: local(state.ports.engine), OGDOAD_NOUS_HOME: NOUS_HOME };
  if (state.ports.app !== DEFAULT_PORTS.app) env.OGDOAD_APP_URL = local(state.ports.app);
  return env;
}

const horosCliPath = () => join(existsSync(LINKS.ogdoad) ? LINKS.ogdoad : PKG, "horos", "dist", "cli.js");

function horosCli(state, args, extraEnv = {}) {
  return spawnSync(process.execPath, [horosCliPath(), ...args], { stdio: "inherit", env: { ...horosEnv(state), ...extraEnv } }).status ?? 1;
}

/**
 * Horos in the background. From an admin terminal on Windows it's started with Administrators made
 * deny-only (runas /trustlevel), so no hire inherits admin rights. runas starts it in a fresh
 * environment, so a small script carries Ogdoad's settings over.
 */
async function startHoros(state) {
  if (process.platform !== "win32" || !elevated()) return horosCli(state, ["start"]) === 0;
  if (await up(`${local(state.ports.horos)}/v1/health`)) return true;
  say("This terminal has admin rights: starting Ogdoad without them.");
  const env = horosEnv(state);
  const carried = ["OGDOAD_HOME", "OGDOAD_HOROS_PORT", "OGDOAD_URL", "OGDOAD_APP_URL", "OGDOAD_NOUS_HOME", "OGDOAD_TOASTS"].filter((k) => env[k]);
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
  const { engine, app, horos: horosPort } = state.ports;
  const appEnv = { OGDOAD_NOUS_HOME: NOUS_HOME };
  if (app !== DEFAULT_PORTS.app) appEnv.OGDOAD_APP_PORT = String(app);
  if (engine !== DEFAULT_PORTS.engine) appEnv.OGDOAD_SERVER_URL = local(engine);
  if (horosPort !== DEFAULT_PORTS.horos) appEnv.OGDOAD_HOROS_URL = local(horosPort);
  const server = { harness: "generic", command: process.execPath, cwd: HOME, keep: true, role: "server" };
  return {
    // Nous answers its health check locked or not: it waits for its key from the operator's vault.
    engine: { ...server, label: LABELS.engine, args: [join(LINKS.ogdoad, "nous", "dist", "main.js")], health: `${local(engine)}/v1/health`, env: { NOUS_PORT: String(engine), NOUS_HOME } },
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

async function bringUp(state) {
  if (!(await startHoros(state))) fail(`Horos didn't start; see ${join(HOME, "horos", "horos.log")}.`);
  const specs = serverSpecs(state);
  state.ids = { ...state.ids };
  state.ids.engine = await ensureServer(state, "engine", specs.engine);
  if (!(await waitFor(specs.engine.health, "Starting Nous, the engine", 2))) {
    fail(`Nous didn't come up. See its screen: ogdoad horos screen ${state.ids.engine}`);
  }
  state.ids.app = await ensureServer(state, "app", specs.app);
  if (!(await waitFor(specs.app.health, "Starting the app", 2))) fail(`The app didn't come up. See its screen: ogdoad horos screen ${state.ids.app}`);
  writeJson(STATE_FILE, state);
}

// ---------------------------------------------------------------------------------------------
// Commands.

/** Ogdoad set up by hand on this machine (its servers already on Horos's roster, no install record). */
function setUpByHand() {
  const roster = readJson(join(HOME, "horos", "roster.json"), []);
  return Array.isArray(roster) && roster.some((e) => [LABELS.app, LABELS.engine, OLD_ENGINE_LABEL].includes(e.label));
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

/** An install from before Nous: its engine was Paperclip, and its team lives in that engine's data. */
const onOldEngine = (state) => !!state?.engine && state.engine !== "nous";

/**
 * Moving an install from before Nous onto it, when the operator asked (--new-engine). Everything is
 * stopped; the old engine's entry and the hires seated on it leave Horos's roster (their sessions and
 * the old engine's data are left as they are); SOPHIA's record is kept aside, so she's chosen again on
 * Nous. The operator's books (Money, Work, dashboards) carry on untouched.
 */
function leaveOldEngine(before) {
  horosCli(before, ["stop"]);
  const file = join(HOME, "horos", "roster.json");
  const roster = readJson(file, []);
  const gone = roster.filter((e) => e.id === before.ids?.engine || e.label === OLD_ENGINE_LABEL || e.seat);
  writeJson(file, roster.filter((e) => !gone.includes(e)));
  for (const e of gone) say(`  off the roster: ${e.label ?? e.id}`);
  const sophia = join(HOME, "sophia.json");
  if (existsSync(sophia)) renameSync(sophia, join(HOME, "sophia.before-nous.json"));
  for (const link of OLD_LINKS) dropLink(link);
  pruneOld(join(INSTALL, "engines"), []);
}

async function setup() {
  preflight();
  const before = readJson(STATE_FILE, null);
  if (!before && setUpByHand()) {
    say("Ogdoad on this machine was set up by hand: its servers are already on Horos's roster. Start it the way you usually do;");
    say("`ogdoad status` shows what's running.");
    return null;
  }
  if (onOldEngine(before) && !has("new-engine")) {
    fail([
      `This Ogdoad (${before.version}) runs on the engine it started on, Paperclip ${before.engine}. Ogdoad ${VERSION} runs on its own engine, Nous.`,
      "Your books (Money, Work, dashboards) carry over as they are. The team's tasks and talk stay in the old engine's data, untouched.",
      "  To move onto Nous with a fresh team (you'll choose SOPHIA again): npx ogdoad setup --new-engine",
      "  To bring the old tasks across too, see \"Moving in\" in docs/NOUS.md first.",
      "  To stay where you are: npx ogdoad@0.1",
    ].join("\n"));
  }
  // A copy: `before` keeps the version being upgraded from, for the prune at the end.
  const state = before ? { ...before } : { ports: portsFromFlags(), ids: {} };
  if (!before) {
    for (const [key, port] of Object.entries(state.ports)) {
      if (!(await portFree(port))) fail(`Port ${port} (${key}) is taken. Choose another with --${key}-port.`);
    }
  }

  const root = stableRoot();
  if (!existsSync(join(root, "nous", "dist", "main.js"))) fail(`This copy of Ogdoad has no Nous in it (${join(root, "nous", "dist")}). Reinstall it: npx ogdoad@${VERSION}`);

  const upgrading = before && (before.version !== VERSION || onOldEngine(before));
  if (onOldEngine(before)) {
    say(`Moving Ogdoad onto Nous: stopping it first (work in flight finishes)...`);
    leaveOldEngine(before);
    delete state.ids.engine;
    delete state.welcomed;
    delete state.paperclipHome;
    delete state.ports.mailbox;
  } else if (upgrading && (await up(`${local(state.ports.horos)}/v1/health`))) {
    say(`Upgrading Ogdoad ${before.version} to ${VERSION}: stopping it first (work in flight finishes)...`);
    horosCli(state, ["stop"]);
  }
  pointLink(LINKS.ogdoad, root);
  // Recorded before anything starts, so a run that fails partway is picked up by the next one.
  Object.assign(state, { version: VERSION, engine: "nous", at: new Date().toISOString() });
  writeJson(STATE_FILE, state);

  await bringUp(state);
  if (upgrading && before.version !== VERSION) pruneOld(join(INSTALL, "versions"), [VERSION, before.version]);
  if (!before) say(`\nOgdoad ${VERSION} is set up.`);
  return state;
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

/**
 * The first time through: choose SOPHIA, the CEO. Offered until it's been done or declined. Nous opens
 * with the key the operator's vault hands it, so the key is made first, in the browser; the chooser
 * starts here once it is. True when the browser was opened along the way.
 */
async function welcome(state) {
  if (state.welcomed || existsSync(join(HOME, "sophia.json"))) return false;
  if (has("no-sophia")) {
    state.welcomed = true;
    writeJson(STATE_FILE, state);
    return false;
  }
  if (!process.stdin.isTTY) return false;
  let browser = false;
  if ((await nousState(state))?.locked) {
    opened(state);
    browser = true;
    say("Make your key in the browser: a password, and a recovery phrase to write down. Everything Ogdoad keeps is encrypted with it.");
    say("SOPHIA's chooser starts here once it's made.");
    const until = Date.now() + 20 * 60_000;
    while ((await nousState(state))?.locked !== false && Date.now() < until) await sleep(2000);
    if ((await nousState(state))?.locked !== false) {
      say("\nSOPHIA can be chosen any time once your key is made: ogdoad sophia");
      return browser;
    }
  }
  say("");
  if (horosCli(state, ["sophia", "--no-browser"]) !== 0) say("\nSOPHIA can be chosen any time: ogdoad sophia");
  state.welcomed = true;
  writeJson(STATE_FILE, state);
  return browser;
}

function current() {
  const state = readJson(STATE_FILE, null);
  if (state) return state;
  if (setUpByHand()) return { ports: { ...DEFAULT_PORTS }, byHand: true };
  fail("Ogdoad isn't set up here yet. Run: npx ogdoad");
}

async function status() {
  const state = current();
  say(`Ogdoad ${state.version ?? "(set up by hand)"}${onOldEngine(state) ? `, on the old engine (Paperclip ${state.engine}): npx ogdoad setup to move onto Nous` : ""}`);
  const nous = await nousState(state);
  say(`  ${"Horos".padEnd(7)} ${(await up(`${local(state.ports.horos)}/v1/health`)) ? "up  " : "down"}  ${local(state.ports.horos)}`);
  say(`  ${"Nous".padEnd(7)} ${nous ? (nous.locked ? "up, waiting for your key" : "up  ") : "down"}  ${local(state.ports.engine)}`);
  say(`  ${"app".padEnd(7)} ${(await up(`${local(state.ports.app)}/healthz`)) ? "up  " : "down"}  ${local(state.ports.app)}`);
}

async function main() {
  if (has("version") || argv[0] === "-v") return say(VERSION);
  switch (command) {
    case "up":
    case "setup": {
      const before = readJson(STATE_FILE, null);
      let state = before;
      if (command === "setup" || !before || before.version !== VERSION || onOldEngine(before)) {
        state = await setup();
        if (!state) return;
      } else {
        preflight();
        await bringUp(state);
      }
      if (!(await welcome(state))) opened(state);
      return;
    }
    case "start": {
      const state = current();
      if (state.byHand) fail("Ogdoad on this machine was set up by hand; start it the way you usually do.");
      if (onOldEngine(state)) fail("This install is on the old engine. Run npx ogdoad setup to move onto Nous.");
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
      process.exitCode = horosCli(current(), ["sophia", ...rest]);
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
