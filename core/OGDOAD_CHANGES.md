# Ogdoad changes to Paperclip

`core/` is Paperclip v2026.1005.0 (commit 467125faf) imported as a snapshot. This file lists every change Ogdoad makes on top, so upstream fixes can be carried across with `git diff vA..vB | git apply --directory=core` and conflicts stay easy to reason about.

Keep changes small and in their own files where possible. Prefer new files plus a one-line hook into an existing file over edits spread through upstream code.

| Area | Files | Change |
|---|---|---|
| Import | everything | Snapshot of upstream v2026.1005.0. |
| Skins | `ui/src/ogdoad/skins.ts`, `ui/src/ogdoad/skins.css`, `ui/src/ogdoad/SkinPicker.tsx` (new) | Skin registry, token overrides keyed off `<html data-skin>`, and an account-menu picker. Skins: Ogdoad (default, corporate), Cyberpunk Ultraviolet, Paperclip Classic (upstream grayscale). |
| Skins | `ui/src/main.tsx` | One import of `ogdoad/skins.css` after `index.css`. |
| Skins | `ui/src/context/ThemeContext.tsx` | `applyTheme` asks the active skin for the browser chrome colour instead of hard-coded `#18181b` / `#ffffff`. |
| Skins | `ui/src/components/SidebarAccountMenu.tsx`, `SidebarAccountMenu.production.tsx` | `<SkinPicker />` under the theme toggle. |
| Branding | `ui/src/context/BreadcrumbContext.tsx` | Document title suffix "Ogdoad" instead of "Paperclip". |
| Branding + skins | `ui/index.html` | Title "Ogdoad"; the pre-paint boot script also applies the stored skin (`localStorage["ogdoad.skin"]`), so there is no flash of the wrong palette. |

## Runtime patches and settings (outside `core/`)

The pinned runtime (`runtime/`, paperclipai 2026.1005.0 from npm) gets these until our own core build runs it. `runtime/patches/apply.mjs` re-applies the patches after every `npm install` (postinstall); the settings live in the Ogdoad server's Horos roster entry.

| What | Where | Why |
|---|---|---|
| Patch: Postgres stops cleanly on Windows | `embedded-postgres` (top-level and `@paperclipai/db`'s copy) | Upstream stops Postgres on Windows with `taskkill /f /t`, so every shutdown forces crash recovery. The patch uses `pg_ctl stop -m fast` and keeps taskkill as the fallback. Carry the same fix into `core/` when it builds. |
| Setting: telemetry off | `PAPERCLIP_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1` | Ogdoad never phones home. Upstream sends anonymous usage events by default; where the endpoints are blocked, its shutdown also waited about two minutes on the telemetry flush. |
| Setting: git scans stop at the home folder | `GIT_CEILING_DIRECTORIES=<home>` | Workspaces live under the home folder. If that folder is itself a git repository, every workspace check scanned all of it and timed out. |
