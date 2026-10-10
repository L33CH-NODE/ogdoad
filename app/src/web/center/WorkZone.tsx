// V. Work: today's shifts on a timeline with a now-line. Shifts arrive with the calendar (roadmap 1b);
// until then the day is drawn honestly empty, and the now-line still keeps time.

import { useEffect, useState } from "react";

import { useZoom, Zone } from "./ControlCenter";

const START = 7;
const END = 19;

export function WorkZone() {
  const open = useZoom() === "work";
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const hours = now.getHours() + now.getMinutes() / 60;
  const x = Math.min(100, Math.max(0, ((hours - START) / (END - START)) * 100));
  const clock = now.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
  const day = now.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });
  return (
    <Zone id="work" chip={<span className="chip quiet">{clock}</span>}>
      <div className="timeline" aria-label={`Today, ${day}. No shifts yet.`}>
        {Array.from({ length: END - START + 1 }, (_, i) => <span key={i} className="tick" style={{ left: `${(i / (END - START)) * 100}%` }} />)}
        <span className="empty-day">No shifts on the calendar yet</span>
        {hours >= START && hours <= END ? <span className="nowline" style={{ left: `${x}%` }} /> : null}
      </div>
      <div className="timeline-hours mono">{[7, 10, 13, 16, 19].map((h) => <span key={h}>{h > 12 ? h - 12 : h}{h >= 12 ? "pm" : "am"}</span>)}</div>
      {open ? (
        <div className="stack" style={{ gap: 8, maxWidth: 640 }}>
          <strong>{day}</strong>
          <p className="muted" style={{ margin: 0 }}>
            Shifts, shift notes and your calendar come next: your own CalDAV calendar by default, or Google if you choose. Each shift flows into its invoice, and a shift without its note nags gently once it's over. Shift notes stay on this machine.
          </p>
        </div>
      ) : null}
    </Zone>
  );
}
