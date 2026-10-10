// The app server's live stream: "changed" when anything in Money or Flow moves (from this page, another
// tab, or a bank statement landing), "locked" when the vault closes. One connection for the whole page,
// opened while something listens and closed when nothing does.

import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "./api";

type Listener = (area: string) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function open(): void {
  if (source) return;
  source = new EventSource("/ogdoad/stream");
  source.addEventListener("changed", (e) => {
    const { area } = JSON.parse((e as MessageEvent).data) as { area: string };
    for (const l of listeners) l(area);
  });
  source.addEventListener("locked", () => {
    close();
    window.dispatchEvent(new Event("ogdoad:locked"));
  });
}

function close(): void {
  source?.close();
  source = null;
}

/** Run fn whenever something changes (optionally only in some areas: "money", "flow", "practice"). */
export function useChanged(fn: Listener, areas?: string[]): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (area) => (!areas || areas.includes(area)) && ref.current(area);
    listeners.add(l);
    open();
    return () => {
      listeners.delete(l);
      if (!listeners.size) close();
    };
  }, []);
}

/** Load JSON and keep it current: it reloads itself when the stream says something changed. */
export function useLive<T>(path: string | null, areas?: string[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api.get<T>(path).then((d) => alive && (setData(d), setError(null)), (e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [path, n]);
  useChanged(reload, areas);
  return { data, error, reload };
}
