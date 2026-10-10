// The Ogdoad server's own live feed (a WebSocket, passed through the app server): every comment, task
// change and agent run as it happens. One connection per page, opened while something listens, with
// a quiet reconnect if the server restarts.

import { useEffect, useRef } from "react";

export interface EngineEvent { type: string; payload: Record<string, unknown> }
type Listener = (e: EngineEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let company: string | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;

function connect(): void {
  if (socket || !company || !listeners.size) return;
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/companies/${encodeURIComponent(company)}/events/ws`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    return schedule();
  }
  socket = ws;
  ws.onopen = () => (attempt = 0);
  ws.onmessage = (m) => {
    try {
      const e = JSON.parse(String(m.data)) as EngineEvent;
      if (e && typeof e.type === "string") for (const l of listeners) l({ type: e.type, payload: e.payload ?? {} });
    } catch {
      // Not ours to read.
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    schedule();
  };
}

function schedule(): void {
  if (retry || !listeners.size) return;
  const wait = Math.min(30_000, 1000 * 2 ** attempt++);
  retry = setTimeout(() => {
    retry = null;
    connect();
  }, wait);
}

function disconnect(): void {
  if (retry) clearTimeout(retry);
  retry = null;
  const ws = socket;
  socket = null;
  ws?.close();
}

/** Hear the Ogdoad server's live events for a company while the component is mounted. */
export function useEngineEvents(companyId: string | null | undefined, fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!companyId) return;
    const l: Listener = (e) => ref.current(e);
    if (company !== companyId) {
      disconnect();
      company = companyId;
    }
    listeners.add(l);
    connect();
    return () => {
      listeners.delete(l);
      if (!listeners.size) disconnect();
    };
  }, [companyId]);
}
