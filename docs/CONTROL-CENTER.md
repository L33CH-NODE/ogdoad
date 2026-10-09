# The control center

Ogdoad isn't a notes app with a sidebar or a project board. It's a living control center for a business: one surface where the operator sees the whole operation move, and steps in where it matters.

## Principles

- **One surface, no navigation chrome.**
  - No sidebar, no hamburger menu, no page hopping.
  - The business is laid out as zones that tile the screen edge to edge, with seams instead of gaps. Nothing floats in empty space.
- **Everything is live.**
  - Every zone reacts to what's happening right now: a payment landing, a hire getting blocked, a shift starting.
  - When nothing is happening, motion is ambient and calm. When something is, it says so, and the rest stays still.
- **Zones open in place.**
  - Choosing a zone grows it to fill the surface, and Esc shrinks it back.
  - You never lose your place, because there's no "page" to lose it on.
- **Type to do anything.**
  - The command line at the bottom is SOPHIA and the command palette at once (Ctrl+K from anywhere).
  - "new invoice for Harbour", "go money", "what's late?", "/lock".
- **Flow, not management.**
  - It's built for one brain doing deep work. The operator sees the one thing that moves the business next, not a wall of everything.
  - Context switching is a cost the UI works to avoid.

## The surface

The zones tile the screen, bento-style. Sizes adapt to the screen; on a phone they stack.

| Zone | What it shows | Alive how |
|---|---|---|
| **Pulse** (top) | SOPHIA's ranked banner: what's blocked on the operator and what matters, most unblocking first. | Items rise, fall and leave as things change; the lead item is large, with the one action that clears it. |
| **Flow** (tasks) | The operator's own work as a flow, not a board (below). | The current task is in focus; finishing it brings the next one in. |
| **Team** | The hires as a living constellation around SOPHIA, each with its harness, seat and state. | Working hires pulse, blocked ones glow amber, resting ones dim; open one to see its terminal live. |
| **Money** | A river: invoices flow from draft to issued to paid, owed and late at a glance, and the GST meter. | A payment landing moves its invoice across with a flash; late ones drift red. |
| **Work** | Today's and this week's shifts on a timeline with a now-line, plus shift notes due. | The now-line moves; a shift without its note nags gently once it's over. |
| **Artifacts** | Everything that got made (below). | New work slides onto the shelf as it's produced. |
| **Signals** | The event stream: Horos alerts, money events, agent activity, compact and terminal-like. | Scrolls as things happen; quiet in a deep-work lock. |
| **Dashboards** | Agent-made panels, each a square of the grid. | Live data with tasteful idle motion. |

## Flow: tasks, done for focus

Kanban columns turn work into inventory. Flow shows the operator what to do now, and keeps everything else out of the way until it's needed.

- **Now:** one task in focus, big, with the context needed to do it (the invoice to check, the decision to make, the note to write). Done and skip are one key each.
- **Next:** the three that follow, already ranked by SOPHIA (urgency, what it unblocks, effort).
- **Currents:** what the hires are working on, as moving lanes the operator can glance at but doesn't have to manage.
- **Parked:** later things, out of sight until their time.
- **Momentum:** a quiet sense of progress (done today, a streak). No guilt metrics.
- **Deep-work lock:** silences everything but genuine emergencies until the operator comes back.
- **Sources:** the operator's own tasks, the Ogdoad server's tasks assigned to the operator, and the work Money and Work create (bank lines to confirm, chases to send, shift notes due) all land in one flow.

## Artifacts: what got made

The shelf of everything produced in the business, by the operator or by any hire.

- **What's on it:** invoices (PDFs), shift notes, documents and reports agents wrote, dashboards, research write-ups, exports, code changes.
- **Provenance on every item:** who made it (which hire, which harness), from what, when, its privacy tier, and what the cloud saw while making it.
- **Each one can be** previewed in place, opened, pinned to the surface, handed to a hire to work on, or shared outward. Sharing is always the operator's act.
- **One timeline,** filterable by kind, hire or client, and searchable from the command line.

## Onboarding

The first launch is a guided arrival, not a settings form:

1. **Welcome.** Name the business.
2. **Make your key.**
   - Choose a login and a password.
   - Ogdoad generates a 24-word recovery phrase. You write it down, then confirm three of the words.
   - Everything Ogdoad keeps is encrypted with a key that only your password or your phrase can unlock (see the vault, below).
3. **Choose SOPHIA.** Ogdoad detects the harnesses and local models on this machine, asks how much you trust the cloud, recommends, and you confirm.
4. **Bring your business in.** The old invoicing site, bank statements, and the calendar, each optional and skippable.
5. **Arrive.** The control center comes alive, and SOPHIA introduces herself in the command line.

## The vault: encrypted, unlocked only by your key

- **One random data key** (256-bit) encrypts Ogdoad's own stores at rest: Money, shift notes, artifacts. The data key is never stored in the clear.
- **It's stored twice, wrapped:**
  - once under a key derived from the **password** (memory-hard key derivation);
  - once under a key derived from the **24-word recovery phrase**.
  
  Either one unlocks it. A forgotten password is recovered with the phrase, which then sets a new password.
- **Logging in** (login + password, checked locally, no server anywhere) unwraps the data key into the app server's memory for the session. **Locking** (or an idle timeout) drops it. The browser holds only a session cookie: HttpOnly, same-site, and bound to 127.0.0.1.
- **The director key** is derived from the recovery phrase: an Ed25519 key for signing irreversible acts (issue, spend, push, delete, change a goal). Signing asks for the password again. Agents can propose and countersign, but never sign.
- **What this covers first:** Ogdoad's own data. The borrowed engine's database (tasks, comments) is covered once it moves into an encrypted container, or when the engine is replaced; until then, the UI says plainly what is and isn't encrypted.
- **Honest limits:**
  - Hires run with the operator's own rights until they get their own identity (phase 2), so isolation still matters.
  - Losing both the password and the phrase means the data is gone. That's the point, and onboarding says so before the phrase is shown.
