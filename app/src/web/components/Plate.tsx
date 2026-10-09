// The recovery plate, offered while the phrase is on screen: a preview of exactly what prints, and the
// STL made right here in the browser. The file is the phrase, so the warnings sit next to the button.

import { useMemo, useState } from "react";

import { layoutPlate, markPolygon, PLATE, plateStl } from "../../shared/plate";

export function PlateOffer({ words }: { words: string[] }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const layout = useMemo(() => layoutPlate(words, { date: new Date().toLocaleDateString("en-CA") }), [words]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([plateStl(layout)], { type: "model/stl" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "ogdoad-recovery-plate.stl";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setSaved(true);
  };

  if (!open) {
    return <button type="button" className="btn link" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>Also 3D-print it on a plate</button>;
  }
  const m = layout.mark;
  return (
    <div className="stack enter" style={{ gap: 12 }}>
      <svg className="plate-preview" viewBox={`-1 -1 ${layout.width + 2} ${layout.height + 2}`} role="img" aria-label="Preview of the recovery plate">
        <polygon points={layout.outline.map((p) => p.join(",")).join(" ")} />
        {layout.rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} />)}
        <polygon className="plate-mark" points={markPolygon(m.cx, m.cy, m.r).map((p) => p.join(",")).join(" ")} />
      </svg>
      <p className="muted" style={{ fontSize: 13 }}>
        {Math.round(layout.width)} × {Math.round(layout.height)} mm, {PLATE.thickness} mm thick, letters raised {PLATE.relief} mm. For words that stand out, pause at {PLATE.thickness} mm and swap to a contrasting filament.
      </p>
      <div className="notice warn" style={{ fontSize: 13 }}>
        <span>
          <strong>This file is your phrase.</strong> Print it from this machine over USB, an SD card or your home network, never through a printer's cloud service. Once it's printed, delete the file and your slicer's copy of it, and empty the Recycle Bin.
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Printed plastic softens in heat (PLA at about 60 °C) and burns, so PETG or ASA lasts longer. Keep the paper copy too, somewhere apart.</p>
      <div className="row">
        <button type="button" className="btn" onClick={download}>Download the plate (.stl)</button>
        {saved ? <span className="muted" role="status" style={{ fontSize: 13 }}>Saved to your downloads. Delete it once it's printed.</span> : null}
      </div>
    </div>
  );
}
