# Nous: Ogdoad's engine

**Nous** is Ogdoad's own engine. It keeps the company's rooms, tasks, talk, documents, question cards and approvals, and wakes a hire when there's work for it.

It replaces the Paperclip engine Ogdoad started on. It's inspired by Paperclip the way Horos is inspired by Herdr: our own code, written from what Ogdoad needs. The contract it has to keep is in [ENGINE-CONTRACT.md](ENGINE-CONTRACT.md).

> In the old cosmology, Nous is the mind: the first to come forth, the one that knows. SOPHIA runs the company and Horos guards the boundary. Nous holds what the company knows and wakes whoever's needed.

## Decided (2026-10-14)

| | Choice | What it means |
|---|---|---|
| **Locking** | After first unlock | Nous's data is encrypted on disk, always. Once the operator has unlocked Ogdoad since the machine started, the team keeps working while the screen locks. After a reboot, the team waits for the first unlock. |
| **Process** | Its own service under Horos | Horos keeps Nous up, like the app. Updating or restarting the app never interrupts the team. The app hands Nous its key on unlock, over a private local channel. |
| **API** | Ogdoad's own, plus a translator | Nous speaks an API designed for Ogdoad (`/v1/...`). A translator answers the old routes (`/api/...`), so the app, Horos's wizard and every hire keep working on the day it switches over. They then move to the new API one at a time. |
| **Name** | Nous | |

## Keys and who's who

- **The data key.** On unlock, the app derives Nous's key from the vault (`vault.key("nous")`) and posts it to `POST /v1/unlock`. Nous keeps the key in memory only, until the process ends.
  - Until then, Nous answers `423 locked` to everything except health.
  - The data lives in one SQLCipher file, `~/.ogdoad/nous/nous.db`.
- **The operator.** Every operator request carries `Authorization: Bearer <operator token>`. The token is a file only the operator's own processes read (`~/.ogdoad/nous/operator.token`): the app adds it when it proxies the browser, and Horos's wizard reads it.
  - **Nothing on this machine is the operator just for being on this machine.** The old engine trusted any request from loopback. A hire's shell could approve its own approval with one `curl`. With Nous it can't.
- **A hire on a job.** Each run gets its own token, which is in the job and hashed at rest. It's good while the run is live and says who's asking. A hire can act only as itself, and only through its own runs.
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

**The translator** answers `/api/...` (the old routes, in the old shapes) and the old event socket. It also serves the mailbox protocol at `/mailbox/v1/...`, so Horos seats and live workers keep working. It maps onto the same handlers, so there's one engine with two vocabularies.

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

## Milestones

1. **Done (2026-10-14): the store, the keys, the core API.** Companies, the team, rooms, tasks and talk, natively and through the translator. The contract's room and talk tests pass.
2. **Done (2026-10-14): documents, cards, approvals, the waiting feed, live events.**
3. **Done (2026-10-14): the work loop.** Runs, jobs, leases, the mailbox, run tokens, claim and release, and the wake rules. The whole contract passes on Nous: all 26 tests, the three improvements included, in about a second (the old engine takes about forty).
4. **Into Ogdoad: on the practice copy (2026-10-14).** Horos keeps a practice Nous up (port 3120), and a practice app runs on it (port 3103). The app hands Nous its key on unlock, signs everything it sends or proxies with the operator token, and seeds a made-up company the first time. A practice copy with a team of its own never sees the real hires: Horos is shared, so its view of Horos is empty. Still to do: the installer setting Nous up for new installs.
5. **Moving in.** An import from the old engine through its own API, counts checked, old data untouched.
6. **The switch.** The app, the wizard and the briefs move to `/v1`. The old engine leaves the repo.
