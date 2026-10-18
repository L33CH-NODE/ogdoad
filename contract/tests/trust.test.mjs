// Who the engine believes. The engine Ogdoad started on trusted anything on this machine as the
// operator: a hire's own shell could approve its own approval. Ogdoad's own engine asks for the
// operator's token.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ENGINE, freshCompany, ok } from "../client.mjs";

const bare = (method, path, body) =>
  fetch(`${ENGINE}${path}`, { method, headers: { "content-type": "application/json", origin: ENGINE }, body: body === undefined ? undefined : JSON.stringify(body) });

test("nothing on this machine is the operator without the operator's token", async () => {
  const co = await freshCompany("trust");
  const task = await ok("POST", `/api/companies/${co.id}/issues`, { title: "Guarded", status: "todo" });
  for (const [method, path, body] of [
    ["POST", "/api/companies", { name: "Sneaky" }],
    ["GET", `/api/companies/${co.id}/agents`],
    ["POST", `/api/companies/${co.id}/agents`, { name: "Self-hired", role: "general", adapterType: "live_agent", adapterConfig: {} }],
    ["POST", `/api/issues/${task.id}/comments`, { body: "Pretending to be the operator" }],
  ]) {
    const r = await bare(method, path, body);
    assert.equal(r.status, 401, `${method} ${path} without a token`);
  }
});
