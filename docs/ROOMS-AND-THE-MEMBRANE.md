# Rooms, the dispatcher, the membrane and the watch

The operator's idea (2026-10-10). Status: steps 1 to 4 are built: the rooms, the membrane, the watch's gate and the dispatcher (2026-10-10 to 2026-10-12; see "as built" below and `CONTROL-CENTER.md`). The Laya fine-tune is still ahead.

A job moves from the operator to the best mix of hires and back again. The hires talk to each other and to the operator in a live room, so the business gets done in the open. No real identity ever reaches a cloud model, and anything risky waits for the operator.

## A job, end to end

1. **The job.** The operator (or SOPHIA) writes it in a project room.
2. **The lineup.** A local dispatcher proposes which hires take which part, and which parts must stay local. The operator approves the lineup, since hiring is a director-key act.
3. **The membrane, out.** Locally, every real identity in the brief becomes a stand-in.
4. **The check.** A Flow card shows the brief exactly as the cloud will see it, stand-ins highlighted, with **Send**, **Edit** and **Keep it local**. It clears only by doing, and what's sent is logged in the crossings log.
5. **The work.** The hires work in the room on the stand-in version, two or more at once on different parts, talking to each other and to the operator.
6. **The membrane, back.** Locally, the finished work gets its real details back in the right places, and a validator checks every stand-in.
7. **The review.** The operator reviews the finished work with its real details back in place. Only then does it reach the books, the artifacts or the outside world.

## Project rooms

- **One room per project, built on the engine's issue threads.**
  - A project has a parent issue, and each part of the job is a child issue.
  - The room is all of those comment threads merged in time order, so each part shows as its own lane.
  - The engine already wakes an agent when a comment mentions it (`[@Name](agent://<id>)`, wake reason `issue_comment_mentioned`). Agents can already talk to each other this way; the room makes it visible.
- **Live.**
  - Messages stream in as they're posted.
  - Each hire's Horos state shows as presence: working, waiting on you, idle, stopped.
  - A hire that's working shows as typing.
- **The operator takes part.** They can post, mention a hire, answer question cards and approvals inline, and pause a hire (Horos quiet).
- **The room's record holds stand-ins only.** Real details are put back only on the operator's screen. See the invariant below.

## The dispatcher (local)

- **In:**
  - the job, already through the membrane, so the dispatcher works on stand-ins too
  - the roster: each hire's harness, whether it runs locally or in the cloud, what it's good at, its cost and its current load
  - past jobs and how they went
- **Out:** a lineup as JSON, `{ part, hire or harness to hire, why, tier }`, with the parts that must stay local marked.
- **Rule:** any part that needs Tier 0 data (money, client records, notes) goes to a local seat. Cloud hires get stand-ins only.
- **Model:**
  - `qwen3.5:9b` in Ollama, already on the operator's machine, with structured output. No download needed to start.
  - Arch-Router-1.5B (Katanemo) does almost exactly this: routing rules written in plain language. But its licence ("katanemo-research") isn't clear enough for a public product.
  - The Qwen3 embedder answers "have we done this before?".

## The membrane

**Invariant:** real identities never enter the shared record. They're replaced on the way in, and only put back on the operator's own screen and in the finished local artifact.

### Out, in three passes, surest first

1. **What the books already know.** Client and participant names, addresses, emails, phones, ABNs, NDIS numbers and bank details come from Money and Work. Each becomes a stable stand-in, `C-0412` style, from the same `standIn()` the calendar uses. Matching is exact and fuzzy: any case, possessives, first name only.
2. **Patterns with checksums:** ABN (mod 89), TFN, BSB and account, Medicare, card numbers, email addresses, phone numbers, Australian addresses.
3. **A local model backstop**, for names the books don't have.
   - Candidates:
     - OpenAI's Privacy Filter (Apache-2.0, 1.5B MoE, eight categories). Use only the official repository; copies with similar names have carried malware.
     - A GLiNER PII model.
   - What it finds goes to the operator as "possibly sensitive". It's never silently replaced or silently passed.

Quasi-identifiers, such as suburb plus age plus a condition, are flagged for the operator, not replaced.

### Back

- Stand-ins get their real details back, locally.
- **The validator:**
  - Every stand-in in a reply must exist in the map.
  - A mangled stand-in (`C-412`, "Client 0412") is flagged for the operator.
  - A real value in a cloud hire's message should be impossible. If one appears, it's an alarm: the crossing is marked and the hire paused.
- The stand-in map lives in the encrypted Money database. It's never in the engine's database, which stays plaintext until BitLocker (see `LOCK-THE-DOORS.md`).

### The membrane as built (step 2)

- **One gate for every way out.** A room's message, brief and part; a comment on any task (SOPHIA's conversation, the command line, a panel request: the app server answers `POST /api/issues/:id/comments` itself instead of passing it through); what's typed into a hire's terminal; and a new hire's first message.
  - A local model's terminal and a local hire's first message go as written: Tier 0 may stay local.
  - A question card's written answers and an approval's note leave with stand-ins, without a check, since they're part of an act the operator already chose.
- **Passes, in order:**
  1. Email addresses, so their letters are never split into names.
  2. The books: clients, participants and contacts (any case, possessives, a one-letter slip in a name of five letters or more, a title and a surname, a first name alone), the business's own name and accounts, and every kept email, phone, address, NDIS number, ABN and account number in any spacing.
     - A first name that's also a word (Will, Grace) counts only mid-sentence; at a sentence start it's flagged.
     - A first name two people share is flagged, not replaced. A surname alone is flagged.
     - The hires' own names and the engine's mentions are never touched.
  3. Patterns with check digits: phones, ABN (mod 89), TFN (mod 11, with "TFN" before it or written 3-3-3), Medicare (check digit), cards (Luhn), BSB and account, NDIS numbers, street and postal addresses, dates of birth.
  4. Hints, flagged and never replaced: an age, a health condition, a place. `quasiWarning()` in `app/src/server/membrane/quasi.ts` is the operator's rule for when they add up (default: two kinds together).
  5. **The local model** (built 2026-10-11): OpenAI's Privacy Filter on the CPU in WSL (`models/membrane/`). It runs on whatever the passes above didn't take.
     - What it finds (a name the books don't have, an address, a secret) is flagged as possibly sensitive, never replaced by itself.
     - **Stand it in** on the check card gives the find a stand-in, and from then on it's matched like a name in the books.
     - It's an on-demand server on Horos's roster. The app wakes it while the operator types, or when a message is sent, and it rests after ten unused minutes.
     - If it doesn't answer, the check card says so, and the books and the patterns still apply.
- **Stand-ins** are a family word and four digits: `C-` (a client, participant or contact; the calendar's own stand-in where it's free), `ME-`, `EMAIL-`, `PHONE-`, `ADDR-`, `ABN-`, `NDIS-`, `BANK-`, `TFN-`, `MEDICARE-`, `CARD-`, `DOB-`. They're kept in `standins` in the encrypted books, one per detail, so a person reads the same in every message.
- **The check: the operator decides, not the model** (the operator, 2026-10-11: "the model isn't responsible, the human at the end of the chain is"). Anything changed or flagged is held in `outbox` (encrypted, with the operator's own words) and shown as it would leave.
  - Every marked piece can be clicked and decided on its own. A stand-in: keep it, use the real words, or write something else. A flag: stand it in, leave it, or write something else.
  - **Edit what goes** rewrites the outgoing text outright; **Change your words** edits the original and has the membrane read it again.
  - **Approve** sends exactly what's shown; **Deny** sends nothing; **Keep it here** makes a room message a note only the operator sees.
  - A real detail the operator writes back into what goes is allowed, knowingly. The card names each one, with the stand-in it would have used, and Approve takes a second yes. The server enforces that too.
  - Each decision (approved or denied, edited or not, real details sent knowingly) is noted as a labelled example for a local decider later.
  - What's sent is exactly what was shown (a digest of it); if the books changed in between, the card shows the new version instead.
  - It shows where it was sent from (the room, under the box) and as a Flow card that clears only by deciding.
  - The practice copy's books are made up, so everything it sends to the real team waits for a check.
- **Back.** A room's stand-ins read as the real names on the operator's screen, dotted, with "As the team sees it" one click away. SOPHIA's conversation, her replies in the command line and "What the cloud has seen" read them back too.
  - Every hire's message is checked: a stand-in nobody has, one written wrong (`C 4821`, `C-482`, "Client 4821"), and a detail Ogdoad stood in before, written out.
  - **A client's real detail in a cloud hire's message is an alarm**: noted once, the hire paused through the engine, a desktop alert, and an urgent Flow card. Resuming is the operator's button in the room. The business's own details aren't alarms (the team works for it).
  - **A local hire may hold real records, but not where cloud hires read them.** Its message with a client's real detail, in a room that has a cloud hire, is an alarm too (without a pause): the cloud can read it now.
- **Not yet:** a watch that reads new messages without the room being open (step 3), and the hires' documents on the Artifacts shelf read back with real names.

## The watch (local heartbeat)

- **Inputs.** It runs every 30 seconds or so, and on every event. It reads:
  - the rooms' new messages
  - Horos's hire states
  - any permission prompt waiting in a hire's terminal
  - the crossings log
- **It coordinates.**
  - Two hires on the same files or records get a heads-up in the room.
  - A hire stuck too long gets a nudge, or the operator hears about it.
  - Each project gets a one-line summary for Pulse.
- **It holds anything risky.** Proposed actions are sorted into these kinds:
  - **spending**
  - **investing**
  - **outward:** sending, posting, pushing, publishing
  - **destructive:** deleting, overwriting, force-pushing, dropping tables, `rm -rf`
  - **secrets**
  - **hiring**
  
  Any of these is held and becomes a blocking Flow card for the operator.
- **The model is the smoke alarm, not the lock.** Spending, pushing, deleting and the rest are refused by the server-side gates (the director key) without the operator's signature, whatever the model thinks. A guard model gives a probability; a gate gives a guarantee.
- **The choke point is the harness's own permission prompt.**
  - Hires run with permission prompts on. Horos already sees each prompt in the terminal.
  - The watch reads the prompt. It lets plainly safe ones through under the operator's policy and holds the rest as a Flow card.
  - Horos types the operator's answer back. The keys path exists already.
- **Model:**
  - The same `qwen3.5:9b` to start.
  - Later, Laya's act-or-escalate decider, fine-tuned on the operator's own decisions. Every Approve or Turn it down in Flow is a labelled example.
  - Guard models that read a policy in the prompt (gpt-oss-safeguard, Shieldstral) are candidates once they've been tested on real traces.
- **The GPU is shared with other local work.**
  - A 9B model at Q4 needs about 6.6 GB.
  - The membrane's model backstop runs on the CPU.

### The watch as built (step 3)

- **Every 8 seconds**, in the real app while the books are open, it looks at each hire Horos sees waiting on a decision.
  - It reads the prompt off the screen (`app/src/server/watch/prompt.ts`): a boxed dialog with numbered choices, a one-line prompt with its choices inline, or a line ending in (y/n). It reads the shape, not one harness's exact words.
  - It sorts what the hire wants by risk (`risk.ts`, rules only for now): deletes, sends out, spends, invests, secrets, starts agents, installs, web, writes, runs, reads.
  - It puts it in front of the operator as a Flow card (Pulse leads with it): **Allow once**, **Deny**, **Always allow** (only for low risk), **Open its terminal**.
- **The operator decides.** The card shows what their policy (`policy.ts`, `decide()`) would do.
  - Answering by the policy is off until they turn it on in Settings › The watch.
  - Even then it presses only "yes, once", only for what the policy allows, and never a kind on the floor (`ALWAYS_ASK`: deleting, sending out, spending, investing, secrets, starting agents).
  - A "yes" to a floor kind takes a second yes.
- **An answer is pressed only into the very same prompt** (its fingerprint, read again just before pressing). If the hire moved on or was answered in its terminal, nothing is pressed and the card goes.
- **Each answer is noted** (`watch_answered`: the kinds, what the policy said, what the operator chose, who answered), as labelled examples for a local decider (Laya) later. Settings shows the recent ones, and where the policy and the operator disagreed.
- **It reads the rooms too.** Once a minute, any room with new messages is read, which checks every hire's message and raises the alarm on a client's real detail, whether or not anyone opens the room.
- **Not yet:**
  - A local model's second opinion on a prompt the rules can't place (it would share the GPU with other local work, so it's off until there's a turn-taking plan).
  - Coordinating hires on the same files.
  - Per-project summaries for Pulse.

### The dispatcher as built (step 4)

- **In a room,** "Ask the dispatcher" has a local model (`models/dispatch/`: a small Qwen 3.5 via llama.cpp, on the CPU, on call through Horos) read the room as the engine holds it.
  - That's its name and brief (through the membrane: stand-ins only), the team (names, harness, cloud or local, role) and the parts it already has.
  - It proposes 1 to 5 parts, each with a hire (or nobody), why, and whether it needs the real records. Its output is constrained by a schema, so it's always a lineup.
- **The rule is code, not the model's opinion.** A part that needs the real records goes only to a local hire.
  - The app moves it there if the model forgets (`checkLineup`). If there's no local hire, it says so.
  - The card won't let the operator break it, and the server refuses an approval that does (`refuseBroken`).
- **The operator decides.** Any part can be changed (its words, who takes it, whether it needs real records), dropped or added, then the lineup is **approved** or **denied**.
  - Approved parts are added one by one, through the membrane like anything else.
  - A real-data part's brief tells its local hire to hand back only stand-ins or totals, because cloud hires read the room.
  - Each decision (approved or denied, how much was changed) is noted as a labelled example.
- **First real run** (a made-up newsletter job, 28 s on the CPU): the model kept the real-records steps (invoice totals, names in the draft) with local hires on its own. One finding was a cloud "finalize" step after a step that wrote real names. Hence the hand-back rule in the prompt and the briefs, and the local-hire alarm in the membrane.

## Build order

1. **Rooms.** A live room per project over the issue threads, with Horos presence. No models. *Built 2026-10-10.*
2. **The membrane, out and back.** Passes 1 and 2, the check card, putting real details back, and the validator. *Built 2026-10-10.*
3. **The watch's gate** on permission prompts, with the policy file. *Built 2026-10-12.*
4. **The dispatcher's lineups.** *Built 2026-10-12.*
5. **The model backstop** for the membrane (*built 2026-10-11*), and the Laya fine-tune.

## Decisions for the operator

- **Downloads.** The Privacy Filter or a GLiNER model, and later a guard model. Each needs the operator's yes.
- **The risk policy.** What the watch lets through without asking.
- **When nobody answers.** What happens when the watch holds something and the operator doesn't answer. The default is that it stays held.
