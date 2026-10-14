# The engine contract

Ogdoad runs on an engine: the part that keeps the company's rooms, tasks, talk, questions and approvals, and wakes a hire when there's work for it. Today that engine is a pinned snapshot of [Paperclip](https://github.com/paperclipai/paperclip). Ogdoad is replacing it with an engine of its own, the way Horos is Ogdoad's own take on what [Herdr](https://github.com/herdrdev/herdr) does.

This document is the contract the new engine has to honour. The tests in `contract/` hold it to that.

- **The contract is the floor, not the ceiling.** It's what Ogdoad's app, its UI, Horos and the hires rely on today, measured from their code. The new engine must keep all of it, so nothing breaks the day it switches over.
- **Everything above the floor is ours to do better.** The last section lists where the new engine improves on the old one. Some of those are written as tests already: they fail on Paperclip by design, and they must pass on Ogdoad's engine.

## Running it

```sh
npm install                  # once, at the repo root
npm run contract             # boots an isolated engine, runs every test, stops it
npm run contract -- --keep   # leaves it running: the next run starts in seconds
CONTRACT_ENGINE=nous npm run contract             # against Nous, Ogdoad's own engine (docs/NOUS.md)
ENGINE_URL=http://127.0.0.1:3410 npm run contract   # against an engine that's already up
```

`contract/engine.mjs` boots the engine with Ogdoad's own installer into homes and ports of its own: the temp folder `ogdoad-contract`, and ports 3410 (engine), 3411 (app), 3412 (Horos) and 3413 (mailbox). It never touches a live install. The first boot downloads the engine, which takes a few minutes; after that it's quick.

The tests act as each kind of client. As the operator, they call from this machine with the engine's own Origin. As a hire, they take a job from its mailbox and use the run credentials it carries.

Today the suite runs **26 tests: 23 pass on Paperclip, and 3 are improvements it doesn't have** (`todo` there, real tests on Nous).

## Who uses the engine, and for what

### The app server (`app/src/server`)

The app server's engine calls are all in `rooms.ts`, `flow/team.ts`, `teamArtifacts.ts`, `crossings.ts` and `main.ts`. They're made without credentials, as the operator on a local-only engine.

| Call | Used for | Fields read |
|---|---|---|
| `GET /api/companies/:co/agents` | the team, room members, who may be paused | `id name status role title capabilities` |
| `POST /api/agents/:id/pause` | the membrane's alarm pauses a cloud hire | any 2xx |
| `GET /api/companies/:co/issues?projectId=&limit=` | a room's tasks | `id identifier title status projectId parentId assigneeAgentId assigneeUserId createdByAgentId createdAt updatedAt` |
| `GET /api/companies/:co/issues?assigneeUserId=me&limit=` | tasks for the operator, in Flow | `id identifier title status priority` |
| `GET /api/companies/:co/issues?limit=30` | recent tasks, to find documents | `id identifier` |
| `GET /api/issues/:id` | a held message's label; who reads a task | `identifier title assigneeAgentId` |
| `POST /api/companies/:co/issues` | a room's thread, a part (sub-task) | sends `title description projectId parentId status assigneeAgentId`; reads `id identifier title status createdAt updatedAt` |
| `GET /api/issues/:id/comments?order=desc&limit=` | a room's timeline, the membrane's inbound check | `id body createdAt authorAgentId authorType` |
| `POST /api/issues/:id/comments` | a message, once past the membrane | sends `body clientRequestId` |
| `GET /api/issues/:id/documents` | the Artifacts shelf | bare array; `id issueId key title createdByAgentId createdByUserId updatedAt` |
| `POST /api/issues/:id/interactions/:iid/respond` | answer a question card (answers pass the membrane) | status passed through |
| `POST /api/approvals/:id/approve` and `.../reject` | decide (the note passes the membrane) | status passed through |
| `GET /api/approvals/:id` | who receives a decision note | `requestedByAgentId` |
| `GET /api/companies/:co/projects`, `GET /api/projects/:id` | rooms | `id name description status leadAgentId color updatedAt archivedAt` |
| `POST /api/companies/:co/projects` | open a room | sends `name description status leadAgentId` |
| `GET /api/companies/:co/live-runs` | who's working on what | `id agentId issueId status startedAt` |
| `GET /api/companies/:co/attention?all=true` | the team's side of Flow | `{items}`: see below |

From each attention item, Flow reads:
- `sourceKind`;
- `subject.kind`, `subject.id`, `subject.title` and `subject.href`;
- `whyNow` and `severity`;
- `relatedIssue.id`;
- `originAgentName`;
- `dismissal.isActive` and `snoozedUntil`;
- `detail.kind`, `detail.firstQuestionText`, `detail.questionCount` and `detail.createdByAgentName`.

Flow special-cases these `sourceKind` values: `issue_thread_interaction`, `approval`, `decision`, `join_request`, `recovery_action`, `failed_run`, `budget_alert` and `agent_error_alert`.

The app also reads the engine's hourly database dumps from disk, to seal them (`sealedBackups.ts`). Ogdoad's own engine will keep its data in the vault, so there will be nothing left to seal separately.

### The web UI (`app/src/web`)

The browser reaches the engine through the app's proxy at `/api/*`.

| Call | Used for | Fields read |
|---|---|---|
| `GET /api/companies/:co/agents` | names, the lead picker | `id name status` |
| `POST /api/agents/:id/resume` | resume a paused hire | any 2xx |
| `GET /api/companies/:co/issues?limit=40` | the team's tasks | `id identifier title status assigneeAgentId assigneeUserId updatedAt` |
| `GET /api/issues/:id/comments?order=desc&limit=` | SOPHIA's replies, a task's thread | **bare array**; `id body createdAt authorType authorAgentId` |
| `POST /api/issues/:id/comments` | talk (held by the app if it names someone) | sends `body clientRequestId` |
| `GET /api/issues/:id/documents/:key` | read a document | `body` |
| `GET /api/issues/:id/interactions` | question cards | **bare array**; `id kind status title createdByAgentId createdAt payload{title submitLabel questions[{id prompt helpText selectionMode required allowOther options[{id label description freeText}]}]}` |
| `POST /api/issues/:id/interactions/:iid/respond` | answer | sends `{answers:[{questionId optionIds otherText}]}` |
| `GET /api/approvals/:id` | an approval card | `id type status payload` |
| `POST /api/approvals/:id/approve` and `.../reject` | decide | sends `{decisionNote}` |
| WebSocket `/api/companies/:co/events/ws` | live updates in rooms | `{type, payload}`: `activity.logged` (`entityType entityId projectId \| details.projectId`), `heartbeat.run.status` (`issueId`) |

### Horos (`horos/src`)

SOPHIA's first-launch wizard makes these calls:
- `GET /api/health`;
- `POST /api/companies {name}`, reading `id name issuePrefix`;
- `GET /api/companies/:co`;
- `POST /api/companies/:co/agents {name role title adapterType capabilities}`;
- `POST /api/companies/:co/issues {title description status priority assigneeAgentId}`, reading `id identifier`.

Horos seats speak the **mailbox protocol** (`paperclip-live-agent/1`):

| Route | What it does |
|---|---|
| `GET /v1/health` | open to anyone |
| `GET /v1/next?wait=N` | needs a Bearer key; answers 200 with a job or 204 with nothing (it long-polls) |
| `POST /v1/jobs/:id/heartbeat` | answers `{cancel, settled}` |
| `POST /v1/jobs/:id/log` | takes `{stream, text}` |
| `POST /v1/jobs/:id/done` | takes `{ok, summary, error, result}` |

A job is `{jobId, protocol, runId, agentId, agentName, companyId, taskId, wakeReason, prompt, env, leaseSec}`. Its `env` carries:
- `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (the run's credentials) and `PAPERCLIP_RUN_ID`;
- `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID` and `PAPERCLIP_TASK_ID`;
- `PAPERCLIP_WAKE_REASON`, and when they apply, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_APPROVAL_ID` and `PAPERCLIP_APPROVAL_STATUS`.

Each agent's key is a file at `<engine home>/live-agent/keys/<agentId>.key`.

### The hires

Hires are told to send `Authorization: Bearer $PAPERCLIP_API_KEY` and `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID` on every write, and to use:

| Call | What it does |
|---|---|
| `GET /api/agents/me` | who am I |
| `GET /api/issues/:id/heartbeat-context` | the task's context |
| `POST /api/issues/:id/checkout {agentId, expectedStatuses}` | claim the task. It moves to `in_progress`; a second claim by the same hire is a no-op; **409** if another hire holds it. |
| `POST /api/issues/:id/comments` | talk |
| `PATCH /api/issues/:id {status, comment, ...}` | update the task |
| `POST /api/companies/:co/issues {parentId, ...}` | a sub-task |
| `POST /api/issues/:id/release` | let it go: `in_progress` goes back to `todo` |
| `PUT /api/issues/:id/documents/:key {title, format, body}` | write a document |
| `POST /api/issues/:id/interactions {kind: "ask_user_questions", title, payload: {version: 1, questions}}` | ask the operator |
| `POST /api/companies/:co/approvals {type, requestedByAgentId, issueIds, payload}` | ask for approval |
| `GET /api/openapi.json` | the whole API |

## The rules it keeps

- **The operator is "me".** `assigneeUserId=me` finds the operator's tasks. An operator-made task has `createdByUserId` set and no `createdByAgentId`. The operator's comments have `authorType` other than `agent` and no `authorAgentId`.
- **Identifiers look like `ABC-12`.** The prefix is the company's `issuePrefix`.
- **Times are ISO-8601 UTC with milliseconds and a `Z`.** They are compared as text, and mixed with Ogdoad's own `toISOString()` times.
- **List shapes:**
  - Comments, interactions and documents are bare arrays.
  - Attention is `{items}`.
  - Agents, issues, projects and live runs may be either (Ogdoad reads both), but bare arrays are what's returned.
- **Comments come newest first, and `limit` keeps the newest N.** The same `clientRequestId` twice is one comment, so a retry never posts twice.
- **Statuses:**

  | Kind | Values |
  |---|---|
  | Tasks | `backlog todo in_progress in_review blocked done cancelled` |
  | Rooms | `backlog planned in_progress completed cancelled` |
  | Hires | `paused` and `terminated` matter |
  | Runs | `queued running` (anything else has ended) |
  | Approvals | `pending approved rejected` |
  | Cards | `pending answered` |
  | Priority and severity | `critical high medium low` |

- **Statuses have rules.** A task can't be `in_progress` with nobody on it. A hire can't leave a task `in_review` unless something owns the next step: a card, an approval, or a reviewer.
- **What wakes a hire:**
  - assignment;
  - the operator's comment on its task, naming the comment;
  - an answer to its card;
  - a decision on its approval, naming the approval and how it went;
  - a job closed while its task is still open (a repair job asks it to finish properly).
- **The attention feed is what's waiting on the operator.**
  - A card shows as `issue_thread_interaction`: `subject.id` is the card and `relatedIssue.id` the task, with `detail.kind: "questions"` plus the first question and the count.
  - An approval shows as `approval`.
  - Once answered or decided, an item leaves the feed, and Flow clears it.
- **Not found is a 404 with a JSON `{error}`.**
- **The live stream:**
  - It carries `activity.logged` for changes to a task (`entityType: "issue"`, `entityId`).
  - It carries `heartbeat.run.status` naming the task (`issueId`) when a run ends.
- **The mailbox:**
  - It needs a key for anything but health.
  - It holds one job at a time per hire.
  - Calls on a settled job answer `{cancel: true, settled: true}`.
  - Another key's job is a 404.

## Where Ogdoad's engine does better

| | The engine Ogdoad started on | Ogdoad's own |
|---|---|---|
| **Data at rest** | Tasks, talk and runs sit in a Postgres that Ogdoad can't encrypt. | One store, in the vault (SQLCipher), next to Money and Work. When Ogdoad locks, the whole business locks; there's nothing separate to seal. |
| **Footprint** | Over a million lines, a 1.5 GB install, an embedded Postgres, a patch to stop it cleanly, an admin-token workaround, two more ports. | A part of the app, in one process. `npx ogdoad` installs in seconds. |
| **Mentions** | A mention is context only, so the hire it names isn't woken, though Ogdoad's rooms and briefs say it is. | **A mention wakes the hire it names** (test: `todo` until then). |
| **A rejection** | The hire is woken when an approval is approved, not when it's rejected. | **A rejection reaches the hire too, with the note** (test: `todo` until then). |
| **Run events** | A run's status names its task only when the run ends. | Every run event names its task, so a room shows a hire picking work up the moment it does. |
| **The membrane** | Sits in front, in the app. Anything that reaches the engine by another path isn't checked. | Built into how talk is stored: what leaves for a cloud hire is stood in at the source, and the real words never sit beside the stand-ins. |
| **Jobs** | Work goes engine → adapter → mailbox → Horos seat. A lost lease always fails the run. A second job for a busy seat can time out while it waits. | Jobs go to the hire's seat directly, queued per hire, never timing out behind a busy seat; a lost lease puts the job back in the queue. The mailbox stays, for live workers outside Horos. |
| **One way to finish** | Hires get two different "close the job" instructions. | One. |
| **Objects** | A task carries about 90 fields; Ogdoad reads about a dozen. | Lean objects with the fields that mean something, extended when something needs more. |
| **Who's the operator** | Anything on this machine: a request from loopback is the board, so a hire's shell could approve its own approval. | Whoever holds the operator's token: the app and Horos. A hire is only ever itself, on its own runs (test). |
| **The session cookie** | The app's proxy forwards the operator's vault session cookie to the engine. | The engine never sees it. (Fixed in the proxy now, ahead of the switch.) |
| **Errors** | Messages written for the engine's own UI. | Plain sentences, the way Ogdoad's own APIs speak. |

What the new engine leaves out, because nothing in Ogdoad uses it:
- the classic UI on :3100;
- the adapter plugin system, since the hire's seat is Horos;
- budgets, goals and org charts;
- routines and plugins;
- the secrets store;
- hosted (non-local) deployment.

Any of these can come back if Ogdoad needs it.

## Build order

1. **The contract.** Done: this document and `contract/`, 23 of 26 green on Paperclip.
2. **Ogdoad's engine, Nous** ([NOUS.md](NOUS.md)), **on the practice copy.** A part of the app on SQLCipher, answering the same routes, until the contract passes against it. That's all 25, the two improvements included.
3. **Jobs straight to Horos.** Wake-ups, runs and leases, with the mailbox kept for outside workers.
4. **Moving in.** An import from the old engine through its own API, every count checked, and the old data left untouched as a backup.
5. **The switch.** `core/` and `runtime/` leave the repo, the installer stops downloading an engine, and the README says "inspired by Paperclip".
