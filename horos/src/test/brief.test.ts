// SOPHIA's brief teaches Nous's own API and the credentials each job carries, never the old engine's.

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderBrief } from "../sophia/brief.js";

const brief = renderBrief({
  companyName: "Sample Co", companyId: "co-1", agentId: "m-1", apiUrl: "http://127.0.0.1:3100",
  horosUrl: "http://127.0.0.1:3198", horosTokenFile: "horos.token", horosCli: "cli.js", trust: "balanced",
  mailbox: "http://127.0.0.1:3100/mailbox",
});

test("SOPHIA's brief speaks /v1 with the run's own token", () => {
  assert.match(brief, /Authorization: Bearer <NOUS_RUN_TOKEN>` on every request to `http:\/\/127\.0\.0\.1:3100\/v1\/\.\.\.`/);
  assert.match(brief, /POST \/v1\/tasks\/\{id\}\/messages/);
  assert.match(brief, /POST \/v1\/tasks\/\{id\}\/cards/);
  assert.match(brief, /"type": "hire_agent"/, "a hire is asked for through an approval");
  assert.match(brief, /"mailbox": "http:\/\/127\.0\.0\.1:3100\/mailbox"/, "and seated on Nous's mailbox");
});

test("nothing of the old engine is left in it", () => {
  for (const old of ["/api/", "PAPERCLIP_", "X-Paperclip", "agent-hires", "interactions", "comments"]) {
    assert.ok(!brief.includes(old), `still says ${old}`);
  }
});
