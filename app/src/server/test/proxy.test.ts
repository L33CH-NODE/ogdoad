// The proxy in front of the engine and Horos: what of the browser's request reaches them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

import { proxyHttp, proxyUpgrade } from "../proxy.js";

/** An upstream that remembers the headers it was sent, and a front that proxies everything to it. */
async function pair() {
  const seen: IncomingHttpHeaders[] = [];
  const upstream = createServer((req, res) => {
    seen.push(req.headers);
    res.end("{}");
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const up = { base: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` };
  const front = createServer((req, res) => proxyHttp(up, req, res));
  front.on("upgrade", (req, socket, head) => proxyUpgrade(up, req, socket as any, head));
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const port = (front.address() as AddressInfo).port;
  return { seen, port, close: () => (front.close(), upstream.close()) };
}

const headers = { cookie: "ogdoad_session=the-vault-session", origin: "http://127.0.0.1:3101", "content-type": "application/json" };

test("the operator's session cookie never reaches the engine or Horos: not on a request, not on a socket", async () => {
  const p = await pair();
  try {
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: p.port, path: "/api/companies", method: "GET", headers }, (res) => res.resume().on("end", resolve));
      r.on("error", reject).end();
    });
    await new Promise<void>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: p.port, path: "/api/companies/x/events/ws", headers: { ...headers, connection: "Upgrade", upgrade: "websocket" } });
      r.on("upgrade", (_res, socket) => (socket.destroy(), resolve())).on("error", reject).end();
    });
    assert.equal(p.seen.length, 2);
    for (const h of p.seen) {
      assert.equal(h.cookie, undefined);
      assert.match(String(h.origin), /^http:\/\/127\.0\.0\.1:\d+$/, "the origin is the upstream's own");
      assert.notEqual(h.origin, headers.origin);
    }
  } finally {
    p.close();
  }
});
