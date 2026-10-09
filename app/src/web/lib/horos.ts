// Horos, live: the team's state and the operator's notification feed, through the app server
// (which holds Horos's token). One event stream feeds both.

import { useEffect, useState } from "react";

import { api, type HireInfo, type Notification } from "./api";

type Listener = (event: string, data: any) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureStream(): void {
  if (source) return;
  source = new EventSource("/horos/v1/events");
  for (const event of ["snapshot", "status_changed", "hire_spawned", "notification", "hire_restored"]) {
    source.addEventListener(event, (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      for (const l of listeners) l(event, data);
    });
  }
  source.onerror = () => {
    // The browser reconnects by itself; nothing to do.
  };
}

export function useHoros(event: string | string[], fn: (data: any, event: string) => void): void {
  useEffect(() => {
    ensureStream();
    const names = Array.isArray(event) ? event : [event];
    const l: Listener = (e, d) => names.includes(e) && fn(d, e);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

export function useTeam(): HireInfo[] {
  const [team, setTeam] = useState<HireInfo[]>([]);
  useEffect(() => {
    api.get<HireInfo[]>("/horos/v1/hires").then(setTeam, () => setTeam([]));
  }, []);
  useHoros(["snapshot", "status_changed", "hire_spawned", "hire_restored"], (data, event) => {
    if (event === "snapshot") return setTeam(data);
    if (event === "status_changed") return setTeam((t) => t.map((h) => (h.id === data.id ? { ...h, state: data.state } : h)));
    api.get<HireInfo[]>("/horos/v1/hires").then(setTeam, () => {});
  });
  return team;
}

export function useNotifications(): { items: Notification[]; unread: number; markRead: () => void } {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    api.get<{ items: Notification[]; unread: number }>("/horos/v1/notifications?limit=50").then((r) => {
      setItems(r.items.filter((n) => n.level !== "pulse").reverse());
      setUnread(r.unread);
    }, () => {});
  }, []);
  useHoros("notification", (n: Notification) => {
    if (n.level === "pulse") return;
    setItems((cur) => [n, ...cur].slice(0, 50));
    setUnread((u) => u + 1);
  });
  return {
    items,
    unread,
    markRead: () => {
      setUnread(0);
      api.post("/horos/v1/notifications/read", {}).catch(() => {});
    },
  };
}
