# Horos: Ogdoad's agent-session manager

In Valentinian myth, Horos ("the Limit") guards the boundary of the fullness. When Sophia fell, Horos brought her back and kept her in place. Here it does the same for SOPHIA and every other hire: it keeps them inside their bounds, watches them, raises the alarm, and brings them back when they fall.

Horos lets SOPHIA (and the operator) **spawn, brief, watch and steer any CLI harness**: Claude Code, Codex, grok, opencode, Gemini CLI, Hermes, or a local model's CLI. Each hire runs in its own terminal session on this machine, under the operator's own logins. Ogdoad never holds a provider key.

Horos is a simplified, Node-native recreation of the core ideas in [Herdr](https://github.com/herdrdev/herdr) (Apache-2.0 since v0.8.0). Credit and licence terms are in `NOTICE`. If we copy Herdr's agent-detection rule files, they come from a pinned tag of v0.8.0 or later, keep their notices, and ship with the Apache-2.0 text.

## What it does

| Capability | How |
|---|---|
| Spawn a hire | node-pty (ConPTY on Windows) runs the harness argv directly in the seat's working directory, with `OGDOAD_HIRE_ID`, `OGDOAD_URL` and the run's job context in the environment. Horos starts the agent itself, with no shell typing. |
| See the screen | `@xterm/headless` renders the PTY stream into a real screen grid, so reads return what a person would see, not raw escape codes. |
| Know the state | Per-harness rules (regions of the screen, AND/OR/NOT, priority) classify each hire as **working / blocked / idle / done** every 300 ms. Working→idle is held for 3 confirmations 100 ms apart (capped at 700 ms), new sessions get 3 s of grace, and an unrecognised prompt counts as idle, never blocked. |
| Self-report | A hire can post its own state, session id and resume command to the mailbox (`127.0.0.1:3199`). A self-report outranks screen reading, except that a visible permission prompt still means blocked. |
| Prompt | Bracketed paste, a 300 ms pause, then Enter. Horos refuses to prompt while a hire is blocked. `prompt --wait` fails fast if the hire hasn't started working within 5 s. |
| Results | Hires post results to the mailbox rather than having them scraped. Claude Code and OpenCode draw in the alternate screen, which has no scrollback. |
| Events | `status_changed` and `output` events stream to SOPHIA and to the Ogdoad UI over a localhost event stream. |
| Keep and resume | A hire spawned with `keep` goes on the **roster** (`~/.ogdoad/horos/roster.json`): its argv, how to resume it, its brief and its seat. When Horos starts, it brings every kept hire back under the same id, resumed with the harness's own `--resume <id>` where it can (Claude Code, Codex) or fresh with its brief re-delivered, and re-binds its seat. When a kept hire's session ends on its own, `planRestart` (`src/restart.ts`) decides whether and how to bring it back. `kill` lets a hire go for good. |
| Rest and wake | The operator's rules, in `planRestart`: a clean exit (`/exit`) means the hire meant to stop, so it **rests** and isn't restarted. A crash restarts it (5 s, 30 s, 2 min, resumed; fresh if a resume dies within 20 s). Three crashes in 10 minutes and it rests too. A resting hire's seat keeps listening, so **assigning it a task starts it again**; `horos wake <id>` starts it by hand. |
| Notifications | The operator is on the pulse of everything. Every error, restart, sign-off, needs-you, job start, finish, failure and mailbox outage goes into the feed (`~/.ogdoad/horos/notifications.jsonl`, `GET /v1/notifications`, `horos notifications`) and pops up as a desktop alert under the name "Ogdoad". Bursts fold into one alert led by the worst. Working/idle flips arrive as a "Team pulse" digest at most once a minute. Hires can raise their own alerts with `POST /v1/notifications`. |
| Graceful shutdown | `horos stop` (and the UI's shutdown button, via `POST /v1/shutdown {graceful: true}`) stops taking jobs, lets running ones finish and save, waits for each hire to settle (alerting if one waits on a decision), quits each one through its own exit command (`/exit` for Claude Code) so its session is saved, then stops. Kept hires come back on the next start. `stop --now` skips the waiting. |
| Background service | `horos start` runs Horos detached and logs to `~/.ogdoad/horos/horos.log`; `horos stop` stops it and its hires, leaving the roster for the next start. OGDOAD-START starts Horos before Ogdoad, de-elevated like Ogdoad itself. |

## Security

- Listens on 127.0.0.1 only. Every call needs the per-install token in `~/.ogdoad/horos/horos.token`, a file only the operator's account can read. Paperclip's local-trusted mode treats any loopback request as the board, so Horos adds its own check.
- Hires run with the operator's own rights; Horos is not a sandbox. Horos detects permission prompts but never answers them itself.
- Detection rules ship inside Ogdoad and are never fetched from the network.

## Hard parts (from the Herdr study)

- Detection rules break whenever a harness changes its UI. Keep them as data files with tests, and expect upkeep.
- On Windows there are no process groups. Spawning the harness directly, instead of typing into a shell, avoids most process-tree guessing.
- Enter can arrive inside a paste. The 300 ms pause plus per-harness quirks (Codex on Windows needs a boundary key) handle it.
