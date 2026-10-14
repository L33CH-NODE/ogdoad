// Run the engine contract: what Ogdoad, Horos and the agents rely on the engine for, as tests.
//   node contract/run.mjs              boot the isolated engine, run every test, stop it again
//   node contract/run.mjs --keep       leave it running afterwards (quicker next time)
//   ENGINE_URL=http://... node contract/run.mjs   run against an engine already up (nothing booted)

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ENGINE_URL, HOROS_URL, MAILBOX_URL, OGDOAD_HOME, PAPERCLIP_HOME, down, up } from "./engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const given = process.env.ENGINE_URL;
if (!given) await up();
const tests = readdirSync(join(here, "tests")).filter((f) => f.endsWith(".test.mjs")).map((f) => join(here, "tests", f));
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  stdio: "inherit",
  env: { ...process.env, ENGINE_URL: given ?? ENGINE_URL, CONTRACT_MAILBOX_URL: MAILBOX_URL, CONTRACT_HOROS_URL: HOROS_URL, CONTRACT_PAPERCLIP_HOME: PAPERCLIP_HOME, CONTRACT_OGDOAD_HOME: OGDOAD_HOME },
});
if (!given && !process.argv.includes("--keep")) down();
process.exitCode = run.status ?? 1;
