// The control center: one surface, eight zones tiled edge to edge with seams between them. A zone opens
// in place (it grows over the others) and Esc puts it back. The address follows the zoom, so links,
// the back button and a reload all land where you were: /money/invoices/:id is Money, open, on that
// invoice.

import { useEffect, type ReactNode } from "react";

import { Icon } from "../components/icons";
import { navigate, usePath } from "../lib/router";
import { ArtifactsZone } from "./ArtifactsZone";
import { CommandLine } from "./CommandLine";
import { CenterProvider } from "./data";
import { DashboardsZone } from "./DashboardsZone";
import { FlowZone } from "./FlowZone";
import { MoneyZone } from "./MoneyZone";
import { Pulse } from "./Pulse";
import { SettingsRoom } from "./SettingsRoom";
import { SignalsZone } from "./SignalsZone";
import { TeamZone } from "./TeamZone";
import { WorkZone } from "./WorkZone";

export const ZONES = {
  pulse: { n: "I", name: "Pulse" },
  flow: { n: "II", name: "Flow" },
  team: { n: "III", name: "Team" },
  money: { n: "IV", name: "Money" },
  work: { n: "V", name: "Work" },
  artifacts: { n: "VI", name: "Artifacts" },
  signals: { n: "VII", name: "Signals" },
  dashboards: { n: "VIII", name: "Dashboards" },
} as const;
export type ZoneId = keyof typeof ZONES;
type Room = Exclude<ZoneId, "pulse"> | "settings";
const ROOMS: Room[] = ["flow", "team", "money", "work", "artifacts", "signals", "dashboards", "settings"];

/** Which zone the address opens, if any. */
export function zoomOf(path: string): Room | null {
  const first = path.split("/").filter(Boolean)[0] as Room | undefined;
  return first && ROOMS.includes(first) ? first : null;
}

export function useZoom(): Room | null {
  return zoomOf(usePath());
}

export function Zone({ id, chip, children, className = "" }: { id: Exclude<ZoneId, "pulse">; chip?: ReactNode; children: ReactNode; className?: string }) {
  const open = useZoom() === id;
  const z = ZONES[id];
  return (
    <section className={`zone z-${id}${open ? " open" : ""} ${className}`.trim()} aria-label={z.name} style={{ gridArea: id }}>
      <header className="zhead">
        <span className="znum" aria-hidden="true">{z.n}</span>
        <h2 className="zname">{z.name}</h2>
        {chip}
        <button className="zbtn" onClick={() => navigate(open ? "/" : `/${id}`)} aria-label={open ? `Close ${z.name}` : `Open ${z.name}`} title={open ? "Back to everything (Esc)" : `Open ${z.name}`}>
          <Icon name={open ? "shrink" : "expand"} size={14} />
        </button>
      </header>
      <div className="zbody">{children}</div>
    </section>
  );
}

/** Typing in a field shouldn't trigger the surface's single-key shortcuts. */
export function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

export function ControlCenter() {
  const zoom = useZoom();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        window.dispatchEvent(new Event("ogdoad:command"));
        return;
      }
      if (e.key === "Escape" && zoom && !typing(e) && !document.querySelector("[data-modal]")) navigate("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  return (
    <CenterProvider>
      <div className="cc" data-zoom={zoom ?? ""}>
        <Pulse />
        <FlowZone />
        <TeamZone />
        <MoneyZone />
        <WorkZone />
        <ArtifactsZone />
        <SignalsZone />
        <DashboardsZone />
        {zoom === "settings" ? <SettingsRoom /> : null}
        <CommandLine />
      </div>
    </CenterProvider>
  );
}
