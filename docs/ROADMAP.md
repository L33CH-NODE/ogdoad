# Ogdoad roadmap

Ideas and decisions, newest at the bottom of each section. Specs live next to this file.

## Build order (agreed 2026-10-09)

One constraint decides it: while Ogdoad runs in local-trusted mode, every request from this machine is the board, so any hire can act as the operator. Money comes first but stays operator-only; the doors get locked before any agent goes near money or the tailnet.

0. **Loose ends.** The Ogdoad server runs under Horos, so a graceful shutdown stops it last and a crash raises an alert. Ollama in WSL is reachable from Windows (the base of Tier 0). SOPHIA's setup interview finishes.
1. **Money, on the new UI's skeleton.** The new app shell (floating layout, tokens, API client, Horos notification bell), with Money as its first screen. The invoices backend: history import, numbering that continues the old sequence, PDFs, two bank accounts, the GST-threshold meter. Operator-only. *Done when the operator stops using the old invoicing site.*
2. **Lock the doors.**
   - Hires run as their own low-privilege identity.
   - Local-trusted mode is off: the operator's browser gets a session, agents only get per-run tokens.
   - The core server builds (via WSL).
   - A director key on a passkey or USB security key signs irreversible acts, which subsumes the invoice gates.
   - Rewind snapshots every mutating run.
   
   *Done when a stolen token can't clear, push or spend, and any run can be rolled back.*
3. **The operator's home.**
   - A decision band on top, with the agent dashboard squares below it.
   - The dashboard runtime and the dashboard-craft skill.
   - SOPHIA's chat bar, Team, the notification centre with a deep-work lock, the graceful-shutdown button, and the skins.
   - Then Paperclip's old UI is retired.
4. **Agents near money, and the membrane.**
   - A local Ledger seat: bank matching, ageing, chasing drafts the operator sends.
   - The membrane: stand-ins, the Tier 1 pane, the crossings log, privacy per data class, the exfil-allowed flag.
   - Behaviour checks: declared-scope drift checks, canaries, the refusal surface, claims for done/verified/paid.
   - The accountant pack and deductions research.
5. **Reach.** The Tailscale serve toggle (only after step 2), the home sync server, and encryption at rest.
6. **Going public.** A branding pass, README and final scrub, then push and publish on the operator's word.
7. **Growth and experiments.**
   - Market research and fintech seats.
   - Guided tours.
   - NotebookLM two-way.
   - SOPHIA editing UI code.
   - Dissent for flagged decisions.
   - An "already tried" table.
   - Skill pinning, growing into the genome.
   - The cost vector.

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
- **No logins, ever.** Seats are handed to the operator's own harnesses (live-agent mailbox now, Horos next). See `HOROS.md`.
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

- **Abilities belong to the hire.** Every skill, plugin and tool an agent uses is its own harness's native ability (Claude Code skills and MCP servers, Codex tools, ...), unless the operator gives it in chat or tells the agent to learn and load it in its own harness. Trust is managed by the operator per hire: for a new ability, hire a different kind of EI from another provider. Ogdoad's own features (invoices, dashboards, the privacy membrane) are operator-side apps that agents reach over the API, not agent abilities.
- **The operator is on the pulse of everything.** Every error and status in the team reaches the operator as a notification: desktop alerts now, plus the UI's notification centre and the Team pulse panel.
- **Graceful shutdown button in the UI.** Running work finishes and saves, each hire quits through its own `/exit`, then the server stops cleanly, so Postgres is never killed mid-write. Horos's side is done. The server side is next: Horos runs the Ogdoad server in a terminal of its own, so the shutdown can press Ctrl+C on it last, after every agent has exited.

## Look and feel

- **Ogdoad's own UI, built from the ground up.** It's a lean set of screens (home, SOPHIA, decisions, tasks, team, money, files, privacy log, settings) on our own design system, with Paperclip's server underneath as a borrowed engine until we replace it. The shell has floating glass menus: a detached sidebar, an inspector on the right, and SOPHIA's composer bar floating at the bottom. **The middle is reserved for agent-made dashboards:** a grid of squares that any agent fills, at the operator's request or as its own suggestion. Panels are animated, show live data, and keep a tasteful idle motion. The craft becomes a skill shipped in this repo as instructions for EIs. Mock: "Ogdoad Shell Mock" canvas.

- **Skins.** Ogdoad (clean, corporate, the default), Cyberpunk Ultraviolet, Paperclip Classic. Picked from the account menu. More skins will be added over the project's life.
- **Guided tours.** When the conversation turns to something visual (financials, say), the EI in the operator's Claude Code seat drives the UI: it opens pages, dashboards and filters for the operator. Meanwhile the chat collapses to SOPHIA's picture and a floating chat bubble at the bottom right, so the talk carries on while the operator looks at the organisation's data and pages.

## Governance: trust by evidence, not by self-report

Ideas, not started yet. Paperclip's controls are a budget cap, an approval button and comment threads. These assume a hire can be wrong, cheap, compromised, or quietly maximising a proxy, and keep the operator safe anyway.

- **Drift detector.**
  - Every heartbeat emits a distribution: tool calls, files touched, tokens spent.
  - A standing scorer compares that distribution with the embedding of the stated goal, never with the agent's own report.
  - Past a threshold the agent is quarantined: no new tickets, its workspace frozen, its diff dumped to the board.
  - A budget cap stops an agent at 100% spend. It doesn't stop one cheaply doing the wrong thing, and proxy metrics are how maximisers win while the dashboard stays green.
  - This is the feature the name obligates; Horos, the Limit, is its natural owner.
- **Director key, not an approval button.**
  - Irreversible acts are proposals until the operator signs them with an Ed25519 director key, or optionally a dedicated USB security key. They are: hiring, spending, pushing, deleting, rotating a secret, changing a goal.
  - Agents can countersign, but they can't mint the commitment.
  - A stolen adapter token then impersonates a worker, not the company.
  - The board shouldn't be a UI role. It should be a key that isn't on the agents' machine.
- **Claims, not comments.**
  - The shared record is a ledger of claims, each with evidence hashes, contradiction links and decay.
  - An agent can't promote a claim to "done" or "true" without a witness: a tool-output hash, a second model, or the operator.
  - Comment threads are how agents launder guesses into the organisation's memory. A claim with no witness stays grey in the UI forever.
- **Canaries inside the context, not just in the log.**
  - Each workspace gets planted honeytokens: fake paths, fake API keys, fake prior decisions.
  - Touching one kills that agent identity, rotates secrets, and marks every downstream claim from that run as tainted.
  - Audit logs say what an agent claims it did. Canaries say when something in a prompt or a tool tried to walk out. That's the difference between governance and intrusion detection.
- **Dissent before recommendation.**
  - High-impact tickets need two adapters to write opposing briefs before the board sees a plan. The same local model under two different system constraints is enough.
  - Consensus is cheap for LLMs and expensive for the operator, so the UI shows the disagreement, not a smoothed CEO summary.
- **Node physiology.**
  - Agents bind to a machine: VRAM, watts, thermals, online or offline, Tailscale path.
  - The scheduler refuses cloud fallback unless the ticket is explicitly marked exfil-allowed.
  - Cost is a vector (joules, queue delay, minutes of human review), not a dollar cap that assumes an API meter.
  - An agent that dies when a low-power home box sleeps is behaving correctly. It isn't an outage.
- **Stigmergy instead of shared chat.**
  - Agents don't read each other's transcripts. They leave decaying traces in the environment: a pheromone on a file, a Bloom filter of "already tried", an epigenetic mark on a skill that failed its eval.
  - Shared context windows are a telephone game and a prompt-injection bus.
  - Environment traces are harder to poison, and cheap to replicate across the operator's machines over a CRDT.
- **Rewind as a primitive.**
  - Every mutating heartbeat snapshots the workspace.
  - The board rewinds to before the run instead of being asked to review a diff.
  - Review after the fact is what Paperclip offers. Reversible execution is what makes untrusted local agents tolerable.
- **Refusal surface.**
  - The ticket records the boundary crossing whenever a routed model refuses or rewrites the work, or a local abliterated model goes ahead with it.
  - Sovereignty is useless if the operator can't see where censorship, or its absence, changed the work. Most UIs hide this because it looks like a bug.
- **Skill genome with a behavioural canary.**
  - Skills are versioned mutations whose fitness comes from evals.
  - A skill that starts passing its tests while its tool distribution drifts from its spec gets the same quarantine as a maximiser.
  - Versioning skills isn't enough, because a trusted skill can go feral.
- **An empty state for one brain.**
  - The default view isn't an org chart. It's one decision: what changed since the last signature, what's quarantined, what needs a key.
  - Context-switch cost is a first-class number. A deep-work lock pauses heartbeats that would notify the operator.
  - A corporate kanban is the wrong instrument for one person running a mesh.

**Where these meet what exists** (to settle before building):
- **Naming:** Horos already has a "detector", the screen-state stabiliser. The new one should keep the name "drift detector".
- **Notifications:** the deep-work lock and "the operator is on the pulse of everything" pull in opposite directions. Likely answer: the feed always records, and the lock holds back the desktop alerts.
- **Home screen:** the empty state for one brain and the dashboard-grid home need one shape. For example, the decision band sits on top and the squares sit below it.
- **Skills:** abilities belong to the hire's own harness, so the skill genome tracks the skills the operator gives to hires and the ones Ogdoad ships, not each harness's built-ins.
- **Director key vs human gates:** the director key would subsume the human-only gates already planned (clearing invoices, signatures, bank details).

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
