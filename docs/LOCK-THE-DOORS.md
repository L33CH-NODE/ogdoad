# Locking the doors

Roadmap phase 2: where things stand, and the choices, in the order they pay off. Nothing here is turned on without the operator's word: each changes the machine, not just Ogdoad.

## Where things stand (checked 2026-10-10)

- **Nothing is reachable from outside.** Every Ogdoad port listens on 127.0.0.1 only: the server (:3100), the app (:3101), the practice copy (:3102), Horos (:3198), the mailbox (:3199) and the engine's Postgres (:54329). Not the network, not the tailnet.
- **Ogdoad's own data is encrypted with the operator's key:** Money, Work (shifts and their notes), Flow, dashboards, the calendar's login and the sealed PDFs. Its backups are encrypted the same way.
- **Not encrypted:**
  - The engine's Postgres (`~/.paperclip/instances/default/db`): the hires' tasks and comments, SOPHIA's interview answers, run logs.
  - The drive itself: C: has no BitLocker.
- **Local-trusted mode.** Anything running on this machine as the operator can call the server as the board. That includes the hires, which run with the operator's own Windows rights.

## The choices

1. **BitLocker on C: (the first step).**
   - **Covers:** everything on the drive, both databases, the backups, the hires' workspaces and the seat briefs, if the machine or its disk is taken.
   - **Costs:** a recovery key to keep safe (printed, or on the recovery plate's shelf), and a one-time background encryption. Windows 11 Pro has it: Settings › Privacy & security › Device encryption, or `manage-bde -on C: -RecoveryPassword` from an admin shell.
   - **Limit:** it doesn't stop anything running as the operator while they're logged in.
2. **EFS on the engine's folder.**
   - **Covers:** `cipher /e /s:%USERPROFILE%\.paperclip` encrypts that folder to the operator's Windows account. It's narrower than BitLocker.
   - **Costs:** the certificate must be backed up (`cipher /x`), or a Windows password reset loses the data.
   - **Limit:** the same as BitLocker's.
3. **The engine's database in an encrypted container** that opens with the operator's key: the roadmap's encrypted-at-rest container, and the right answer for the healthcare pitch. It's the most work: the engine's data dir moves into a container mounted at start, before Horos starts the server.
4. **Hires as their own Windows users** (phase 2's "own low-privilege identity"). This is the real door.
   - **Covers:** each hire runs as a separate local account with no access to the operator's home folder. That's what stops a hire reading the vault file or the Horos token, or calling the server as the board.
   - **Costs:** local accounts (admin). Horos would launch hires through those accounts and give each workspace its own permissions.
5. **A board token for the classic API**, held only by the app server, so other local processes can't act as the board. It's only worth doing after 4: until then, a hire can read any file the operator can.

## Recommendation

1. **BitLocker now.** It takes minutes of the operator's time and covers theft.
2. **Then hires as their own users.** That protects against a hire that misbehaves.
3. **Then the board token.**
4. **The container later,** when the healthcare pitch needs it.
