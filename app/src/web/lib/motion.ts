// Motion for panels: numbers that count to their value, a flash when a price ticks, and respect for
// "reduce motion" (then everything simply arrives). The CSS side (bars rising, lines drawing, panels
// settling in) lives in styles/motion.css and keys off the same setting.

import { useEffect, useRef, useState } from "react";

const query = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(query).matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Fast out, long settle: the curve the panels use everywhere. */
export const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** A number that counts from where it was to where it's going (from zero the first time). */
export function useCountUp(target: number, duration = 900): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? target : 0);
  const from = useRef(reduced ? target : 0);
  useEffect(() => {
    if (reduced || !Number.isFinite(target)) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = a + (target - a) * easeOutExpo(t);
      from.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, reduced]);
  return shown;
}

/** "up" or "down" for a moment after a value changes, then null again. */
export function useFlash(value: number | null | undefined, ms = 900): "up" | "down" | null {
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const last = useRef(value);
  useEffect(() => {
    const before = last.current;
    last.current = value;
    if (typeof value !== "number" || typeof before !== "number" || value === before) return;
    setFlash(value > before ? "up" : "down");
    const t = setTimeout(() => setFlash(null), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return flash;
}
