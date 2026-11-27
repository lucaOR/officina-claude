---
name: plan
description: Use when the user invokes /planner-companion:plan to co-design a plan on a live local page (decision cards, diagrams, tasks, ask threads, undoable changes) that ends in a plan.md, or /planner-companion:plan reopen <plan-folder> to resume an unfinished review.
argument-hint: "[--intent <file>] <what to plan> | reopen <plan-folder>"
---

# /planner-companion:plan

Adapted from superpowers (MIT), Copyright (c) 2025 Jesse Vincent

You co-design a plan with the user on a live local page. The page is the plan, rendered by a script from one JSON source that you only ever patch. The user succeeds when they feel they grasp what is going on and can review it critically. A wall of words, on the page or in the terminal, is a failure even when everything works.

It ends at `plan.md`, so write no product code.

`init` prints the plan folder's path and `md` prints Markdown. Every other CLI call prints one JSON line, and a call that fails at runtime prints `{"ok":false,"error":"<message>"}`. Exit 0 is success, 1 means diagnostics or an error to fix, and 2 is a usage error. `<plan>` is the folder `init` prints.

## 1. Start

If the argument is `reopen <folder>`, go to section 8.

Before your first question, read what the user pointed at and the code it touches, until you can say how it works today and what the change touches. Never ask what the project already answers. If the ask covers several independent subsystems, propose one plan per subsystem.

Create the plan folder. `--project` is your primary working directory, so the plan lands where the SessionStart hook looks even when the shell has moved into a subdirectory:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" init <slug> --title "<title>" --project "<primary working directory>"`

With `--intent <file>`, the file is an intent that an earlier session settled, usually the output of a refine skill. Read the whole file before your first question, then run the `init` call above with `--intent "<file>"` added. Map it like this:
- Lines tagged `(user)` settle the goal, the constraints (its Non-goals) and the interview answers. Its Done-criteria seed the scenarios and `reviewFocus`.
- Lines tagged as a guess, its Open questions and its How-details become `open` cards.
- Interview only on what the file leaves unanswered.
- A plan decision that would change its DEFINITIONS goes to the user and is never applied, because changing DEFINITIONS is the user's pivot.

The plan never edits the intent file, and a patch must never `set` the `intent` field, which only `init` writes.

Interview in the terminal, one question per message. End each question with **Recommended:** your answer and a one-line reason, so that "yes" settles it. The one exception is why they want this: ask it open, with nothing to pick from, until you know. Ask only what changes what gets built and what neither the request nor the project answers. Cover why now, what success looks like, goals, non-goals and anti-goals. Stop when every open point left is a choice between options you can name, because those become cards.

## 2. Open the page early

Start the page before you write the first card:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" start <plan>`
Give the user the printed `url` in one line, then arm the watcher (section 4).

## 3. Decisions as open cards

Every decision that changes what gets built goes on the page as a card, never into the terminal. The overall approach is the first card. Only a decision the user already made goes in as `settled`, with their reason as `whyPick`. Every other one goes in as `open`, even when you are sure.

An open card carries:
- `options`: two or three real ones, each with a `why` that names what it trades off. `recommended` is your pick.
- `slots.scale` (what happens at scale or when it fails) and `slots.dataFrom` (where the data comes from), always. Add `userSees`, `names`, `dragsAlong` or `terms` only when they apply.
- `more`: `why` the decision exists, `touches` as `file:line`, and `related` codes.
- `nodes`: the ids of the diagram nodes it decides, which links card and diagram on hover.

Split the decisions into domains when there are more than about 10 of them or the plan touches more than one service; below that, use a single domain. A domain is a group of decisions that can be judged without the others. Its `title` is the question it answers, `checks` lists what the review must check, and `diagram` shows how it works. Also write the `goal`, a three-line `summary`, `checkFirst`, the end-to-end `flow` with a `phaseDomains` entry per phase, and the `entities`.

Write the source with author patches, which are your own edits and log no change:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" apply <plan> <patch.json> --kind author --summary "<one line>"`
A patch is `{"set": {"<top-level field>": value}, "upsert": [element]}`. `upsert` replaces a decision, task, scenario or domain by its id, so send the whole element, id included. A new element takes the next free code, and a code is never reused: retire an element with `removed` instead of deleting it. A domain id is a slug such as `retry-policy`. Keep patch files outside `<plan>`, which holds only plan state. The schema is in `${CLAUDE_SKILL_DIR}/reference/source-format.md` and the diagram rows are in `${CLAUDE_SKILL_DIR}/reference/diagram-rows.md`.

An author patch may set `state`, `pick` and `whyPick` on a new decision only. On an existing one it must repeat them unchanged, or it fails with `pick-by-author`, because a stale copy would silently undo the user's pick. Settle an existing decision with `pick` (section 4), which takes the option's `why` as `whyPick`. Change a settled decision's pick or `whyPick` with `apply --kind change`, leaving out `--question` when no page question asked for it.

Check every new or changed diagram before you apply it. Output starting `{"ok":true` means it renders:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" diagram <spec.json> | cut -c1-200`

After each batch, say in one terminal line which codes are new and which card to pick first.

## 4. Listening loop

Arm the watcher with the Bash tool's `run_in_background: true`, and keep exactly one running:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" watch <plan>`

It exits 0 when a page question is waiting, and 4 with `{"stopped":true}` when the server is gone. Do not poll it. When it exits 0, print the oldest waiting question:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" next <plan>`
Handle it as below, and repeat `next` until it prints `null`. Then re-arm the watcher, every time. When it exits 4, do not re-arm it: tell the user the page is closed and that `/planner-companion:plan reopen <plan>` restarts it.

A question's `target` names what the user asked about. `D<n>`, `T<n>` and `S<n>` are elements. `summary:<n>`, `rule:<n>` and `focus:<n>` are entries of `summary`, `constraints` and `reviewFocus`, and `check:<domain>.<n>` is an entry of that domain's `checks`. `<n>` counts from 1, so `rule:3` is `constraints[2]`. `node:<diagram>.<node>` is a diagram node, where `<diagram>` is `flow`, `domain-<id>`, `entities` or `tasks`, the task graph's node `t<n>` is task `T<n>`, and a sequence's node `m<n>` is its n-th message row, counting from 1 and skipping actor and phase rows.

Every question ends in exactly one `answer`, `apply --question` or `ack`, so that none is lost. Handle it by its `kind`:
- `comment`: reply in its thread, short and specific, citing codes instead of restating them. Add `--suggest-change` when the answer exposes a real gap in the plan, because the user then turns the thread into a change request with one button.
  `node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" answer <plan> <qid> --text "<reply>"`
- `change`: patch what `text` asks of `target`, including the tasks and scenarios it invalidates, and apply it as a change. `apply` flags the remaining linked elements for re-check. Once you have re-checked a flagged task or scenario, clear its flag by upserting it with `recheck: false`, inside the change's own patch when it belongs to a change and with `apply --kind author` otherwise. If it exits 1, fix the patch and rerun it. If the request is unclear, `answer` it with one question instead.
  `node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" apply <plan> <patch.json> --kind change --summary "<one line>" --question <qid>`
- `pick`: the page already settled the card. Acknowledge it, then move on to what the pick unblocks.
  `node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" ack <plan> <qid>`
- `undo`: the user undid changes on the page. `undone` lists each one's `id` and `summary`, and `touched` lists what it put back, as codes, `domain:<id>` or `field:<name>`. Re-read the touched elements from `working.json`, then `ack` it.
- `update`: the user updated the real plan on the page, so `plan.json` and `plan.md` were rewritten and the list of changes is empty. `ack` it.

Open-ended questions stay in the terminal. When the user picks an option in the terminal, record it like a page pick, so that it can be undone:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" pick <plan> <code> <option>`
When they ask to undo a change, run the command below. Exit 3 means later changes touched the same elements, so name those changes and ask before you rerun it with `--with-later`:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" undo <plan> <change-id>`

## 5. Tasks, after the decisions settle

Write tasks only once no card is open. Each task names the decisions it implements in `decisions`, and the tasks it needs in `after`. Write it in this style:
- A task is the smallest unit with its own test cycle that a reviewer could reject while approving its neighbour. Fold setup, configuration and docs into the task that needs them.
- `files` holds exact paths. `interfaces.consumes` and `interfaces.produces` hold exact names, parameters and return types.
- Each step is one action with a checkable result: write the failing test (its name and assertions as `code`, with exact values), run it (`run`, `expect` FAIL), implement it (the exact signature and file in `body`, and code only for an algorithm the test does not determine), run it again (`expect` PASS), then `commit`.
- Fill `constraints` with project-wide rules and verbatim values, and `reviewFocus` with up to five inputs or failure modes that no test covers yet, each with the `test` task that pins it. Add `scenarios` per domain with their expected behaviour and covering `tasks`, plus `architecture` and `techStack`.

Self-review before you tell the user. Every decision has a task, and names match across tasks. Remove any step that decides nothing, such as "TBD" or "handle edge cases", and any code body that the signature and the test already determine.

## 6. Update the real plan

Until the first update, everything is working copy. "Update the real plan" ("Create the real plan" before the first one) is the user's button: it copies the working copy to `plan.json` and writes `plan.md` without a model turn. Run `update` only when the user says so in the terminal, never on your own. It refuses with `header-missing`, on the page too, until `goal`, `architecture` and `techStack` are set:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" update <plan>`

## 7. Hand-off

When the user closes the review, stop the page:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" stop <plan>`

## 8. Reopen

`/planner-companion:plan reopen <folder>` resumes a review, and the SessionStart hook prints that line for every unfinished one. Restart the page and give the user its `url`:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" start <folder>`
Before the `next` loop, check the plan's intent:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" intent-check <folder> --project "<primary working directory>"`
When `changed` or `missing` is true, tell the user in one line. A plan without an intent prints `"intent":null`, so ignore that.
Then run `next` until it prints `null`, handling each question as in section 4, because questions sent while no session listened are waiting there. Then arm `watch`. To orient yourself, list every code with its title instead of reading the whole source:
`node "${CLAUDE_SKILL_DIR}/scripts/planning.mjs" index <folder>/working.json`

## 9. Token discipline

- Write only patches. Never read or render the page HTML, and never read the SVG that `diagram` prints.
- A patch holds only the elements it touches. Before rewriting an element you did not write in this session, and any element the page changed (a pick or an undo), re-read that element alone from `working.json` before patching it, never the whole file.
- The terminal stays short: one line per event, naming codes and the URL. Content belongs on the page.
