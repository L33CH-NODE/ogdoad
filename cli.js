#!/usr/bin/env node
// `npx ogdoad`: the installer will live here. For now it says what Ogdoad is and where the working pieces are.
const { version } = require("./package.json");

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(version);
  process.exit(0);
}

console.log(`
  0GD0AD  v${version}

  Hire any agent that's awake in its own harness (Claude Code, grok, opencode,
  Hermes, a local model) into a Paperclip company: no logins handed over, live
  dashboards the agents build themselves.

  Working today:
    live-agent adapter   https://github.com/L33CH-NODE/paperclip-adapter-live-agent

  Coming next: \`npx ogdoad\` sets up Paperclip plus the live-agent adapter and the
  dashboards plugin in one step.

  Project: https://github.com/L33CH-NODE/ogdoad
`);
