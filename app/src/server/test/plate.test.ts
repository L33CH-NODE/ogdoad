// The recovery plate: every word fits, the plate reads back as exactly its phrase, and the STL is a
// closed, well-formed solid a slicer will take. Made-up phrases only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import { ADVANCE, GLYPH_H, GLYPH_W, glyph, layoutPlate, plateEntries, plateStl, PLATE, readGlyph, type PlateLayout } from "../../shared/plate.js";

/** Read a plate back from its raised dots alone, the way an eye would. */
function readPlate(layout: PlateLayout): string[] {
  const dot = PLATE.pitch;
  const raised = (x: number, y: number) => layout.rects.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
  return layout.texts.map(({ x, y, text }) =>
    [...text].map((_, i) => {
      const rows: string[] = [];
      for (let r = 0; r < GLYPH_H; r++) {
        let row = "";
        for (let c = 0; c < ADVANCE; c++) row += raised(x + (i * ADVANCE + c + 0.5) * dot, y + (r + 0.5) * dot) ? "#" : ".";
        assert.equal(row[GLYPH_W], ".", "letters never run into each other");
        rows.push(row.slice(0, GLYPH_W));
      }
      return readGlyph(rows) ?? "?";
    }).join(""),
  );
}

test("the font covers every letter and digit, and no two characters look alike", () => {
  const chars = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- "];
  const seen = new Set<string>();
  for (const ch of chars) {
    const g = glyph(ch);
    assert.equal(g.length, GLYPH_H);
    assert.ok(g.every((row) => row.length === GLYPH_W && /^[#.]+$/.test(row)));
    assert.ok(!seen.has(g.join("")), `${ch} is unique`);
    seen.add(g.join(""));
  }
});

test("every word in the English list fits a column", () => {
  assert.equal(wordlist.length, 2048);
  for (const w of wordlist) assert.match(w, /^[a-z]{3,8}$/);
});

test("a plate reads back as exactly its phrase, in order", () => {
  for (let i = 0; i < 5; i++) {
    const words = generateMnemonic(wordlist, 256).split(" ");
    const layout = layoutPlate(words, { date: "2026-10-10" });
    const read = readPlate(layout);
    assert.equal(read[0], "OGDOAD RECOVERY");
    assert.equal(read[1], "2026-10-10");
    assert.deepEqual(read.slice(2), plateEntries(words));
    assert.deepEqual(read.slice(2).map((l) => l.slice(3).toLowerCase()), words);
  }
});

test("the longest words fit inside the plate, clear of its edges", () => {
  const longest = wordlist.filter((w) => w.length === 8).slice(0, 24);
  const layout = layoutPlate(longest);
  for (const r of layout.rects) {
    assert.ok(r.x >= PLATE.margin - 1e-9 && r.x + r.w <= layout.width - PLATE.margin + 1e-9, "inside the margins across");
    assert.ok(r.y >= PLATE.margin - 1e-9 && r.y + r.h <= layout.height - PLATE.margin + 1e-9, "inside the margins down");
  }
  assert.ok(layout.width < 150 && layout.height < 90, `fits a small printer bed (${layout.width.toFixed(1)} x ${layout.height.toFixed(1)} mm)`);
});

test("only a 24-word phrase of real-looking words makes a plate", () => {
  assert.throws(() => layoutPlate(["abandon"]));
  assert.throws(() => layoutPlate(Array(24).fill("abc1")));
});

test("the STL is well formed and closed: every edge is shared by exactly two faces, facing apart", () => {
  const stl = plateStl(layoutPlate(generateMnemonic(wordlist, 256).split(" "), { date: "2026-10-10" }));
  const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  const count = view.getUint32(80, true);
  assert.equal(stl.byteLength, 84 + 50 * count);
  const key = (at: number) => `${view.getFloat32(at, true)},${view.getFloat32(at + 4, true)},${view.getFloat32(at + 8, true)}`;
  const edges = new Map<string, number>();
  let maxZ = 0;
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50;
    const n = [0, 4, 8].map((o) => view.getFloat32(base + o, true));
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-4, "unit normals");
    const v = [key(base + 12), key(base + 24), key(base + 36)];
    for (let i = 0; i < 3; i++) {
      maxZ = Math.max(maxZ, view.getFloat32(base + 12 + i * 12 + 8, true));
      const a = v[i], b = v[(i + 1) % 3];
      edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1);
    }
  }
  for (const [edge, n] of edges) {
    const [a, b] = edge.split(">");
    assert.equal(edges.get(`${b}>${a}`) ?? 0, n, "each edge is met once each way");
  }
  assert.ok(Math.abs(maxZ - (PLATE.thickness + PLATE.relief)) < 1e-4);
});
