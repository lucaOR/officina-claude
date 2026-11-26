---
effort: medium
name: handoff
description: Use when the user invokes /session:handoff, or asks for a handoff note, a checkpoint before clearing, or a way to carry the session's state across a /clear — writes the note to a file and emits a one-line pointer that orients the next session, so /clear can replace /compact and land on a ~47k floor instead of ~70k.
---

# Handoff

`/compact` lands on a measured ~70k floor: the 46.4k always-on prefix, a ~4.9k
summary, and ~19k of retained conversation state that no custom instruction can
reach. `/clear` lands on the prefix alone. This skill writes the small note that
makes clearing survivable, so the next session starts ~22k lighter on every
single response.

`/clear` destroys nothing — the transcript stays on disk. So the note does not
have to compress the session. It has to orient the successor and point at the
record.

The note itself never crosses the clipboard: it is written to a file, and the
user pastes a one-line pointer to that file. A note pasted on 2026-08-11 lost
205 of its 3517 bytes across four places, while the `Write` that preceded it was
byte-identical to the emitted block — the damage was in the terminal selection
over a soft-wrapped multi-line block, not in anything this skill produced.
Corrupted prose reads as valid content and is lost silently; a corrupted path
fails loudly on the first `Read`. That asymmetry is the whole design.

## Modes

Infer the mode, state which one you picked in one line above the pointer, and let
the user correct it. `/session:handoff boundary` and `/session:handoff mid` force it.

- **boundary** — the current task is finished. The note is a result summary.
- **mid** — the task is unfinished. The note is a working-state snapshot.

## Steps

1. Run the collector once:

   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/collect.py"
   ```

2. Use the **value** after the collector's `session_id:` label — the bare id,
   not the label text — as `parent=` in the sentinel, because from the next
   session's point of view this session is the parent. Two degraded cases, and
   they are not the same:

   - `session_id: (none found)` — no id could be resolved. Still emit the note
     with that value as `parent=`, and say in the line above the pointer that
     this handoff will not be recorded in the metrics.
   - a real id, but `transcript: (no transcript file found for this session
     id)` — `parent=` is exact and the handoff WILL be recorded. Only the
     record is missing, so say that in the line above the pointer and leave
     the note's `transcript:` line out rather than guessing a path.

3. Fill the header's `depth=` and `budget=` from the note this session read,
   and `goal:` from the work item's intent file, both as the section on those
   fields below requires.

4. Write the note to the absolute path the collector printed as `note_path:`.
   That file IS the handoff — the next session reads it, so it is the record and
   not a backup. Do not construct the path yourself: the collector names it by
   session id so two sessions cannot clobber one another, and puts it under
   `$HOME` because a worktree teardown deletes a note kept in the worktree and
   `.claude/` is versioned. The two Format sections below are that file's
   content; the pointer is not part of it.

5. Arm the auto-clear first. Run
   `python3 "${CLAUDE_PLUGIN_ROOT}/skills/handoff/scripts/arm_autoclear.py" <session-id> "<pointer>"`
   with the bare session id from step 2 and the exact pointer line you are about
   to emit. It writes `~/.claude/handoff/<session-id>.autoclear`, which the
   session mod reads to run `/clear` and submit the pointer itself. If it exits
   non-zero, skip it silently: the manual pointer below still works.

   Then put **everything you have to say above the pointer**: the one mode line,
   any session-id caveat from step 2, one line saying the session clears itself
   when mods are enabled and that the pointer is the manual fallback (copy it,
   run `/clear`, paste). Then emit the pointer as the last line of
   the message, alone, with nothing after it — no fence, no backticks, no
   trailing punctuation, so that a single-line selection copies exactly it:

   ```
   read <note_path> — HANDOFF v1 mode=<boundary|mid> parent=<session-id>
   ```

   The path leads and the sentinel trails, in that order. A long line still
   soft-wraps, so put the part whose loss costs content — the path — inside the
   first 80 columns, and let the part whose loss costs one metrics row take the
   tail. The token-hygiene plugin's `hooks/record-session-metrics.js` matches that sentinel
   anywhere on the line, so it must be reproduced verbatim.

## Format — boundary mode (~600 tokens)

```
HANDOFF v1 mode=boundary parent=<session-id> depth=<n> budget=<spent>/<total> intent=<slug>@<hash8>
goal: <the verbatim ask + done-criteria, quoted from the intent file>
shipped: <what actually landed, with file:line where it helps>
owed: <commits not run, tests not written, pushes not done>
next: <the worklist — the next slice, concretely enough to start on>
branch: <from the collector>
transcript: <path from the collector>
```

## Format — mid-task mode (~1.2k tokens)

```
HANDOFF v1 mode=mid parent=<session-id> depth=<n> budget=<spent>/<total> intent=<slug>@<hash8>
goal: <the verbatim ask + done-criteria, quoted from the intent file>
hypothesis: <the one currently being worked>
killed: <hypotheses already ruled out, each with the reason>
repro: <the exact command that reproduces, copy-pasteable>
working: <file:line being edited, and why that line>
owed: <commits not run, tests not written, pushes not done>
next: <the worklist — what to pick up next, in order. This is NOT the goal.>
branch: <from the collector>
changed: <from the collector>
transcript: <path from the collector>
```

## `goal:`, `next:`, and the header counters

`goal:` carries the verbatim original ask and the done-criteria, quoted from the
work item's intent file at `.claude/intents/<slug>.md`, and nothing else. Quote
it, do not paraphrase it, and do not let it move as the work moves. The worklist
goes in `next:`, which is a separate field precisely because it is not the goal.
When there is no intent file, quote the user's own opening prompt verbatim
instead and say in the note that no intent file exists.

This rule exists because the failure it prevents was measured. Across the
~50-session chain of 2026-09-10/11, the `goal:` line of the notes degraded from
the end purpose at chain position 3 into the current worklist by position 16 and
never recovered, and the word "dashboard" — the deliverable actually asked for —
dropped out of the goal line after position 6, with the dashboard itself not
built until day 2. A `goal:` holding the worklist gives the successor nothing to
check its work against, which is how a chain carries itself somewhere nobody
asked for.

`depth=` is the chain depth. A session that read a predecessor's note writes that
note's depth plus one, and a session that started cold writes `depth=1`. The
counter carries forward through the notes themselves, so it still works after a
predecessor note is deleted on consumption.

**Depth resets to 1 when `intent=` differs from the note this session read, and
only when both sides are real committed hashes.** A committed amendment to the
intent file is the user re-anchoring the work, so the chain starts again from
there and the halting check should not fire on drift away from a goal that no
longer stands. The hash makes that reset automatic: nothing has to be remembered
or bumped by hand, and any committed edit — the only editor of the file being the
user — trips it. A cosmetic committed edit also resets the counter, which is the
safe direction to be wrong in.

Three cases do NOT reset, and the depth counter keeps climbing through all of
them: `dirty` on either side, because an uncommitted edit is a draft rather than
an amendment; `-` on either side; and `-` to `-`, the work item that never had an
intent file at all, which therefore can never re-anchor.

`budget=` is `<spent>/<total>`, in whatever unit the intent file states its
budget in — turns or sessions. The successor adds its own spend to the
carried-forward figure. With no stated budget, write `budget=-/-` rather than
inventing one.

A **turn** is one assistant response, never a user-and-assistant exchange. An
exchange can hold several responses (every tool call and its follow-up is one),
so the two units differ by a factor that varies from session to session; a chain
that mixed them made `32/56` and `35/56` incomparable and let the halting check
fire early or late. Derive your own spend from your transcript as the number of
distinct `message.id` values among its `assistant` lines, not the number of those
lines: the transcript writes one line per content block, so a single response
with text and two tool calls is three lines but one turn. Subagent transcripts
are separate files and are not counted. A budget stated in sessions counts
sessions, one per handoff note in the chain.

It is deliberately NOT billed tokens out of `sessions.v4.csv`, for a reason that
was checked rather than assumed. That file is written by the SessionEnd hook, so
the row for the session writing the note does not exist yet at the moment it
writes it. A token figure read there would always omit exactly one session — the
one doing the writing, which is also the most expensive one to lose. Summing the
ancestors would additionally mean walking the file's `parent_session` column,
which is a new code path in the collector. Self-reported turns are less precise
but complete and free; if a billed figure is ever wanted, it belongs in a
separate line labelled as ancestors-only, not in `budget=`.

`intent=` is the work item's slug and the first eight characters of the git blob
hash of its intent file **as committed at HEAD**:

```bash
git rev-parse HEAD:.claude/intents/<slug>.md | cut -c1-8
```

When the working copy differs from HEAD, write `intent=<slug>@dirty`. Write
`intent=-` when the work item has no intent file at all.

The committed blob rather than the file on disk, because an uncommitted edit is
not yet an amendment — it is a draft, and a chain should not re-anchor onto one.
`dirty` is a visible state rather than a hash precisely so that it cannot
silently compare equal or unequal to anything.

Both counters sit after `parent=` on the header line inside the note, and they
are deliberately NOT added to the pointer. `record-session-metrics.js` matches
its sentinel unanchored, so appending them would not break the metrics row, but
the pointer's tail is the part a soft-wrapped mis-copy eats, and losing the depth
counter silently disables the halting check below.

### The halting check

When the note being written carries `depth=8` or higher, and again at every
multiple of 8 above it, the note's body opens with this line, verbatim:

```
FIRST ACT: before anything else, answer "is Done met — yes/no/why" against the
verbatim goal above. Report that answer to the user before touching any file.
```

Eight is proposed rather than derived, and it is the user's to change. It is the
threshold that fires while the measured drift was still recoverable: on the
2026-09-10/11 chain the goal line was intact at position 6 and had already
collapsed into a worklist by position 16, so a check at 8 lands inside that
window, and repeating it every 8 keeps a long chain honest without taxing a
short one.

The line goes in the note rather than in this skill because the successor is
guaranteed to read the note and is not guaranteed to load this skill.

## What earns a line

`killed` is the load-bearing field. It is both expensive to re-derive and
absent from every other store: the epic tracker holds open points, auto-memory
holds decisions, and neither records "I already ruled this out and here is why."
Write the reason, not just the hypothesis — a bare list invites the successor to
re-test them.

A result is written only once a tool result in this session has shown it. A
step that is planned, about to run, or still running goes in `owed:` or `next:`
as owed, never in a field that reads as done — "passed", "verified", "fixed" and
"shipped" each need an output the writer saw. The successor reads the note as the
state of the world, so it carries an unobserved result forward as fact. On
2026-11-02 a note in the ms-extensions staging smoke chain recorded the step 6.3
rerun as passed before the rerun had run, and the next session had to correct
both the note's claim and the plan document that repeated it. The reading-side
counterpart is to treat a note's facts as pointers and re-check them against the
code before acting on them.

Do not restate what the collector already printed. Do not summarise the
conversation; that is what the transcript is for, and section 6 of the built-in
compaction template already proves how expensive listing everything gets.

A `pivot-gate: ESCALATE <note-id> <definition_touched> — <reason>` line, reported
by this plugin's `hooks/pivot-gate.py` at session start, is ruled by the user, never
by the session. *Agree*: the user rewrites the touched DEFINITIONS line to the
new definition and commits. *Disagree*: the user widens the touched line so it
names the flagged change as in-scope, and commits. Either way the next note
carries the new `intent=<slug>@<hash8>`, depth resets to 1 under the rule above,
and `killed:` records the ruling as `agreed: <definition_touched> — <one line>`
or `disagreed: <definition_touched> — <one line>`, quoting `definition_touched`
verbatim so the successor can match it against the intent file. A ruling the
user does not write into the intent file re-escalates on every later note,
because the gate is stateless and re-judges each note against HEAD; that is the
cost of leaving it out, not a defect to work around. An ESCALATE with no ruling
yet goes into `next:` verbatim as the first item, until the user rules on it;
it is never dropped and never resolved by the session.

## Boundaries

Notes accumulate under `~/.claude/handoff/` at a few KB each, and the same is
true of the gitignored `.claude/handoff.local*.md` files a paired
worker/adjudicator write directly in the root repo so the two roles don't
clobber each other's note. Nothing deletes a note on "a next session started" —
that is deliberate: on 2026-08-11 the pasted note was the only copy that
reached the next session, and its lost content was recoverable solely because
the emitting transcript still held it. An unread old note costs nothing, so it
is kept forever.

What does eventually clean up is a note that was actually opened.
This plugin's `hooks/mark-handoff-consumed.py` (PostToolUse on `Read`) drops a
`<note>.consumed` sidecar the moment that exact file is read — the file being
opened, not a session merely starting, is the signal. This skill's
`scripts/sweep.py`, run on every real `SessionStart` (`startup` only, not
resume/clear/compact), deletes a note and its sidecar once the sidecar itself
is 24h old. A note nobody has read is never touched.

This skill does not write to the knowledge base and does not write auto-memory.
The note is throwaway; those two stores are not. When something durable surfaces
while writing the note, say so in one line and point at `knowledge-capture` —
do not route it yourself.
