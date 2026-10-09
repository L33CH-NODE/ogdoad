// The recovery plate: the 24-word phrase laid out on a plate to 3D print, as a binary STL. It runs in
// the browser, from the phrase already on screen, so the phrase never goes back to the server and no
// copy is kept anywhere but the file the operator downloads. No Node imports: the UI bundles this.
//
// Words are raised in a 5x7 dot font, uppercase (the phrase is case-insensitive), because blocky
// letters stay readable when printed small and never depend on a font file being present. The plate
// has cut corners, like the octagram's squares, and carries the octagram as its mark.

export const PLATE = {
  /** One dot of the font, in mm. 0.6 prints cleanly with a 0.4 mm nozzle. */
  pitch: 0.6,
  thickness: 2.4,
  /** How far the letters stand up from the plate. */
  relief: 0.8,
  margin: 7,
  corner: 6,
  gutter: 5,
  /** Space between lines, in dots. */
  lineGap: 4,
  columns: 3,
} as const;

// prettier-ignore
const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** A character and the space after it, in dots. */
export const ADVANCE = 6;

export function glyph(ch: string): string[] {
  const g = FONT[ch];
  if (!g) throw new Error(`The plate font has no "${ch}".`);
  return g;
}

/** Which character a 5x7 pattern is (for checking a plate reads back as its phrase). */
export function readGlyph(rows: string[]): string | null {
  const key = rows.join("");
  for (const [ch, g] of Object.entries(FONT)) if (g.join("") === key) return ch;
  return null;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface PlateLayout {
  width: number;
  height: number;
  /** The plate's outline: a rectangle with cut corners. y grows downward, like a page. */
  outline: Array<[number, number]>;
  /** The raised dots, merged into rectangles. */
  rects: Rect[];
  /** Each line of text and where its first dot sits, so the plate can be read back. */
  texts: Array<{ x: number; y: number; text: string }>;
  /** The octagram mark: centre and radius. */
  mark: { cx: number; cy: number; r: number };
}

/** "01 ABANDON" ... "24 ART": the lines the plate carries, in the order they're read. */
export function plateEntries(words: string[]): string[] {
  return words.map((w, i) => `${String(i + 1).padStart(2, "0")} ${w.toUpperCase()}`);
}

/** Lay the phrase out: a header with the mark, then the words in columns, read down each column. */
export function layoutPlate(words: string[], opts: { title?: string; date?: string } = {}): PlateLayout {
  if (words.length !== 24 || words.some((w) => !/^[a-z]{3,8}$/i.test(w))) throw new Error("The plate holds a 24-word phrase of 3 to 8 letters a word.");
  const P = PLATE;
  const dot = P.pitch;
  const entries = plateEntries(words);
  const perColumn = Math.ceil(entries.length / P.columns);
  const colChars = 2 + 1 + 8;
  const colW = (colChars * ADVANCE - 1) * dot;
  const lineH = (GLYPH_H + P.lineGap) * dot;
  const textH = GLYPH_H * dot;
  const width = 2 * P.margin + P.columns * colW + (P.columns - 1) * P.gutter;
  const headerH = Math.max(textH, 7);
  const height = 2 * P.margin + headerH + 5 + perColumn * lineH - P.lineGap * dot;

  const rects: Rect[] = [];
  const texts: PlateLayout["texts"] = [];
  const write = (text: string, x: number, y: number) => {
    texts.push({ x, y, text });
    [...text].forEach((ch, i) => rects.push(...glyphRects(glyph(ch), x + i * ADVANCE * dot, y, dot)));
  };

  const mark = { cx: P.margin + headerH / 2, cy: P.margin + headerH / 2, r: headerH / 2 };
  const headY = P.margin + (headerH - textH) / 2;
  write((opts.title ?? "OGDOAD RECOVERY").toUpperCase(), P.margin + headerH + 3, headY);
  if (opts.date) write(opts.date, width - P.margin - (opts.date.length * ADVANCE - 1) * dot, headY);

  const top = P.margin + headerH + 5;
  entries.forEach((entry, i) => {
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    write(entry, P.margin + col * (colW + P.gutter), top + row * lineH);
  });

  const c = P.corner;
  const outline: Array<[number, number]> = [[c, 0], [width - c, 0], [width, c], [width, height - c], [width - c, height], [c, height], [0, height - c], [0, c]];
  return { width, height, outline, rects, texts, mark };
}

/** A glyph's dots as rectangles: runs along each row, stacked where the same run repeats below. */
function glyphRects(rows: string[], x: number, y: number, dot: number): Rect[] {
  const runs: Array<{ c0: number; c1: number; r0: number; r1: number }> = [];
  rows.forEach((line, r) => {
    for (let c = 0; c < line.length; ) {
      if (line[c] !== "#") {
        c++;
        continue;
      }
      let e = c;
      while (line[e] === "#") e++;
      const above = runs.find((run) => run.c0 === c && run.c1 === e && run.r1 === r);
      if (above) above.r1 = r + 1;
      else runs.push({ c0: c, c1: e, r0: r, r1: r + 1 });
      c = e;
    }
  });
  return runs.map((run) => ({ x: x + run.c0 * dot, y: y + run.r0 * dot, w: (run.c1 - run.c0) * dot, h: (run.r1 - run.r0) * dot }));
}

/** The octagram as one filled shape: an eight-pointed star (two squares, one turned 45 degrees). */
export function markPolygon(cx: number, cy: number, r: number): Array<[number, number]> {
  // The inner corners of two overlapping squares sit at r * cos(45deg) / cos(22.5deg).
  const inner = (r * Math.SQRT1_2) / Math.cos(Math.PI / 8);
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : inner;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return pts;
}

// --- the STL -------------------------------------------------------------------------------------

type V3 = [number, number, number];

/**
 * The plate as a binary STL, in mm. The letters and mark sink a little into the plate, so every
 * slicer joins them into one solid; dots that only touch at a corner are widened a hair so they join
 * too.
 */
export function plateStl(layout: PlateLayout): Uint8Array<ArrayBuffer> {
  const P = PLATE;
  const tris: Array<[V3, V3, V3]> = [];
  const H = layout.height;
  // Page coordinates (y down) to print coordinates (y up), keeping polygons counter-clockwise.
  const flip = (pts: Array<[number, number]>) => pts.map(([x, y]) => [x, H - y] as [number, number]).reverse();

  prism(tris, flip(layout.outline), 0, P.thickness);
  const sink = 0.2;
  const grow = 0.04;
  for (const r of layout.rects) {
    const x0 = r.x - grow, x1 = r.x + r.w + grow;
    const y0 = H - (r.y + r.h) - grow, y1 = H - r.y + grow;
    prism(tris, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], P.thickness - sink, P.thickness + P.relief);
  }
  const m = layout.mark;
  prism(tris, flip(markPolygon(m.cx, m.cy, m.r)), P.thickness - sink, P.thickness + P.relief, [m.cx, H - m.cy]);

  const out = new Uint8Array(84 + tris.length * 50);
  const view = new DataView(out.buffer);
  const header = "Ogdoad recovery plate (binary STL, mm)";
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  view.setUint32(80, tris.length, true);
  let at = 84;
  for (const [a, b, c] of tris) {
    for (const v of [normal(a, b, c), a, b, c]) for (const n of v) (view.setFloat32(at, n, true), (at += 4));
    view.setUint16(at, 0, true);
    at += 2;
  }
  return out;
}

/**
 * Extrude a counter-clockwise polygon from z0 to z1. Convex outlines fan from their first corner;
 * the star fans from its centre (every point of it can see the centre).
 */
function prism(tris: Array<[V3, V3, V3]>, pts: Array<[number, number]>, z0: number, z1: number, centre?: [number, number]): void {
  const n = pts.length;
  const top = (p: [number, number]): V3 => [p[0], p[1], z1];
  const bot = (p: [number, number]): V3 => [p[0], p[1], z0];
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (centre) {
      tris.push([top(centre), top(a), top(b)]);
      tris.push([bot(centre), bot(b), bot(a)]);
    } else if (i > 0 && i < n - 1) {
      tris.push([top(pts[0]), top(a), top(b)]);
      tris.push([bot(pts[0]), bot(b), bot(a)]);
    }
    tris.push([bot(a), bot(b), top(b)]);
    tris.push([bot(a), top(b), top(a)]);
  }
}

function normal(a: V3, b: V3, c: V3): V3 {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(...n) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}
