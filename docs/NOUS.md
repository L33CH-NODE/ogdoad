# Nous: Ogdoad's engine

**Nous** is Ogdoad's own engine. It keeps the company's rooms, tasks, talk, documents, question cards and approvals, and wakes a hire when there's work for it.

It replaces the Paperclip engine Ogdoad started on. It's inspired by Paperclip the way Horos is inspired by Herdr: our own code, written from what Ogdoad needs. The contract it has to keep is in [ENGINE-CONTRACT.md](ENGINE-CONTRACT.md).

> In the old cosmology, Nous is the mind: the first to come forth, the one that knows. SOPHIA runs the company and Horos guards the boundary. Nous holds what the company knows and wakes whoever's needed.

## Decided (2026-10-14)

| | Choice | What it means |
|---|---|---|
| **Locking** | After first unlock | Nous's data is encrypted on disk, always. Once the operator has unlocked Ogdoad since the machine started, the team keeps working while the screen locks. After a reboot, the team waits for the first unlock. |
| **Process** | Its own service under Horos | Horos keeps Nous up, like the app. Updating or restarting the app never interrupts the team. The app hands Nous its key on unlock, over a private local channel. |
| **API** | Ogdoad's own, plus a translator | Nous speaks an API designed for Ogdoad (`/v1/...`). A translator answers the old routes (`/api/...`), so the app, Horos's wizard and every hire kept working on the day it switched over. They have all moved to `/v1` since (0.2.0); the translator stays for live workers outside Horos. |
| **Name** | Nous | |

## Keys and who's who

- **The data key.** On unlock, the app derives Nous's key from the vault (`vault.key("nous")`) and posts it to `POST /v1/unlock`. Nous keeps the key in memory only, until the process ends.
  - Until then, Nous answers `423 locked` to everything except health.
  - The data lives in one SQLCipher file, `~/.ogdoad/nous/nous.db`.
- **The operator.** Every operator request carries `Authorization: Bearer <operator token>`. The token is a file only the operator's own processes read (`~/.ogdoad/nous/operator.token`): the app adds it when it proxies the browser, and Horos's wizard reads it.
  - The browser reaches Nous through the app at `/nous/v1/...`, and only for what the control center needs: reading the team's work, a message, a card's answers, an approval's decision, and pausing or resuming a hire. Messages, answers and decision notes pass the membrane on the way. Importing, unlocking and making members stay with the app server and the wizard.
  - **Nothing on this machine is the operator just for being on this machine.** The old engine trusted any request from loopback. A hire's shell could approve its own approval with one `curl`. With Nous it can't.
- **A hire on a job.** Each run gets its own token, which is in the job and hashed at rest. It's good while the run is live and says who's asking. A hire can act only as itself, and only through its own runs.
  - A job's env carries `NOUS_API_URL`, `NOUS_RUN_TOKEN`, `NOUS_RUN_ID`, `NOUS_MEMBER_ID`, `NOUS_COMPANY_ID` and `NOUS_WAKE_REASON`, and when they apply `NOUS_TASK_ID`, `NOUS_WAKE_MESSAGE_ID`, `NOUS_WAKE_CARD_ID`, `NOUS_APPROVAL_ID` and `NOUS_APPROVAL_STATUS`. The old engine's `PAPERCLIP_*` names come beside them, for workers outside Horos that read those.
- **A hire's mailbox key.** One per hire, in `~/.ogdoad/nous/keys/<hireId>.key`. It's what Horos seats and live workers use to take jobs, never to call the API.

## What it keeps

All of it is in one encrypted file, in plain tables.

| Table | Holds |
|---|---|
| `companies` | name, the identifier prefix (`ABC`), the next task number |
| `members` | the team: name, role, title, what they can do, `idle` / `working` / `paused` / `let_go` |
| `rooms` | name, brief, status, lead, colour, archived |
| `tasks` | room, parent, number (`ABC-12`), title, description, status, priority, assignee (a member or the operator), author, the run that holds it, when it started, finished or was dropped |
| `messages` | a task's talk: author (member or operator), body, the client's request id (so a retry is one message), time |
| `docs` | a task's documents by key, with a revision number |
| `cards` | questions for the operator: kind, title, the questions, status, the answer |
| `approvals` | what's asked, by whom, for which tasks, the decision and its note |
| `runs` | a member's turn at work: why it woke (and the message or approval behind it), status, the job's lease, the summary it closed with |

Times are ISO-8601 UTC with milliseconds. Ids are UUIDs. Objects carry the fields that mean something, about a dozen for a task where the old engine had about 90.

## The API (`/v1`)

The API is plain JSON. A list is always `{ items }`; a thing is an object. Errors read `{ error: "<code>", message: "<a plain sentence>" }`.

| Area | Routes |
|---|---|
| Itself | `GET /v1/health` (always open: `{ ok, locked }`) · `POST /v1/unlock {key}` (operator) |
| Companies | `GET/POST /v1/companies` · `GET /v1/companies/:co` |
| The team | `GET/POST /v1/companies/:co/members` · `GET/PATCH /v1/members/:id` (`{paused}`) · `GET /v1/me` (a hire) |
| Rooms | `GET/POST /v1/companies/:co/rooms` · `GET/PATCH /v1/rooms/:id` |
| Tasks | `GET/POST /v1/companies/:co/tasks?room=&assignee=me\|<memberId>&open=&limit=` · `GET/PATCH /v1/tasks/:id` · `POST /v1/tasks/:id/claim` · `POST /v1/tasks/:id/release` · `GET /v1/tasks/:id/context` |
| Talk | `GET/POST /v1/tasks/:id/messages?newest=&limit=` |
| Documents | `GET /v1/tasks/:id/docs` · `GET/PUT /v1/tasks/:id/docs/:key` |
| Cards | `GET/POST /v1/tasks/:id/cards` · `POST /v1/cards/:id/answer` |
| Approvals | `POST /v1/companies/:co/approvals` · `GET /v1/approvals/:id` · `POST /v1/approvals/:id/decide {approve, note}` |
| Waiting on you | `GET /v1/companies/:co/waiting`: open cards, pending approvals, failed runs |
| Runs | `GET /v1/companies/:co/runs?live=1` |
| Events | `GET /v1/companies/:co/events` (Server-Sent Events) |

**The translator** answers `/api/...` (the old routes, in the old shapes) and the old event socket. It also serves the mailbox protocol at `/mailbox/v1/...`, so Horos seats and live workers keep working. It maps onto the same handlers, so there's one engine with two vocabularies. Ogdoad itself (the app, Horos, the briefs) speaks only `/v1` since 0.2.0; the translator stays for workers built for the old routes, and `contract/` tests it.

## The work loop

**What wakes a hire.** Each of these starts a run:
- a task given to it;
- the operator's message on its task;
- a mention, `[@Name](agent://<id>)`;
- an answer to its card;
- a decision on its approval, either way;
- a job it closed with the task still open, which starts a repair run asking it to finish properly.

A run for the same hire and task that's already waiting absorbs the new reason instead of starting a second run.

**Leases and queues:**
- A hire has one run at a time. The next one waits its turn and doesn't time out behind a busy seat.
- A job's lease renews on every heartbeat or log. If a lease runs out, the job goes back to the queue rather than failing the run.

**Task rules:**
- `in_progress` needs someone on it.
- A hire can't leave a task `in_review` unless a card or an approval owns the next step.
- Claiming moves a task to `in_progress` for one hire only; another hire trying gets `409`.
- Releasing puts it back to `todo`.

**Hiring rules:**
- Only the operator creates members. A hire that tries is refused with the way to ask instead.
- A hire asks with an approval of type `hire_agent` (`payload.name` required), or the old engine's `POST /api/companies/:co/agent-hires`. Asking creates nobody, and neither does a no.
- The operator's yes creates the member, writes its mailbox key, and puts its id on the approval as `payload.memberId`. Whoever asked is woken with the decision and seats the new member's harness through Horos.

## After the switch: what Nous grows into

These were chosen by the operator on 2026-10-14, after a survey of what's current in agent engines, protocols and agent security. All sixteen are on the roadmap. The move to Nous comes first, then these.

**How hires reach Nous**
- **Nous as an MCP server.** Typed tools for tasks, talk, cards and approvals, instead of HTTP calls taught through prompts. Each hire sees only the tools its run's token allows. Cards become native question forms.
- **Handoff packets.** Every run ends with a checklist (pass or fail), the next step and open questions. The next wake starts from them, whichever hire gets it.
- **Durable runs, self-healing.** Steps are journaled in the same store. A crash resumes instead of redoing work. A stalled run is restarted from its handoff, or reassigned.
- **An ACP driver in Horos.** Harnesses that speak the Agent Client Protocol give the watch structured permission requests. Reading the screen stays for the rest.

**Privacy at the edge**
- **The membrane at the model egress.** A local gateway that **every cloud hire's model traffic passes through, always.** Stand-ins are applied to everything that leaves, including the files a hire reads on this machine, and canary identities raise the alarm if a real one crosses. A harness that can't be routed through the gateway can't be a cloud hire in a room with real records.
- **The Rule of Two at dispatch.** A run that would read untrusted input, touch sensitive data and act outward is split into a reader and an actor, or else its outward acts wait for the operator.
- **Taint on talk and documents.** Anything from outside is marked. A run that has read it can't assign work, approve or send out without the operator.
- **Containment per hire.** Each run's filesystem and network are limited to its room and the gateway, enforced outside the hire. Windows' agent containers are new, so they get verified first.

**Trust and the operator's attention**
- **The trust ladder.** Autonomy is set per hire and per kind of work. **A new hire, and a hire whose model or harness has changed, starts with everything outside reading its own room asking first.** It climbs only through clean, accepted runs, and an incident sends it down. The watch reads its thresholds from the ladder.
- **An attention budget and digests.** Low-risk questions come in digests at times the operator picks, and only urgent ones interrupt.
- **A local two-stage watch.** A fast local model screens permission prompts and a second looks closer at what the first flags. It sees the operator's rules and the action, never the hire's persuasion.
- **Signed approvals (mandates).** An approval binds the exact action, so it can't be replayed on a changed one, and standing approvals are bounded. **They're signed with a hardware security key, with the operator's phone passkey as an optional second way** (both use WebAuthn). The same key signs the log's checkpoints.

**Learning and proof**
- **A lessons bank that becomes skills.** Lessons come from the operator's accepts and rejects. A procedure that works again and again becomes a skill the operator reviews, mounted into every harness.
- **Company facts with time.** Facts carry valid-from and valid-to dates and can be searched by words and by meaning, inside the same encrypted store.
- **A tamper-evident log and receipts.** Every decision, run and approval goes into a Merkle log whose checkpoints the operator's key signs, and every finished run leaves a signed receipt.
- **Probation by replay.** A new model or harness replays real past tasks, with stand-ins and in a sandbox, before it gets live work.

## Milestones

1. **Done (2026-10-14): the store, the keys, the core API.** Companies, the team, rooms, tasks and talk, natively and through the translator. The contract's room and talk tests pass.
2. **Done (2026-10-14): documents, cards, approvals, the waiting feed, live events.**
3. **Done (2026-10-14): the work loop.** Runs, jobs, leases, the mailbox, run tokens, claim and release, and the wake rules. The whole contract passes on Nous: all 26 tests, the three improvements included, in about a second (the old engine takes about forty).
4. **Into Ogdoad: on the practice copy (2026-10-14).** Horos keeps a practice Nous up (port 3120), and a practice app runs on it (port 3103). The app hands Nous its key on unlock, signs everything it sends or proxies with the operator token, and seeds a made-up company the first time. A practice copy with a team of its own never sees the real hires: Horos is shared, so its view of Horos is empty. The installer sets Nous up for new installs since 0.2.0.
5. **Moving in: the importer (2026-10-14).** `nous/dist/importPaperclip.js` reads from the old engine through its own API, read-only. It writes through Nous's operator-only import, keeping every id, number and time, carrying each member's mailbox key across and waking nobody. Run again, it updates instead of duplicating. It prints counts only and fails if the two engines disagree. Tested on the contract engines: 32 companies, counts equal on two runs, and 169 field-by-field checks with no differences. The live import happens on switch day.
6. **Done (2026-10-18, 0.2.0): the switch.** The app, Horos's wizard and seats, and the hires' briefs speak `/v1`; the browser reaches Nous at `/nous/v1`, and its live feed is Nous's own event stream. Jobs carry `NOUS_*` credentials. The installer sets Nous up from inside the package, and the old engine (`core/`, `runtime/`) has left the repo. Tested: the app 121/121, Horos 38/38, Nous 14/14, the contract 27/27 on Nous, and 37/37 end to end on a throwaway Nous with the practice app, SOPHIA working through her mailbox.

## Moving in from 0.1 (Paperclip)

An install from 0.1 ran on Paperclip. `npx ogdoad` at 0.2 doesn't move it without asking: it says what changes and stops.

1. `npx ogdoad setup --new-engine` moves the install onto Nous. The operator's books (Money, Work, dashboards) carry on as they are. The old engine's entry and the hires seated on it leave Horos's roster; the old engine's data (`~/.paperclip`) is left untouched, and SOPHIA's record is kept aside as `~/.ogdoad/sophia.before-nous.json`.
2. Open the app and unlock: that hands Nous its key.
3. To bring the old company's tasks and talk across, run the old engine on a spare port for a moment (`PORT=3110 npx paperclipai@2026.1005.0 run` reads `~/.paperclip` as before), then:

   ```sh
   node ~/.ogdoad/install/ogdoad/nous/dist/importPaperclip.js --from http://127.0.0.1:3110 --to http://127.0.0.1:3100 \
     --token-file ~/.ogdoad/nous/operator.token --keys ~/.paperclip/live-agent/keys
   ```

   It only reads from the old engine, keeps every id, number and time, wakes nobody, prints counts only, and fails if the two engines disagree. Stop the old engine afterwards.
4. Choose SOPHIA again: `npx ogdoad sophia` (with `--company <id>` to put her in the company just brought across).
