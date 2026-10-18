// Nous's own live feed (Server-Sent Events, passed through the app server): every task change, message,
// member and run as it happens. One stream per page, opened while something listens; the browser
// reconnects by itself if Nous restarts.

import { useEffect, useRef } from "react";

/** A change as Nous announces it: its kind, and the ids it touched. */
export interface EngineEvent {
  type: "task" | "message" | "member" | "approval" | "run";
  taskId?: string; roomId?: string | null; messageId?: string; memberId?: string; approvalId?: string; runId?: string;
  action?: string; status?: string;
}
type Listener = (e: EngineEvent) => void;

const KINDS: EngineEvent["type"][] = ["task", "message", "member", "approval", "run"];
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let company: string | null = null;

function connect(): void {
  if (source || !company || !listeners.size) return;
  const es = new EventSource(`/nous/v1/companies/${encodeURIComponent(company)}/events`);
  source = es;
  for (const kind of KINDS) {
    es.addEventListener(kind, (m) => {
      try {
        const data = JSON.parse((m as MessageEvent).data) as Omit<EngineEvent, "type">;
        for (const l of listeners) l({ ...data, type: kind });
      } catch {
        // Not ours to read.
      }
    });
  }
}

function disconnect(): void {
  source?.close();
  source = null;
}

/** Hear Nous's live changes for a company while the component is mounted. */
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
