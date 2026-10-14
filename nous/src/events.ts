// The live stream: one feed of changes, spoken natively as Server-Sent Events, and in the old engine's
// shape over the old WebSocket for the translator. Each listener hears its own company only.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer } from "ws";

import type { Change, Engine } from "./engine.js";

/** A change as the old engine announced it. */
export function compatEvent(ch: Change): { type: string; payload: Record<string, unknown> } | null {
  switch (ch.kind) {
    case "task":
    case "message":
      return {
        type: "activity.logged",
        payload: {
          actorType: ch.by.kind === "member" ? "agent" : "user",
          actorId: ch.by.kind === "member" ? ch.by.memberId : "operator",
          action: ch.kind === "message" ? "issue.comment_added" : `issue.${ch.action}`,
          entityType: "issue",
          entityId: ch.taskId,
          projectId: ch.roomId,
          details: { projectId: ch.roomId },
        },
      };
    case "member":
      return { type: "agent.status", payload: { agentId: ch.memberId, status: ch.status } };
    case "approval":
      return { type: "activity.logged", payload: { actorType: "user", actorId: "operator", action: `approval.${ch.status}`, entityType: "approval", entityId: ch.approvalId, details: {} } };
    case "run":
      // Better than the old engine: a run's every status names its task, so a room sees work start.
      return { type: "heartbeat.run.status", payload: { runId: ch.runId, agentId: ch.memberId, issueId: ch.taskId, status: ch.status } };
  }
}

/** GET /v1/companies/:co/events: changes as they happen, until the client goes. */
export function streamChanges(engine: Engine, companyId: string, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": nous\n\n");
  const on = (ch: Change) => {
    if (ch.companyId !== companyId) return;
    const { by: _by, ...rest } = ch as Change & { by?: unknown };
    res.write(`event: ${ch.kind}\ndata: ${JSON.stringify(rest)}\n\n`);
  };
  engine.changes.on("change", on);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    engine.changes.off("change", on);
  });
}

const wss = new WebSocketServer({ noServer: true });

/** The old engine's socket, /api/companies/:co/events/ws, for the app's rooms until they move to /v1. */
export function compatSocket(engine: Engine, companyId: string, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const on = (ch: Change) => {
      if (ch.companyId !== companyId) return;
      const e = compatEvent(ch);
      if (e) ws.send(JSON.stringify(e));
    };
    engine.changes.on("change", on);
    ws.on("close", () => engine.changes.off("change", on));
    ws.on("error", () => engine.changes.off("change", on));
  });
}
