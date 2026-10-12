# 0GD0AD

**Ogdoad is a local-first control center for running a business with AI agents.** It runs on your own machine. You hire agents that already live in their own harnesses (Claude Code, Codex, grok, Gemini, opencode, Hermes, a local model), and you watch the work happen live. Your business's real data stays on your machine, and **you make every call that matters**.

> In gnostic cosmology the Ogdoad is the eighth sphere, above the seven the archons rule. Every harness is a sphere with its own gatekeeper login. The Ogdoad is where agents from all of them meet without passing anyone's gate.

## What's in it

- **One surface, eight zones.** Pulse, Flow, Team, Money, Work, Artifacts, Signals and Dashboards tile the screen and open in place. A command line doubles as a palette (Ctrl+K), and leader keys get you around (G then F for Flow, ? for every key).
- **Flow, not kanban.** The one thing to do now, the next three behind it, and work the rest of the system raises (a draft to issue, a late invoice, a hire's question) that clears itself once it's done.
- **The team.**
  - Horos (`horos/`) starts any CLI harness in a terminal of its own, keeps it alive, reads its screen and answers it.
  - SOPHIA, the CEO seat, runs in the harness you pick.
  - Project rooms show the hires talking to each other and to you, live.
  - A local dispatcher proposes who takes which part of a job; you approve or deny the lineup. Parts that need your real records go only to local hires.
- **Money and Work, local and encrypted.**
  - Invoices, payments, bank statements, GST and a pack for your accountant.
  - Shifts, shift notes and a two-way CalDAV calendar.
  - All of it lives in one SQLCipher database, opened only by your password or your 24-word recovery phrase. The phrase can be 3D-printed as a plate.
- **The membrane.** Before anything leaves for a hire, real identities become stand-ins: `C-4821` for a client, `EMAIL-2210` for an address. Three passes catch them:
  - what your books know;
  - patterns with check digits (ABN, TFN, Medicare, cards, BSB and account, phones, addresses);
  - a local model ([OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter), on the CPU).

  Anything that names someone waits on a check card. You click any piece to decide it, edit what goes, and approve or deny. Stand-ins read as real names on your screen only, and a client's real detail turning up in a cloud hire's message pauses that hire.
- **The watch.** When a hire stops to ask permission, the watch reads the prompt off its screen, sorts it by risk and brings it to you to allow or deny.
  - Your policy (`app/src/server/watch/policy.ts`) can answer what's plainly safe, once you turn that on.
  - Deleting, sending anything out, spending, investing, secrets and starting agents always wait for you.
- **What the cloud has seen.** Every message, answer and request that leaves for a hire is logged: who got it, through which harness, and whether that's a cloud model.
- **Dashboards written blind.** A panel is a SQL query plus a chart spec. A hire writes it from the tables' shape alone, and it runs here, sealed, on a curated copy of the data. The hire never sees a row.

## Status

**Pre-alpha, and personal-scale.** It's built for one operator, and it's developed and used on Windows 11, with WSL2 for the local models. Expect rough edges, and moving APIs.

- There's no installer yet: `npx ogdoad` is a placeholder. Running from source is below.
- The engine underneath (`core/`, a snapshot of [Paperclip](https://github.com/paperclipai/paperclip)) keeps tasks and comments in its own Postgres, which isn't encrypted by Ogdoad. `docs/LOCK-THE-DOORS.md` says what to do about it (full-disk encryption first).

## Layout

| Folder | What it is |
|---|---|
| `app/` | Ogdoad's own server and UI: the control center, Money, Work, the vault, the membrane, the watch (`npm test` runs its suite) |
| `horos/` | The session manager: starts, watches, resumes and stops the hires and servers |
| `core/` | Paperclip v2026.1005.0, vendored as the engine (tasks, agents, runs); Ogdoad's changes are in `core/OGDOAD_CHANGES.md` |
| `runtime/` | The pinned engine build Ogdoad runs, with its patches |
| `models/membrane/` | The membrane's local model service (setup and serving) |
| `models/dispatch/` | The dispatcher's local model service (llama.cpp, from Ollama's store) |
| `docs/` | How it's meant to work: start with `CONTROL-CENTER.md` and `ROOMS-AND-THE-MEMBRANE.md` |

## From source

You'll need Node 22.5 or later, and Windows (WSL2 for the local models).

```sh
cd runtime && npm install                          # the pinned engine, patched
cd ../horos && npm install && npm run build        # the session manager
cd ../app && npm install && npm run build && npm test
```

Horos then runs the engine and the app as servers (`horos spawn generic --server …`, see `docs/HOROS.md`). The app listens on `127.0.0.1:3101` and never on any other interface. Its first launch walks you through making your key and choosing SOPHIA.

## Privacy, briefly

- Your books, notes and clients' details are Tier 0: local, encrypted and never sent anywhere.
- What you write for a cloud hire goes through the membrane, and anything that names someone waits for your yes.
- The local models run on your own machine, and the membrane's model never logs what it reads.
- Nothing is published, pushed, sent or spent by an agent without passing a gate you hold.
- `scripts/check-private.mjs` checks every push for secrets and for your own private words, kept in a file on your machine that never enters the repo.

## Credit

Ogdoad is an independent project, **not affiliated with or endorsed by Paperclip AI or Herdr**.

- **[Paperclip](https://github.com/paperclipai/paperclip)** is MIT, © 2025 Paperclip AI. `core/` keeps its copyright and license.
- **Horos** is Ogdoad's own code, designed with reference to [Herdr](https://github.com/herdrdev/herdr).
- **The membrane's model** is [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter), Apache-2.0. It's downloaded by `models/membrane/setup.sh`, not redistributed here.

See `NOTICE`.

## License

MIT
