---
name: run
description: Use when the user invokes /scenario-matrix:run, or asks to run scenarios, execute the test matrix, or check pass/fail status for an epic's scenario matrix at .claude/scenarios/<epic>.yaml — dispatches a batch to the scenario-matrix:runner agent, which runs it in the background and writes one results report with bugs found.
argument-hint: '<epic> [<id> | <family>...] [--plan]'
---

# /scenario-matrix:run

Phase 2 of the scenario-testing method. Phase 1 (`/scenario-matrix:matrix`)
compiles each scenario into an executable script at
`.claude/scenarios/_scripts/<epic>/<id>.mjs`. This skill's job is to run
those scripts — through `.claude/scenarios/_lib/run.mjs` for a batch, or
directly for a single fresh one — and turn what they report into a run
report and bug entries. It never interprets scenario prose, never drives a
browser or a service by hand, and never invents a command: every op a
compiled script performs is code that already lives in `_lib/` (the levers a
script imports from `_lib/index.mjs`, documented in `_lib/harness-api.md`),
and this skill only ever reads what already ran.

Every command below runs from the root of the repository checkout: the
session's primary working directory, or the worktree's root when working in
one. The Node binary used throughout is `node` from `PATH`, version 20 or
later. `scn_` below is the default database prefix; the project's prefix is
`dbPrefix` in `_lib/scenarios.config.json`, so read `scn_` as that value
wherever this skill uses it.

**Loading the matrix:** pull only the selected scenarios, not the whole file — the
matrix can run to thousands of lines, and a whole-file read of it is replayed on every
later turn of the run:

```bash
node .claude/scenarios/_lib/query.mjs <epic> <sel>      # one id, or a family prefix
node .claude/scenarios/_lib/query.mjs <epic> --infra    # provisioning/perimeter preamble
```

The matrix stamp-back after a run (see Diagnosing a run in
`${CLAUDE_SKILL_DIR}/reference/batch-run.md`) is a write and still edits `.claude/scenarios/<epic>.yaml` directly.

## What to read, and when

| File | Holds | Read it |
|---|---|---|
| `${CLAUDE_SKILL_DIR}/reference/batch-run.md` | the batch procedure the runner agent follows: what `run.mjs` does, the lock, live monitoring, the per-scenario reset, diagnosing, the report, evidence, the guards and the self-check | for a single inline run, its Diagnosing a run section when the result is `KO` or changes what the matrix records; the runner reads all of it for every batch |
| `.claude/scenarios/_lib/scenarios.config.json` | `monitor`, the live collector command, or `null` | before dispatching a batch, so you can say whether a live monitor runs |

## Invocation

| Invocation | Behavior |
|---|---|
| `/scenario-matrix:run <epic> <id>` | One scenario. If its compiled script is **fresh**, run it directly — inline, one Bash call, seconds. If it's **stale** or **uncompiled**, say so and stop: do not run it and do not interpret the scenario by hand. The fix for both is `/scenario-matrix:matrix <epic> compile <id>`. |
| `/scenario-matrix:run <epic> <family>` | Every scenario whose id starts with `<family>-`. One background `scenario-matrix:runner` agent; the runner runs `node .claude/scenarios/_lib/run.mjs <epic> <family>`. |
| `/scenario-matrix:run <epic>` | The whole matrix. Same as above, with no selection argument. |
| `/scenario-matrix:run <epic> --plan [sel]` | Inline, read-only: `node .claude/scenarios/_lib/run.mjs <epic> [sel] --plan`. Prints `fresh N · stale N · uncompiled N` plus the stale and uncompiled id lists, and exits 0. |

A selection may name several ids or families, separated by spaces. `run.mjs`
runs them in one invocation, in matrix order, so a batch of families costs
one bring-up rather than one per family. A selection that matches no
scenario stops `run.mjs` before it takes the lock. An unknown flag stops it
too, with its usage line and exit `64`, rather than silently running the
whole epic.

Fresh/stale/uncompiled is a compiled script's own staleness state, not
something this skill computes by hand: `uncompiled` means no script exists
yet at `.claude/scenarios/_scripts/<epic>/<id>.mjs`; `stale` means a script
exists but its header comment's hash (`// scenario: <id> compiled_from:
<hash>`) no longer matches `_lib/hash.mjs`'s `compiledFrom()` for the row's
current `id`/`behaviour`/`reach`/`env`/`setup`/`expected` fields. If it isn't
already obvious from something that ran earlier in the session, the cheapest
way to find out which of the three a single id is in is `--plan` itself —
`node .claude/scenarios/_lib/run.mjs <epic> <id> --plan`, which takes no lock
and touches nothing.

## Execution mode

Two shapes, depending on selection.

**Single fresh id — inline, no runner.** Run the compiled script directly:

```bash
node .claude/scenarios/_scripts/<epic>/<id>.mjs
```

This bypasses `run.mjs` entirely: no provisioning, no lock, no teardown. It
only makes sense when the scn stack is already up — typically because a
fuller run provisioned it earlier in the session, or because this particular
scenario needs no `scn_*` infra at all. The script still runs its own
staleness gate, reset, and evidence capture regardless of the driver being
skipped (that machinery lives in the script and in `_lib/scenario.mjs`, not
in `run.mjs`). If the stack genuinely isn't up, the script's own reset step
fails loudly — a thrown error, reported as the scenario's result (`BLOCKED`,
because a failed reset is the environment's failure) — rather than silently
passing against nothing.

**Family or whole matrix — one background runner agent.** `run.mjs` owns
the whole lifecycle: it takes the lock, brings the stack up, verifies it,
runs each script and tears the stack down (What run.mjs does, in the batch
procedure). The `scenario-matrix:runner` agent starts it, watches it,
diagnoses its results and writes the report. Because this is a long,
unattended sequence:

1. **Check permission mode first.** If the session's permission mode would
   interactively prompt for any tool call the runner makes, the runner stalls
   invisibly on the first prompt — nobody sees it, it just looks hung.
   Confirm autonomous execution is viable before dispatching; if not, tell
   the user rather than dispatching into a stall.
2. **Dispatch exactly one `Agent` call with `subagent_type: "scenario-matrix:runner"`,
   in the background.** Its definition pins Sonnet, so either omit `model` or
   pass `"sonnet"`. A stronger model buys nothing here, because the run
   itself is mechanical and diagnosing a `KO` is ordinary debugging. The
   runner does not see this conversation, so its prompt carries what it
   needs:
   - the epic and the selection, or no selection for the whole matrix;
   - the procedure path, `${CLAUDE_SKILL_DIR}/reference/batch-run.md`,
     written as the absolute path it expands to;
   - the worktree root, when the session works in a worktree;
   - anything the user asked of this run, such as keeping the stack warm.

   Don't paste the procedure or matrix rows into the prompt, because the
   runner reads both itself. A fork would already see them in its inherited
   context, but it would also run on this session's model and carry this
   whole conversation into every turn, which is why the run does not use one.
3. **Report and return immediately.** Tell the user what was dispatched
   (epic + selection, and that no live monitor runs when config `monitor` is
   `null`) and that its completion notification arrives on its own; do not
   poll for progress in the meantime. When it arrives, relay the runner's
   summary and the report path.
4. **While the runner runs**, the invoking session must not touch the `scn_*`
   databases directly. The lock only stops a second `run.mjs` invocation —
   it does nothing to stop a manual database client or container command
   from racing the same baseline-restore state.

## Plan mode (`--plan`)

`--plan` is a mechanical report `run.mjs` computes itself, not something this
skill reads scenario prose to guess at: for each selected row it hashes the
row's behavioural fields and checks whether a compiled script exists and
whether its stamped hash still matches, then prints the fresh/stale/uncompiled
counts and the stale/uncompiled id lists. Nothing is provisioned, run, or
torn down, and no file is written.

This supersedes an earlier version of this method, in which the model itself
walked each selected scenario's steps, guessed at missing environment facts,
and wrote a gap log to `.claude/scenarios/_gaps/<epic>.yaml`. That gap-log
format, its procedure and the `_gaps/` directory itself are all gone —
`--plan` neither produces nor reads any such file today.
