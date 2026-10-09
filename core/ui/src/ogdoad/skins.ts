// Ogdoad skins: whole-app colour, type and finish presets layered over Paperclip's design tokens.
// A skin is a `data-skin` attribute on <html>; skins.css keys every override off it, so switching is
// one attribute write with no reload. index.html applies the stored skin before first paint.
// To add a skin: add an entry here, a `:root[data-skin="<id>"]` block (plus `.dark`) in skins.css,
// and the same id to the allow-list in index.html's boot script.

export const SKIN_STORAGE_KEY = "ogdoad.skin";

export interface Skin {
  id: string;
  name: string;
  description: string;
  /** Browser chrome colour (meta theme-color) for light and dark. */
  themeColor: { light: string; dark: string };
}

export const SKINS: readonly Skin[] = [
  {
    id: "ogdoad",
    name: "Ogdoad",
    description: "Clean and corporate. The default.",
    themeColor: { light: "#fafafc", dark: "#0f0f15" },
  },
  {
    id: "cyberpunk-uv",
    name: "Cyberpunk Ultraviolet",
    description: "Neon ultraviolet on violet-black.",
    themeColor: { light: "#f8f5fd", dark: "#080612" },
  },
  {
    id: "paperclip",
    name: "Paperclip Classic",
    description: "Upstream Paperclip's grayscale.",
    themeColor: { light: "#ffffff", dark: "#18181b" },
  },
];

export const DEFAULT_SKIN_ID = SKINS[0].id;

export function findSkin(id: string | null | undefined): Skin {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0];
}

export function readStoredSkinId(): string {
  try {
    return findSkin(window.localStorage.getItem(SKIN_STORAGE_KEY)).id;
  } catch {
    return DEFAULT_SKIN_ID;
  }
}

/** Apply a skin to the document. Light/dark stays owned by ThemeContext; this only picks the palette. */
export function applySkin(id: string): void {
  if (typeof document === "undefined") return;
  const skin = findSkin(id);
  const root = document.documentElement;
  root.dataset.skin = skin.id;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta instanceof HTMLMetaElement) {
    meta.setAttribute("content", root.classList.contains("dark") ? skin.themeColor.dark : skin.themeColor.light);
  }
}

export function storeSkin(id: string): void {
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, findSkin(id).id);
  } catch {
    // Private windows and locked-down profiles: the skin still applies for this session.
  }
}
