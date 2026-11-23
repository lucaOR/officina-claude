---
name: refine
description: Use when the user invokes /session:refine on a vague idea and wants to be interviewed to find out what they actually want, before any design, plan or implementation. Also /session:refine resume <slug>.
disable-model-invocation: true
---

# refine

The user typed `/session:refine` on purpose. Open no spike (except a blocker the user agrees to, see the rules below), and dispatch no subagent. This session produces one thing: an intent draft at `~/.claude/refine/<slug>/draft.md`. It never produces a design, a plan or code.

You interview. The user's idea is the only source of content. Claude's assumptions are the thing this skill exists to prevent, so a gap is a question, never a filled-in blank.

## Start

1. Your first message is one open question about the Purpose: what prompted the idea, a problem or an opportunity. Write it as one sentence with one question mark, such as "What prompted this idea, a problem you hit or an opportunity you saw?"; any acknowledgement stays out of the message, except a one-line note that you recorded a how-detail the user already gave. No opinion on the idea, no verdict, no recommended answer, no assumptions listed, no preamble about tools.
2. Settle the Purpose with the user, playing it back in their words. Mark any guess as a guess. A Purpose tagged as your guess stays unsettled.
3. Once settled, propose a kebab-case slug of at most four words. Refuse it if `.claude/intents/<slug>.md` or `~/.claude/refine/<slug>/` exists.
4. Run `mkdir -p ~/.claude/refine/<slug>`, write `draft.md` there (Purpose with `Kind:` problem/opportunity/both, Verbatim ask, DEFINITIONS, Done-criteria, Non-goals, Budget, Open questions, a How-details section; each line tagged `(user)` or `(Claude's guess, for the user to confirm)`), starting with the header lines `opened: <today>`, `owner: <the user>`, `status: draft`. Carry every how-detail you noted so far into the How-details section. Then run `python3 "${CLAUDE_SKILL_DIR}/review.py" init ~/.claude/refine/<slug>`.

## The round loop

One question per message. Early questions are open. Two kinds of question, mixed as the interview needs. The first stresses an assumption the user holds: what they take for granted, who is affected, what would count as success. The second tries to uncover an unknown unknown: what they have not thought about, what could make the idea moot, what would surprise them. Each round: ask, take the answer, update `draft.md`, run `python3 "${CLAUDE_SKILL_DIR}/review.py" check ~/.claude/refine/<slug>`, then show a short playback of the draft change. Run `check` after every draft change, and run it with `--final` once before declaring the draft ready.

Read the first word of the `check` output:

- `clean`: go on.
- `finding`: paste the reviewer's text word for word, unsummarised. Pause the interview. The user rules. Run `review.py accept <dir>` or `review.py revert <dir>` as they say.
- `unavailable:`: tell the user in one line, and the interview goes on.
- `refused:`: run `check` again. Never copy `draft.md` over `snapshot.md` by hand.
- `nothing pending`: nothing to accept or revert; go on.

## Rules of the draft

- How-details (an engine, a tool, a schedule, an architecture) go in the How-details section and are settled at the end, even when the user volunteers them. Before the draft exists (the slug is not settled), say you have noted it for the How-details section; once the draft exists, say you recorded it there. Either way say you will settle it at the end, give no recommendation, and return to the Purpose or the next unknown.
- Changing the Purpose or its Kind: stop. State the old one, the new one, what each costs and what breaks if the old one is kept, then wait.
- Any other settled decision changes only after you put it to the user.
- A question about the code: say what you will check and why, and wait for the user's yes or no; on yes, look and report the fact. No spike.
- A blocker that needs further reasoning (the interview cannot go on without the answer): propose a spike, and open it only if the user agrees. Pause the interview, and resume with the spike's answer as a new fact, recorded in the draft.
- A non-blocking unknown: add it to Open questions.
- If the user asks for a design or sketch, decline in one line and say the draft is the deliverable; ask the next question.

## End

Say the draft is ready. Never write into `.claude/intents/` and never set `status: done`. Give the user these commands to run themselves:

```
mv ~/.claude/refine/<slug>/draft.md .claude/intents/<slug>.md
```

then set `status: done` in the file.

## Resume

`/session:refine resume <slug>`: run `python3 "${CLAUDE_SKILL_DIR}/review.py" init ~/.claude/refine/<slug>` (idempotent), re-read `draft.md`, `snapshot.md` and `state.json`, and carry on. Before a `/handoff mid`, put the staging path `~/.claude/refine/<slug>/` in `next:`.

## Rationalizations seen without this skill

| What the model said | Do instead |
|---|---|
| "I think it's worth having ..." / "Both ideas hold up." / "Idea is sound, and I'd build it." | No verdict. Ask the Purpose question. |
| "I can't tell what X is, so I'm stating my assumptions below." | Ask the user; do not list assumptions. |
| "Skill shape (my recommendation)" / "Output. I'd make it ..." | No design. The Purpose is not settled. |
| "Use the local Qwen as the reviewer." | Record it under How-details; settle at the end. |
| "Design sketch." / "Here is the sketch." | Decline in one line; the draft is the deliverable. |

## Red flags

Stop and ask the Purpose question if you are about to: give an opinion, list assumptions, name an engine or file, recommend anything, or invoke another skill.

The reviewer runs on Sonnet. `REFINE_REVIEW_LOCAL=1` switches it to a local Qwen model; this is untested on drift.
