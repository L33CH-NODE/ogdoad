// Palette checker for Ogdoad themes: oklch in, then for each colour the sRGB hex, whether it fits sRGB,
// WCAG contrast against a surface, and OKLab distance between neighbouring series colours under
// normal vision and simulated protanopia, deuteranopia and tritanopia (Machado et al. 2009, severity 1).
// Usage: node palette-check.mjs <palette.json>
//   palette.json = { "surface": "oklch(...)", "text": {...}, "series": ["oklch(...)", ...], "status": {...} }
import { readFileSync } from "node:fs";

const parse = (s) => {
  const m = s.match(/oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/);
  if (!m) throw new Error(`not oklch: ${s}`);
  return { L: m[2] ? +m[1] / 100 : +m[1], C: +m[3], h: +m[4] };
};
const toLab = ({ L, C, h }) => ({ L, a: C * Math.cos((h * Math.PI) / 180), b: C * Math.sin((h * Math.PI) / 180) });
const labToLinear = ({ L, a, b }) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};
const linearToLab = ([r, g, bl]) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363281012 * g + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
};
const clip = (rgb) => rgb.map((v) => Math.min(1, Math.max(0, v)));
const inGamut = (rgb) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);
const encode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const hex = (rgb) => "#" + clip(rgb).map((v) => Math.round(encode(v) * 255).toString(16).padStart(2, "0")).join("");
const luminance = (rgb) => { const [r, g, b] = clip(rgb); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (x, y) => { const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const simulate = (rgb, M) => clip(M.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]));
const dist = (p, q) => 100 * Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
// Largest chroma at this L and h that still fits sRGB, for colours that overflow.
const maxChroma = ({ L, h }) => { let lo = 0, hi = 0.4; for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; inGamut(labToLinear(toLab({ L, C: mid, h }))) ? (lo = mid) : (hi = mid); } return lo; };

const palette = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const [mode, p] of Object.entries(palette)) {
  const surface = clip(labToLinear(toLab(parse(p.surface))));
  console.log(`\n== ${mode}  surface ${p.surface} ${hex(surface)}`);
  const row = (name, s, minContrast) => {
    const c = parse(s); const lin = labToLinear(toLab(c)); const ok = inGamut(lin);
    const cr = contrast(lin, surface);
    console.log(`${name.padEnd(22)} ${hex(lin)}  contrast ${cr.toFixed(2).padStart(5)}${cr < minContrast ? " LOW" : "    "}  ${ok ? "in sRGB" : `OUT of sRGB (max C ${maxChroma(c).toFixed(3)})`}`);
    return lin;
  };
  for (const [k, v] of Object.entries(p.text ?? {})) row(k, v, 4.5);
  for (const [k, v] of Object.entries(p.status ?? {})) row(k, v, 3);
  for (const [label, fg, bg] of p.pairs ?? []) {
    const cr = contrast(labToLinear(toLab(parse(fg))), labToLinear(toLab(parse(bg))));
    console.log(`${label.padEnd(22)} pair contrast ${cr.toFixed(2).padStart(5)}${cr < 4.5 ? " LOW" : ""}`);
  }
  const series = (p.series ?? []).map((s, i) => row(`chart-${i + 1}`, s, 3));
  if (series.length > 1) {
    console.log("neighbour distance (OKLab x100; under 10 is hard to tell apart):");
    for (const [label, M] of [["normal", null], ...Object.entries(CVD)]) {
      const labs = series.map((rgb) => linearToLab(M ? simulate(clip(rgb), M) : clip(rgb)));
      const d = labs.slice(1).map((l, i) => dist(labs[i], l));
      const worst = Math.min(...d);
      console.log(`  ${label.padEnd(7)} ${d.map((x) => x.toFixed(0).padStart(3)).join(" ")}   worst ${worst.toFixed(1)}${worst < 10 ? "  <- check" : ""}`);
    }
  }
}
