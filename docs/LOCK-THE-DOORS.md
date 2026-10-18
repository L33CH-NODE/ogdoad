# Locking the doors

Roadmap phase 2: where things stand, and the choices, in the order they pay off. Nothing here is turned on without the operator's word: each changes the machine, not just Ogdoad.

## Where things stand (checked 2026-10-10)

- **Nothing is reachable from outside.** Every Ogdoad port listens on 127.0.0.1 only: the server (:3100), the app (:3101), the practice copy (:3102), and Horos (:3198). Nous's mailbox is on the server's own port. Not the network, not the tailnet.
- **Ogdoad's own data is encrypted with the operator's key:** Money, Work (shifts and their notes), Flow, dashboards, the calendar's login and the sealed PDFs. Its backups are encrypted the same way.
- **The engine's backups are sealed (2026-10-12).** The engine dumps its database every hour in the clear. Ogdoad seals each dump within minutes, locked or not:
  - to a public key whose private half only the vault opens (ML-KEM-768 + X25519, then XChaCha20-Poly1305 with PADMÉ padding; see `app/src/server/sealed.ts`);
  - the plain dump is cleared only once its sealed copy has opened again, identical;
  - old backup folders can be queued (`~/.ogdoad/backups/to-seal.json`) and become one sealed archive each.
- **Not encrypted:**
  - Nous's store (`~/.ogdoad/nous/nous.db`) is encrypted under its own key, and so are its backups. What's left in the clear is the hires' own session histories, in each harness's own folders, and anything left from the engine Ogdoad started on (`~/.paperclip`, if it was ever installed).
  - The drive itself, unless full-disk encryption is on.
- **Local-trusted mode.** Anything running on this machine as the operator can call the server as the board. That includes the hires, which run with the operator's own Windows rights.

## The choices

1. **BitLocker on C: (the first step).**
   - **Covers:** everything on the drive, both databases, the backups, the hires' workspaces and the seat briefs, if the machine or its disk is taken.
   - **Costs:** a recovery key to keep safe (printed, or on the recovery plate's shelf), and a one-time background encryption. Windows 11 Pro has it: Settings › Privacy & security › Device encryption, or `manage-bde -on C: -RecoveryPassword` from an admin shell.
   - **Limit:** it doesn't stop anything running as the operator while they're logged in.
2. **EFS on what's still in the clear** (the old engine's folder, if it was ever installed, and the harnesses' own session folders).
   - **Covers:** `cipher /e /s:%USERPROFILE%\.paperclip` (and the same for each harness's folder) encrypts it to the operator's Windows account. It's narrower than BitLocker.
   - **Costs:** the certificate must be backed up (`cipher /x`), or a Windows password reset loses the data.
   - **Limit:** the same as BitLocker's.
3. **The engine's database encrypted with the operator's key.** Done with Nous (0.2.0): its store is SQLCipher under a key the vault hands it, and its backups stay encrypted.
4. **Hires as their own Windows users** (phase 2's "own low-privilege identity"). This is the real door.
   - **Covers:** each hire runs as a separate local account with no access to the operator's home folder. That's what stops a hire reading the vault file or the Horos token, or calling the server as the board.
   - **Costs:** local accounts (admin). Horos would launch hires through those accounts and give each workspace its own permissions.
5. **A token for the operator.** Done with Nous (0.2.0): only a request with the operator's token acts as the operator. It's only as strong as 4 makes it: until then, a hire can read any file the operator can, the token's included.

## Recommendation

1. **BitLocker now.** It takes minutes of the operator's time and covers theft.
2. **Then hires as their own users.** That protects against a hire that misbehaves.
3. **Then the board token.**
4. **The container later,** when the healthcare pitch needs it.
