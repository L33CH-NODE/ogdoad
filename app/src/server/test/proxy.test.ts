// The proxy in front of Nous and Horos: what of the browser's request reaches them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { proxyHttp } from "../proxy.js";

/** An upstream that remembers what it was sent, and a front that proxies everything to it, as the app does Nous. */
async function pair() {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.end("{}");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const up = { base: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, strip: "/nous", headers: () => ({ authorization: "Bearer the-operator-token" }) };
  const front = createServer((req, res) => proxyHttp(up, req, res));
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const port = (front.address() as AddressInfo).port;
  return { seen, port, close: () => (front.close(), upstream.close()) };
}

const headers = { cookie: "ogdoad_session=the-vault-session", origin: "http://127.0.0.1:3101", "content-type": "application/json" };

test("the operator's session cookie never reaches Nous; the operator's token is added on the way", async () => {
  const p = await pair();
  try {
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: p.port, path: "/nous/v1/companies/co-1/tasks?limit=5", method: "GET", headers }, (res) => res.resume().on("end", resolve));
      r.on("error", reject).end();
    });
    assert.equal(p.seen.length, 1);
    const [{ url, headers: h }] = p.seen;
    assert.equal(url, "/v1/companies/co-1/tasks?limit=5", "the /nous prefix is the app's; Nous sees its own path");
    assert.equal(h.cookie, undefined);
    assert.equal(h.authorization, "Bearer the-operator-token");
    assert.match(String(h.origin), /^http:\/\/127\.0\.0\.1:\d+$/, "the origin is the upstream's own");
    assert.notEqual(h.origin, headers.origin);
  } finally {
    p.close();
  }
});
