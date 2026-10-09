# First launch: choosing SOPHIA

Ogdoad needs no provider logins. The company's CEO, **SOPHIA**, is a seat that the operator hands to whichever harness they trust: a private local model, or a powerful cloud CLI they already use. Ogdoad's own job is to spawn that harness, brief it, and watch it.

## The flow

1. **Start.** `npx ogdoad` (or `OGDOAD-START.bat`) starts the Ogdoad server and the **herd** backend (Ogdoad's agent-session manager, see `HERD.md`).
2. **Detect.** Herd finds what is installed:
   - cloud CLIs: Claude Code, Codex, grok, opencode, Gemini CLI, Hermes
   - local models: Ollama (`127.0.0.1:11434`), llama-server and LM Studio endpoints
3. **Ask.** In the terminal:
   > Who do you want to be SOPHIA, your CEO?

   First it asks how much the operator trusts the cloud with their business:
   - **Private**: nothing leaves this machine.
   - **Balanced**: cloud is fine for planning, but keep company data local.
   - **Power**: use the strongest model available.
4. **Recommend.** Depending on that answer, herd suggests either the most private capable local model or the most powerful cloud CLI found, and says why. The operator confirms or picks another.
5. **Spawn and brief.** Herd launches the chosen harness in its own terminal session (working directory `~/.ogdoad/seats/sophia`). It pastes in the SOPHIA role brief, which covers:
   - who she is
   - how to hire through herd
   - how to watch hires
   - the Ogdoad API and mailbox
   - what needs the operator's yes

   **SOPHIA takes the role automatically.** No further prompting is needed.
6. **Register.** SOPHIA is recorded as the company's CEO agent on the `live_agent` adapter, so Ogdoad holds no keys for her provider.
7. **Open the UI.** The browser opens `http://127.0.0.1:3100`. The terminal also prints:
   > Didn't open? Click here: http://127.0.0.1:3100

8. **The interview.** The UI lands the operator in a chat with SOPHIA. She runs a multiple-choice interview about the business and about how Ogdoad should be set up: what the business does, who the clients are, which seats to hire, how much autonomy each gets, and what always needs the operator's yes. It uses Paperclip's existing question cards (`ask_user_questions` interactions on a "Set up the company" task), so every answer is recorded in the task thread and SOPHIA can act on it.

## SOPHIA can reshape Ogdoad

Ogdoad is a full code instance, and SOPHIA is allowed to change any part of the UI, at the operator's request or on her own initiative ("change skins, make the text a little bigger, use this font, and here are some theme ideas").

- **Live appearance (instant, no rebuild).** Skin, text scale, font and custom token sets are stored as an appearance setting. SOPHIA changes it through a tool or the API, and every open UI applies it immediately.
- **Code (hot-reload).** SOPHIA's seat can work in the Ogdoad repo. The UI runs with hot module reload, so edits appear as they are saved. Every change is a git commit on a branch, so any of them can be undone, and the operator can roll back to the last known-good build at any time.
- **Protected paths.** The checks that keep the operator in charge run on the server, not in the UI: human-only clearing, signing, bank details and approvals. Changes to those files wait for the operator's yes. Everything else is open.

## Later launches

If SOPHIA's seat is already assigned, herd resumes her session (with the harness's own `--resume <id>` where it has one) and opens the UI. To hand SOPHIA to a different harness, the operator re-runs the chooser: `npx ogdoad sophia`.

## Line of sight

SOPHIA hires through herd, so she sees each hire's live state (working, blocked, idle, done), can read their screens, and can prompt them. The operator sees the same picture in the Ogdoad UI, updated live over a localhost event stream.

## Defaults that protect the operator

- Local models are offered first whenever trust is "Private", and are never silently swapped for cloud.
- Herd's API listens on 127.0.0.1 only and requires a per-install token file readable only by the operator's account.
- Herd answers no permission prompts on its own. A blocked hire waits for SOPHIA or the operator.
