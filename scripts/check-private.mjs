#!/usr/bin/env node
// Before anything is published: look through what's about to leave for secrets and for anything private
// (the operator's names, machines, addresses, their other projects). It reads every added line in every
// commit about to be pushed, and every commit message, not just the files as they are now, because a
// push publishes the whole history.
//
// The secret shapes are here. The private words are not: they'd publish what they protect. They live
// on the operator's machine, in ~/.ogdoad/private-words.txt (one per line; /regex/flags allowed).
//
//   node scripts/check-private.mjs                 commits not yet on origin/main
//   node scripts/check-private.mjs A..B            a range
//   node scripts/check-private.mjs --all           the whole history
//   node scripts/check-private.mjs --tree          the files as they are now
//   node scripts/check-private.mjs --package       the files npm would publish, built ones included
//   (as a git pre-push hook it reads the refs being pushed from stdin; as postpack, --package)
//
// Exit 1 when anything is found. Matches are shown masked: this prints where, never the secret itself.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORDS_FILE = process.env.OGDOAD_PRIVATE_WORDS ?? join(homedir(), ".ogdoad", "private-words.txt");

/** Secret shapes: tokens and keys that should never be in a repo, whoever they belong to. */
const SECRETS = [
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "a GitHub token"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/, "an npm token"],
  [/\bhf_[A-Za-z0-9]{30,}\b/, "a Hugging Face token"],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\btskey-[A-Za-z0-9-]{10,}/, "a Tailscale key"],
  [/-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/, "a private key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a signed token (JWT)"],
  [/\b(password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{12,}["']/i, "a hard-coded secret"],
];

/** Emails that are fine anywhere: made-up domains, and the anonymous ones on purpose. */
const OK_EMAIL = /@(example\.(com|org|net)|[\w.-]+\.(example|invalid|test|localhost)|users\.noreply\.github\.com|anthropic\.com|paperclip\.(ing|dev))\b|noreply@|no-reply@/i;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}/g;

function privateWords() {
  if (!existsSync(WORDS_FILE)) {
    console.error(`No private words at ${WORDS_FILE}: only secret shapes are checked. Add the words that must never be published.`);
    return [];
  }
  return readFileSync(WORDS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((w) => {
    const re = /^\/(.+)\/([a-z]*)$/.exec(w);
    if (re) return [new RegExp(re[1], re[2].replace("g", "")), "a private word"];
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [new RegExp(`(?<![\\w-])${esc}(?![\\w-])`, "i"), "a private word"];
  });
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 });
const mask = (s) => (s.length <= 6 ? `${s[0]}…` : `${s.slice(0, 3)}…${s.slice(-2)}`);

function ranges() {
  const arg = process.argv[2];
  if (arg === "--all") return [["--all"]];
  if (arg === "--tree" || arg === "--package") return null;
  if (arg && arg.includes("..")) return [[arg]];
  // As a pre-push hook: "<local ref> <local sha> <remote ref> <remote sha>" per line.
  if (!process.stdin.isTTY && !arg) {
    let input = "";
    try {
      input = readFileSync(0, "utf8");
    } catch {}
    const out = [];
    for (const line of input.split(/\r?\n/).filter(Boolean)) {
      const [, local, , remote] = line.split(" ");
      if (/^0+$/.test(local)) continue; // a delete
      out.push(/^0+$/.test(remote) ? [local, "--not", "--remotes"] : [`${remote}..${local}`]);
    }
    if (out.length) return out;
  }
  return [["origin/main..HEAD"]];
}

/** What may pass, and why (.check-private-allow at the repo's root): upstream imports, and known-innocent lines. */
function allowed() {
  const file = join(git("rev-parse", "--show-toplevel").trim(), ".check-private-allow");
  const out = { commits: new Set(), texts: [] };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim())) {
    const m = /^(commit|text)\s+(.+)$/.exec(line);
    if (m?.[1] === "commit") out.commits.add(m[2].trim().slice(0, 7));
    else if (m?.[1] === "text") out.texts.push(m[2].trim());
  }
  return out;
}

const allow = allowed();
const rules = [...SECRETS, ...privateWords()];
const found = [];
const check = (where, text) => {
  if (allow.texts.some((t) => text.includes(t))) return;
  for (const [re, what] of rules) {
    const m = re.exec(text);
    if (m) found.push(`${where}: ${what} (${mask(m[0])})`);
  }
  for (const m of text.matchAll(EMAIL)) if (!OK_EMAIL.test(m[0])) found.push(`${where}: an email address (${mask(m[0])})`);
};

const r = ranges();
/** What npm would put in the package (scripts off: this runs as postpack, and the build has just run). */
function packageFiles() {
  const npm = process.env.npm_execpath && /npm-cli\.js$/.test(process.env.npm_execpath) ? [process.execPath, [process.env.npm_execpath]] : ["npm", []];
  const out = execFileSync(npm[0], [...npm[1], "pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", shell: npm[0] === "npm" && process.platform === "win32" });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

if (!r) {
  // The files as they are now: tracked ones, or the package's.
  const files = process.argv[2] === "--package" ? packageFiles() : git("ls-files").split("\n").filter(Boolean);
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    text.split(/\r?\n/).forEach((line, i) => check(`${file}:${i + 1}`, line));
  }
} else {
  for (const range of r) {
    // Every commit message, and every line any commit adds.
    for (const c of git("log", "--format=%H%x00%B%x01", ...range).split("\u0001")) {
      const [sha, msg] = c.trim().split("\u0000");
      if (sha && !allow.commits.has(sha.slice(0, 7))) check(`commit ${sha.slice(0, 7)} message`, msg ?? "");
    }
    let file = "";
    let sha = "";
    for (const line of git("log", "-p", "--no-color", "--format=commit %H", "--unified=0", ...range).split("\n")) {
      if (line.startsWith("commit ")) sha = line.slice(7, 14);
      else if (line.startsWith("+++ b/")) file = line.slice(6);
      else if (line.startsWith("+") && !line.startsWith("+++") && !allow.commits.has(sha)) check(`${sha} ${file}`, line.slice(1));
    }
  }
}

const unique = [...new Set(found)];
if (unique.length) {
  console.error(`Not ready to publish: ${unique.length} thing${unique.length === 1 ? "" : "s"} to look at.`);
  const limit = Number(process.env.CHECK_PRIVATE_LIMIT ?? 400);
  for (const f of unique.slice(0, limit)) console.error(`  ${f}`);
  if (unique.length > limit) console.error(`  …and ${unique.length - limit} more`);
  process.exit(1);
}
console.log("Nothing private or secret found.");
