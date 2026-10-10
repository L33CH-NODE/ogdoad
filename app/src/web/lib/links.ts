// What the stand-ins on a page stand for, asked of the app server (the map never leaves it otherwise).
// Answers are kept for the page's life, so a thread that refreshes doesn't ask again.

import { useEffect, useMemo, useState } from "react";

import { TOKEN_SOURCE } from "../../shared/standins";
import { api, type Links } from "./api";

const known: Links = {};
const asked = new Set<string>();
// Locked: forget them, like everything else the page held.
window.addEventListener("ogdoad:locked", () => {
  for (const k of Object.keys(known)) delete known[k];
  asked.clear();
});

/** The stand-ins in these texts, with what each stands for (once the server has answered). */
export function useLinks(texts: Array<string | null | undefined>): Links {
  const tokens = useMemo(() => {
    const found = new Set<string>();
    const re = new RegExp(TOKEN_SOURCE, "g");
    for (const t of texts) for (const m of (t ?? "").matchAll(re)) found.add(m[0]);
    return [...found].sort();
  }, [texts.join("\u0000")]);
  const [, bump] = useState(0);
  useEffect(() => {
    const missing = tokens.filter((t) => !asked.has(t));
    if (!missing.length) return;
    for (const t of missing) asked.add(t);
    api.post<Links>("/ogdoad/membrane/links", { tokens: missing }).then((r) => {
      Object.assign(known, r);
      bump((n) => n + 1);
    }, () => {
      for (const t of missing) asked.delete(t);
    });
  }, [tokens.join(" ")]);
  return Object.fromEntries(tokens.filter((t) => known[t]).map((t) => [t, known[t]]));
}
