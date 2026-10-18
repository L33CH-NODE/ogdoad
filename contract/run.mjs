// Run the engine contract: what Ogdoad, Horos and the agents relied on the engine for, as tests. They
// speak the routes Ogdoad started with, which Nous's translator keeps for workers outside Horos; Nous's
// own API (/v1) is tested in nous/ and end to end with the app.
//   node contract/run.mjs              boot an isolated Nous, run every test, stop it again
//   node contract/run.mjs --keep       leave it running afterwards (quicker next time)
//   ENGINE_URL=http://... node contract/run.mjs     against an engine already up (nothing booted)

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINE_URL, KEYS_DIR, MAILBOX_URL, down, operatorToken, up } from "./engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const given = process.env.ENGINE_URL;
if (!given) await up();
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const tests = readdirSync(join(here, "tests"))
  .filter((f) => f.endsWith(".test.mjs") && (!only.length || only.some((o) => f.includes(o))))
  .map((f) => join(here, "tests", f));
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  stdio: "inherit",
  env: {
    ...process.env,
    ENGINE_URL: given ?? ENGINE_URL,
    CONTRACT_MAILBOX_URL: process.env.CONTRACT_MAILBOX_URL ?? MAILBOX_URL,
    CONTRACT_KEYS_DIR: process.env.CONTRACT_KEYS_DIR ?? KEYS_DIR,
    CONTRACT_OPERATOR_TOKEN: process.env.CONTRACT_OPERATOR_TOKEN ?? operatorToken(),
  },
});
if (!given && !process.argv.includes("--keep")) down();
process.exitCode = run.status ?? 1;
