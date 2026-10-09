# Ogdoad roadmap

Ideas and decisions, newest at the bottom of each section. Specs live next to this file.

## The main draw: tiered information

Frontier intelligence without handing over the business.

- **Tier 0, local only.** Financial and client information is handled and stored by **local models** on the operator's machine.
- **The membrane.** Local models sanitise data before it moves up a tier: stand-ins for identities, aggregates instead of rows.
- **Tier 1, cloud-visible.** Only sanitised data, and only what the operator has chosen to share, ever reaches a cloud model. It appears in its own pane of the operator's UI, separate from any chat ("non-cross-chat"), so the operator can always see exactly what the cloud has seen.
- **Back down.** The cloud model's answers return through the membrane, are re-linked to the real records locally, and flow into the local tiers. This happens only after the operator decides, and only within what they agreed to share.
- **In practice:** a cloud SOPHIA reasons over Tier 1, while local seats do the Tier 0 work (invoices, bank matching, client records). Every crossing is logged, so the operator can review what was shared, with whom, and when.
- **Fully customisable privacy, set at setup and changeable any time.** The privacy level runs from one end of a spectrum to the other:
  - **Frontier**: hand everything to the cloud model, if the operator chooses.
  - **Tiered**: the membrane above.
  - **Strict local**: a local-only pipe, where no data leaves the machine at all.
  
  The choice can be made per class of data: identities, money, documents, communications, and so on. The first-launch trust question sets the starting profile, and SOPHIA's setup interview refines it.

## Core

- **Own codebase.** Paperclip v2026.1005.0 lives in `core/` as a snapshot, credited in `NOTICE`; every change is listed in `core/OGDOAD_CHANGES.md`.
- **No logins, ever.** Seats are handed to the operator's own harnesses (live-agent mailbox now, herd next). See `HERD.md`.
- **Local EI drives by default.** When the operator wants more power, they hand a role to the CLI of their favourite EI.
- **First launch: choose SOPHIA, the CEO.** She is briefed automatically, the UI opens itself, and she runs a multiple-choice setup interview. See `FIRST-LAUNCH.md`.
- **SOPHIA can reshape the UI.** Live appearance changes (skin, text size, font, tokens) apply instantly, and code changes show via hot reload. Only the server-side human gates are protected.
- **SOPHIA builds dashboards on request** and places them anywhere in the UI. A dashboard is a set of recipes: SQL plus declarative chart JSON, and every chart shows its query.

- **Market research seat and panel.**
  - A dedicated research agent with its own panel. It builds and appends charts (recipes with their queries) and markdown write-ups on anything it learns.
  - It runs on demand or on a schedule.
  - It browses with Chrome through its own harness's connector (for example Claude Code's Claude-in-Chrome). Ogdoad never holds a browser login.
  - Ogdoad *suggests* this setup when the seat is created. Web access is the operator's explicit opt-in, never a default.

- **Fintech seat and panel.**
  - Tracks markets and crypto for the operator: watchlists, prices, moves, news.
  - Publishes charts (recipes) and write-ups to its dedicated panel, on a schedule or on request.
  - Data comes through its own harness (web access or the operator's own API keys, kept in the harness). Panels show data and analysis, not trading instructions. Nothing is traded on the operator's behalf.

## Look and feel

- **Skins.** Ogdoad (clean, corporate, the default), Cyberpunk Ultraviolet, Paperclip Classic. Picked from the account menu. More skins will be added over the project's life.
- **Guided tours.** When the conversation turns to something visual (financials, say), the EI in the operator's Claude Code seat drives the UI: it opens pages, dashboards and filters for the operator. Meanwhile the chat collapses to SOPHIA's picture and a floating chat bubble at the bottom right, so the talk carries on while the operator looks at the organisation's data and pages.

## Money

- **Invoices plugin.** Agents draft invoices as local PDFs, the operator clears them, and agents chase payment with drafts the operator sends. It replaces onlineinvoice.com, supports two bank accounts, is not GST-registered yet, and includes an accountant pack, deduction research and PDF signing.

## Reach and privacy

- **Serve over Tailscale.** A toggle in the UI publishes Ogdoad to the operator's own tailnet with `tailscale serve` (HTTPS, tailnet-only), so it works away from home. Never `tailscale funnel`. Off by default; the toggle shows exactly which address is live.
- **Home sync server.** A small server on a home box keeps a folder tree in sync (backups, issued invoices, documents, exports), reachable only over Tailscale or Headscale. WireGuard already encrypts the link, and the tailnet identity is the login.
- **NotebookLM, two-way, through a sanitized synced source.**
  - Business briefs and audio overviews are generated in NotebookLM from a sanitized copy of Ogdoad's data.
  - Operators can add to that notebook from anywhere, and their additions flow back home into Ogdoad's local data.
  - **Bridge:** a dedicated Google Drive folder. NotebookLM uses Drive files as sources and can re-sync them. A consumer NotebookLM API doesn't exist; Ogdoad's existing connector drives Chrome only to *ask* notebooks questions.
  - **Out:** a local stripping pass writes the sanitized copy. Names, contact details, ABN, bank and NDIS numbers become stable stand-ins (e.g. "Client C-0412").
  - **In:** Ogdoad watches the folder (and the notebook's Drive sources) for new or changed files and imports them.
  - **Re-linking:** the stand-in ↔ real key lives only on the home machine, so imported notes that mention C-0412 attach to the real client locally. Real identities never leave home.
- **Encrypted at rest.** An open-source encrypted container (VeraCrypt-style, or an MIT equivalent) holds the instance, which matters for sensitive healthcare organisations. Compliance claims need checking before they are made.
