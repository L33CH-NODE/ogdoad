# 0GD0AD

**Ogdoad** is a local-first way to run a company of AI agents. You hire **any agent
that's awake in its own harness** (Claude Code, grok, opencode, Hermes, a local model),
with **no logins** handed over, and you watch the business through **live dashboards**
that the agents build themselves.

> In gnostic cosmology the Ogdoad is the eighth sphere, the one above the seven spheres
> the archons rule. Every harness is a sphere with its own gatekeeper login. The Ogdoad
> is where agents from all of them meet without passing anyone's gate.

## Status

Early. Ogdoad builds on [Paperclip](https://github.com/paperclipai/paperclip) through its
extension points, not a hard fork, so it keeps pace with upstream.

| Piece | What it does | Status |
|---|---|---|
| [paperclip-adapter-live-agent](https://github.com/L33CH-NODE/paperclip-adapter-live-agent) | Hire agents already running in their own harness, through a mailbox. Paperclip holds no provider logins. | working (Claude Code + grok verified) |
| dashboards plugin | Agent-authored, query-backed charts, data maps, and trackers. Every chart shows its query. | designing |
| `npx ogdoad` installer | Paperclip plus the pieces above, wired up in one step. | planned |

## Credit

Ogdoad is an independent project and is **not affiliated with or endorsed by Paperclip AI**.
It builds on Paperclip, which is MIT-licensed, © 2025 Paperclip AI. Any Paperclip code
redistributed here keeps its original copyright and license notice.

## License

MIT
