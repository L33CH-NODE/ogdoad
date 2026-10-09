import { useEffect, useState } from "react";
import { Palette } from "lucide-react";

import { cn } from "@/lib/utils";
import { SKINS, applySkin, findSkin, readStoredSkinId, storeSkin } from "./skins";

interface SkinPickerProps {
  className?: string;
  /** Mirrors ThemeToggle: `compact-menu-action` (default) or the taller `menu-action` row. */
  variant?: "compact-menu-action" | "menu-action";
}

/**
 * Account-menu row that cycles through the installed skins. Clicking applies the next skin
 * immediately and keeps the menu open, so you can flick through them and see each one live.
 * Matches ThemeToggle's `compact-menu-action` row so the two sit together.
 */
export function SkinPicker({ className, variant = "compact-menu-action" }: SkinPickerProps) {
  const [skinId, setSkinId] = useState(readStoredSkinId);
  const skin = findSkin(skinId);

  useEffect(() => {
    applySkin(skinId);
    storeSkin(skinId);
  }, [skinId]);

  function handleClick() {
    const index = SKINS.findIndex((s) => s.id === skinId);
    setSkinId(SKINS[(index + 1) % SKINS.length].id);
  }

  const label = `Skin: ${skin.name}`;
  const ariaLabel = `${label}. Switch to the next skin.`;

  if (variant === "menu-action") {
    return (
      <button
        type="button"
        className={cn("flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60", className)}
        onClick={handleClick}
        aria-label={ariaLabel}
      >
        <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Palette className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block text-xs text-muted-foreground">{skin.description} Click for the next skin.</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent",
        className,
      )}
      onClick={handleClick}
      aria-label={ariaLabel}
      title={skin.description}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Palette className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
