# Herd: Ogdoad's agent-session manager

Herd lets SOPHIA (and the operator) **spawn, brief, watch and steer any CLI harness**: Claude Code, Codex, grok, opencode, Gemini CLI, Hermes, or a local model's CLI. Each hire runs in its own terminal session on this machine, under the operator's own logins. Ogdoad never holds a provider key.

Herd is a simplified, Node-native recreation of the core ideas in [Herdr](https://github.com/herdrdev/herdr) (Apache-2.0 since v0.8.0). Credit and licence terms are in `NOTICE`. If we copy Herdr's agent-detection rule files, they come from a pinned tag of v0.8.0 or later, keep their notices, and ship with the Apache-2.0 text.

## What it does

| Capability | How |
|---|---|
| Spawn a hire | node-pty (ConPTY on Windows) runs the harness argv directly in the seat's working directory, with `OGDOAD_HIRE_ID`, `OGDOAD_URL` and the run's job context in the environment. Herd starts the agent itself, with no shell typing. |
| See the screen | `@xterm/headless` renders the PTY stream into a real screen grid, so reads return what a person would see, not raw escape codes. |
| Know the state | Per-harness rules (regions of the screen, AND/OR/NOT, priority) classify each hire as **working / blocked / idle / done** every 300 ms. Working→idle is held for 3 confirmations 100 ms apart (capped at 700 ms), new sessions get 3 s of grace, and an unrecognised prompt counts as idle, never blocked. |
| Self-report | A hire can post its own state, session id and resume command to the mailbox (`127.0.0.1:3199`). A self-report outranks screen reading, except that a visible permission prompt still means blocked. |
| Prompt | Bracketed paste, a 300 ms pause, then Enter. Herd refuses to prompt while a hire is blocked. `prompt --wait` fails fast if the hire hasn't started working within 5 s. |
| Results | Hires post results to the mailbox rather than having them scraped. Claude Code and OpenCode draw in the alternate screen, which has no scrollback. |
| Events | `status_changed` and `output` events stream to SOPHIA and to the Ogdoad UI over a localhost event stream. |
| Resume | Herd stores `{hire, cwd, argv, session_id}` and relaunches with the harness's own `--resume <id>` after a restart. |

## Security

- Listens on 127.0.0.1 only. Every call needs the per-install token in `~/.ogdoad/herd.token`, a file only the operator's account can read. Paperclip's local-trusted mode treats any loopback request as the board, so herd adds its own check.
- Hires run with the operator's own rights; herd is not a sandbox. Herd detects permission prompts but never answers them itself.
- Detection rules ship inside Ogdoad and are never fetched from the network.

## Hard parts (from the Herdr study)

- Detection rules break whenever a harness changes its UI. Keep them as data files with tests, and expect upkeep.
- On Windows there are no process groups. Spawning the harness directly, instead of typing into a shell, avoids most process-tree guessing.
- Enter can arrive inside a paste. The 300 ms pause plus per-harness quirks (Codex on Windows needs a boundary key) handle it.
