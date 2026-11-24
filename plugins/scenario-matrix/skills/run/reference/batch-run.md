# Batch run procedure

The `scenario-matrix:runner` agent follows this page for every family or
whole-matrix run that `/scenario-matrix:run` dispatches. A session that ran a
single fresh script inline reads only Diagnosing a run, and only when the
result is `KO` or changes what the matrix records.

Every command below runs from the root of the repository checkout: the
dispatching session's working directory, or the worktree root its prompt
names. The Node binary is `node` from `PATH`, version 20 or later. `scn_`
below is the default database prefix; the project's prefix is `dbPrefix` in
`_lib/scenarios.config.json`, so read `scn_` as that value wherever this page
uses it.

Pull matrix rows with `query.mjs`, never by reading the whole matrix file:

```bash
node .claude/scenarios/_lib/query.mjs <epic> <sel>      # one id, or a family prefix
node .claude/scenarios/_lib/query.mjs <epic> --infra    # provisioning/perimeter preamble
```


## What to read, and when

| File | Holds | Read it |
|---|---|---|
| `.claude/scenarios/_lib/scenarios.config.json` | `runsDir` (where a run writes), `monitor` (the live collector command, or `null`), `lifecycle` (the bring-up and teardown commands, `refusedExit`) | before every batch run |
| `.claude/scenarios/_lib/harness-api.md` | the result contract, the lifecycle hooks `run.mjs` calls and `summaryExtras`; then one page per installed adapter, whose "Other contributions" list its `Fatal log patterns:`, its reset steps and its `Lint:` rules; then the project's levers | before every batch run, and when diagnosing a `KO` |
| `.claude/scenarios/_lib/project-api.md` | what the project documents beyond its levers, each section only when it has one: `## Bring-up` (what its bring-up starts, checks and refuses), `## Teardown` (the lines a successful teardown prints), `## Monitor` (what its monitor records, and where), `## Fatal log patterns` (patterns no adapter contributes) | before every batch run, and when diagnosing |
| `.claude/scenarios/_lib/hooks.mjs` | the project's lifecycle hooks, when it defines them | when a bring-up, its verification or a teardown fails |

## What run.mjs does

`run.mjs` owns the entire lifecycle, and every step of it that touches the
stack goes through the project's lifecycle hooks (the Lifecycle table in
`_lib/harness-api.md`):

- It takes the lock.
- It brings the stack up with `lifecycle.bringUp`, whose default runs the
  config `lifecycle.up` command. When `lifecycle.isWarm` says a keep-warm run
  left the stack up (by default, when the warm marker file exists), it runs
  `lifecycle.warmUp` instead, which restores the baseline.
- It runs `lifecycle.verifyUp` on both paths, before any row, rather than
  trusting the bring-up's own exit code. A zero exit is not proof the stack
  is usable: a bring-up can exit 0 while a background worker it should have
  started is dead, and every row that waits on that worker then hangs.
- It runs each script in turn.
- It records `lifecycle.runFacts`, then tears down with
  `lifecycle.tearDown`, whose default runs the config `lifecycle.down`
  command. The teardown is best-effort, so its failure never skips writing
  `results.json` or releasing the lock.

A bring-up that fails, or a `verifyUp` that throws, stops the run before any
row, and the teardown still runs. The one exception is a refused bring-up:
`lifecycle.bringUp` returns `{ refused }` or throws a `Blocked`, which with
the default hook means the `lifecycle.up` command exited
`lifecycle.refusedExit` (default `78`) because it stopped before changing
anything. Then `run.mjs` tears nothing down and prints `bring-up refused:
nothing was changed, so nothing is torn down`, `results.json` carries a
`refused` field, and `run.mjs` prints the refusal reason last and exits `1`.
Report that reason to the user verbatim, together with the lines the
`lifecycle.up` command printed above it when the default hook ran: they say
what to fix.

**If the lock's holder pid is no longer running**, `run.mjs` reclaims the
lock itself and says so on stderr (`reclaiming stale lock …`); no action is
needed. **If the lock is held by a live pid** (or can't be parsed), `run.mjs`
fails fast, naming the holding pid and epic in its error (`another run holds
the scn stack: …`). Report that to the user verbatim. Never delete
`.claude/scenarios/_lib/.lock` on your own initiative — only the user,
having independently confirmed the holding process is actually dead, clears
it.

## Live monitoring (every batch run)

The runner does not wait silently for `run.mjs` to exit. It watches the run as
it goes and writes each failure down while the stack state that explains it
still exists; by the time teardown has run, that state is gone. `RUN` below
is `<runsDir>/<epic>/<date>`: `runsDir` comes from `_lib/scenarios.config.json`
(default `docs/scenario-runs`), and `<date>` is the UTC date `run.mjs` itself
uses (`date -u +%F`). This run's files are `{dir}`, the monitor directory,
`{log}`, the run log, and `{failures}`, the failure notes: `RUN/monitor`,
`RUN/run.log` and `RUN/failures.md`. If an earlier run today left
`RUN/monitor/` or `RUN/run.log`, all three take the suffix `-<HHMM>`, the
current UTC time (`date -u +%H%M`), like the date: `RUN/monitor-<HHMM>/`,
`RUN/run-<HHMM>.log` and `RUN/failures-<HHMM>.md`. `results.json` takes no
suffix: a later run on the same day overwrites it.

**The monitor contract.** Config `monitor` is a shell command, or `null`.
`run.mjs` never starts it; the runner does, from the repository root, with
every `{dir}` in the command replaced by the monitor directory. The command:

- writes everything it records under `{dir}`;
- is read-only: it watches the stack and never starts, stops or restarts
  anything;
- stops by itself once `{dir}/STOP` exists, and should also stop after a
  time limit, so that a lost runner cannot leave it running.

What the monitor records, which of its streams are in the perimeter, and
which stops a run plans for are the project's to document, in `## Monitor`
in `_lib/project-api.md`. A `null` monitor means there is no live collector.
Say so when dispatching and in the report, skip step 1 and the `STOP` of
step 5, and let step 4 search the rows' own log slices only.

**The fatal patterns** are the `Fatal log patterns:` lines under each
adapter's "Other contributions" in `_lib/harness-api.md`, plus the patterns
in `## Fatal log patterns` in `_lib/project-api.md` when the project has that
section. Read them once, before the run, and join them with `|` into one
`grep -E` pattern. When there are none at all, the report says that no
fatal patterns were defined, rather than claiming none fired.

1. **Start the collector** in the background, before `run.mjs`, when
   `monitor` is set: `mkdir -p {dir}`, then the config command, with `{dir}`
   filled in.
2. **Start `run.mjs`** in the background with its output in `{log}`
   (`mkdir -p RUN && node .claude/scenarios/_lib/run.mjs <epic> <sel> > {log} 2>&1`).
3. **Follow the log with the `Monitor` tool**, so that each row result arrives
   as an event instead of being found at the end:
   `tail -F {log} | grep --line-buffered -E '^[A-Z]-[0-9]+[a-z]* (OK|KO|INCONCLUSIVE|STALE|BLOCKED|SKIPPED|UNCOMPILED)|^stack |^bring-up refused|[Ee]rror|failed'`,
   plus the step markers the project's lifecycle commands print, when its
   `## Monitor` names them. `run.mjs` prints `<id> <RESULT> — <why>` after
   every row (`<id> UNCOMPILED — run: <compile command>` for a row with no
   script), and the lifecycle commands' own output lands in the same log.
4. **On every non-OK row, append an entry to `{failures}` straight
   away**: time, id, result, the script's `why`, and a reason line. Before
   writing the reason, check what was recorded since the previous row: the
   monitor's crash and out-of-memory records under `{dir}`, and the fatal
   patterns in the monitor's streams under `{dir}` and in the row's own log
   slices under `RUN/<id>/logs/`. The scenario wrapper writes those slices by
   itself on every `KO` or `BLOCKED` attempt, one file per log source the
   matrix's registry declares, indexed in `_sources.txt`. A row that never
   ran has none, and a row that died before printing its result may have
   none. Copy the last 200 lines of each in-perimeter stream the monitor
   writes into `{dir}/snap/<id>/`. Label the reason as observed (a log line
   or event that shows it) or as inference (what the `why` suggests, not yet
   confirmed). A setup failure, meaning the run exits before any row line,
   gets one entry with the decisive error line.
5. **When `run.mjs` exits**, `touch {dir}/STOP` so the collector stops,
   then go on to Diagnosing a run. Its exit code is `0` once it has run the
   selection, whatever the rows' results; `1` when it stopped before the
   rows (a refused or failed bring-up, a `verifyUp` that threw, a held lock,
   a selection that matched nothing); `64` on a usage error; and 128 plus
   the signal number when a signal stopped it. `{failures}` is the first input to step 3
   there. The report gets a `Monitoring` paragraph listing every crash and
   every out-of-memory event the monitor recorded that the run did not plan
   (the project's `## Monitor` says which stops its bring-up, restarts and
   teardown cause), plus any fatal-pattern line found, or an explicit "none".
   With no monitor, the paragraph says there was no live collector, and it
   lists the fatal-pattern lines found in the rows' log slices, or "none".

`RUN/` sits under `runsDir`, which the repository must not version, so
collector output never reaches a commit, and it may hold secrets. `run.mjs`
keeps `runsDir` ignored with its own `.gitignore`.

## Per-scenario reset (DB + logs)

Every compiled script resets its `scn_*` baseline before running its steps,
via the `reset` lever (`_lib/reset.mjs`, imported from `_lib/index.mjs`),
which also clears the service logs. An adapter whose logs are files empties
them in its own reset step, or leaves that to the project's baseline restore
(its page in `_lib/harness-api.md` says which), and a log the adapter reads
as a stream is sliced from the start of each attempt instead. The log half
matters because a service's log grows unbounded over a long unattended run,
and once it is large, a heavy request exhausts the service's memory limit
and every route behind it starts failing. This has happened in practice, not
just in theory. Clearing the log at every reset means each scenario runs
against an empty log, so the out-of-memory failure never has room to build
up. If a `KO`'s `why` shows an out-of-memory symptom anyway, treat that as a
genuine perf finding worth its own bug entry, not a scenario defect to write
off — and never restart a container on your own to clear it; container
lifecycle needs the user's explicit approval.

## Diagnosing a run

By the time this section applies, every selected scenario has already run —
either the driver ran the whole selection and wrote `RUN/results.json`, or a
single fresh script ran inline and printed its one NDJSON result line to
stdout. There is no interpreted fallback in either case: an uncompiled
scenario is reported as uncompiled, full stop, and the only fix is
`/scenario-matrix:matrix <epic> compile <id>` — never running the scenario
by hand from its prose.

1. **Read the result(s).**
   - Batch (`run.mjs`, family or whole matrix): read `RUN/results.json` —
     `{epic, date, selection[, interrupted][, refused], timing, results,
     summary}`. Each entry in `results` is `{id, result, ms[, why][,
     evidence][, attempts]}`; `result` is one of `OK` / `KO` /
     `INCONCLUSIVE` / `STALE` / `BLOCKED` / `SKIPPED` (the exit-code
     contract: `0` / `1` / `2` / `3` / `4` / `5`, defined in
     `_lib/result.mjs`). `why` is present whenever there is one to give —
     set by the script's own throw, OR by `run.mjs` itself for a row that
     never ran (`why: 'uncompiled'`) or printed no result line (`no result
     line (exit N)`, `no result line — killed after the 15-minute per-row
     timeout`, `no result line — killed by <signal>`, or `could not run the
     script: …`). `evidence` is present only on a `KO` or a `BLOCKED` whose
     script wired a `captureEvidence` hook that captured something (see
     Evidence). `attempts` is present only on a row that retried (its
     `retries` field), so a row that needed two attempts never reads like a
     clean pass. `ms` is absent on a row that never ran or printed no result
     line. `summary` totals by the same six keys (lower-cased) plus `total`,
     with `skipped_ids` and whatever the project's `summaryExtras` hook
     adds. `interrupted` names the signal that stopped the run: the rows
     after the stop never ran and are absent from `results`, so the report
     says which. `timing` splits the wall-clock time into bring-up, rows and
     overhead.
   - Single fresh id (inline, no runner): the one line of stdout that parses as
     JSON with a `result` key is the whole result — there is no
     `results.json` for this path. Cross-check the Bash call's exit code
     against `_lib/result.mjs`'s exit contract as a sanity check.
2. **Cross-reference the matrix**
   (`node .claude/scenarios/_lib/query.mjs <epic> <id>`) for each id's
   `behaviour` text — the results carry only the id, not the behaviour
   description.
3. **Diagnose every `KO`** into a bug entry (format below): read the script
   at `.claude/scenarios/_scripts/<epic>/<id>.mjs` plus its evidence
   directory, `RUN/<id>/` (its `logs/` slices included), and its entry in
   `{failures}`, to find the in-perimeter root cause. `BLOCKED` and
   `INCONCLUSIVE` are not bugs — report them as such with their `why`, never
   force them into the bug list. `SKIPPED` is not a bug either: the
   project's `requirementGate` hook judged that this environment cannot run
   the row, and its `why` says why. `STALE` isn't a bug either: recompile
   (`/scenario-matrix:matrix <epic> compile <id>`) and rerun; nothing about
   the behaviour under test was actually exercised.
4. **Write the report** (below) — for a batch run always; for a single
   inline rerun, a full `report.md` is usually unnecessary busywork (the one
   result line already says everything), so relay the result directly to the
   user instead. Still do steps 3 and 5 if the result is `KO` or otherwise
   changes what was previously recorded.
5. **Stamp the matrix**: for each selected scenario, write `last_run`
   (today's date + the driver's result string) and `bug_ref` (if a bug entry
   was created) into `.claude/scenarios/<epic>.yaml`. Map `result` onto the
   matrix's own `status` lifecycle (`open` / `verified` / `drift` /
   `blocked` — see Field rules in `/scenario-matrix:matrix`'s schema
   reference): `OK` -> `verified`, `KO` -> `drift`, `BLOCKED` -> `blocked`.
   `INCONCLUSIVE` has no dedicated matrix state — treat it as `blocked` (the
   assert couldn't confirm either way) and say so in the note. `STALE` means
   nothing new was learned about the behaviour, so leave `status` exactly as
   it was before this run; only `last_run` reflects that a stale attempt
   happened. `SKIPPED` is the same: the row did not run here, so leave
   `status` as it was and let `last_run` record the skip.

## Report

One report per batch run at `RUN/report.md` (`runsDir` is unversioned, as
`run.mjs` keeps it ignored with its own `.gitignore` — never commit this). Always lists the **whole selected suite**, every
scenario with a result, every `KO` with a populated `why`:

```markdown
# billing run 2026-07-17
Suite: 24 scenarios — compiled 22/24 — 18 OK · 3 KO · 1 INCONCLUSIVE · 1 STALE · 1 BLOCKED
Ran `run.mjs billing <selection>` -> provisioned -> ran suite -> torn down
(the config's `lifecycle.down` command). Ambient dev stack restored.

| id   | behaviour              | result       | runtime | why |
|------|------------------------|--------------|---------|-----|
| B-01 | import creates account | OK           | 4.2s    |     |
| B-06 | dup tie-break          | KO           | 6.8s    | expected status=skipped, got imported (dup not detected) |
| B-09 | subjective toast copy  | INCONCLUSIVE | 3.1s    | assert is subjective-UX, needs a human eyeball |
| B-12 | dup tie-break, variant | STALE        | 0.1s    | compiled_from mismatch — recompile |
| C-05 | un-import cascade      | BLOCKED      |         | uncompiled — run: /scenario-matrix:matrix billing compile C-05 |

## Bugs found

### BUG-1 · duplicate customer imported twice
- **Scenario:** B-06 (dup tie-break)
- **Severity:** high — data integrity (duplicate accounts)
- **Perimeter:** in (billing-api)
- **Location:** `billing-api/src/import/importer.ts:214`
- **Expected (per AC-3 / design §4):** on an email already present, the second
  row is skipped with `status=skipped, reason=duplicate`.
- **Actual:** both rows import; two accounts created for the same identity.
- **Root cause:** email comparison is case-sensitive (`===` on the raw email);
  `Alice@x.com` and `alice@x.com` miss each other, so the dedup guard never
  fires.
- **Reproduction:** `.claude/scenarios/_scripts/billing/B-06.mjs` — the
    compiled script already is the reproduction; run it again to replay it
    verbatim. Decisive check baked into the script: the accounts of
    `scn_accounts` grouped by lower-cased email — observed one group with
    `count=2`, expected no group with more than one.
  - **Evidence:** `docs/scenario-runs/billing/2026-07-17/B-06/`
```

`compiled: N/M` in the header is `N` = rows that had a script to run
(`fresh` + `stale`, i.e. everything not `BLOCKED — uncompiled`) and `M` =
the selected suite's total — both derivable from `results.json` without
re-running `--plan`. A `SKIPPED` row counts toward `N`: its script ran, and
the project's `requirementGate` stopped it. A run with `SKIPPED` rows adds
`· N SKIPPED` to the Suite line, so the counts still add up to the suite.

The `why` column is the report writer's own annotation, not a verbatim copy
of `results.json`'s raw field: for every uncompiled row that field is exactly
`why: 'uncompiled'` (`run.mjs`'s own literal string, nothing richer), so the
`C-05` row above adds the compile command as context. Some rows are
uncompiled specifically because their op has no `_lib` lever yet (`env-file`,
scenario-level `artifact`, or an op the project declares — see Ops with no
lever yet in `/scenario-matrix:matrix`'s compile procedure, and the
project's `_lib/project-api.md`), not just because nobody has reached them
yet; say so in the `why` column when that's the reason, rather than letting
it read as ordinary backlog. Either way the fix is a lever built in `_lib`,
never a hand-edit of product config to route around the gap.

Rules:
- `## Bugs found` holds **in-perimeter code bugs only** (per the matrix's
  `perimeter.in`). Out-of-perimeter failures are noted as environment/mock
  notes in the `why` column, never added as a bug entry. Ancillary/doc issues
  are fixed directly or noted elsewhere, never in this list.
- Every bug entry is verbose and self-contained: scenario ref, severity +
  impact, perimeter, `file:line` location, expected (with its intent
  source), actual, root cause, and a **reproduction** block. Because the
  reproduction is a compiled script, that block is short by construction:
  cite the script's path as the exact replay, and quote only the decisive
  observed-vs-expected line the script's own assert already computed — do
  not rewrite the steps by hand. Link the evidence bundle path.

## Evidence

On `KO` **and on `BLOCKED`**, a compiled script may capture evidence via the
`captureEvidence` hook `_lib/scenario.mjs`'s `scenario()` wrapper calls
before cleanups run, writing to `RUN/<id>/` (`_lib/result.mjs`'s
`evidenceDir()`). `BLOCKED` is included because a login that never reaches
its marker throws `Blocked` (the browser adapter's marker assert), and it is
the gate every browser scenario passes through — a failed login is the
commonest browser failure there is, and a screenshot of the screen it
actually landed on is what diagnoses it. `OK`/`INCONCLUSIVE`/`STALE`/`SKIPPED`
never get one; the next reset wipes their state regardless.

On the same attempts, the wrapper also writes the slice of every log source
it can read to `RUN/<id>/logs/<source>.log`, indexed in
`RUN/<id>/logs/_sources.txt` (which names each source it skipped, and why),
without the compiled script asking. Then each installed adapter that
contributes an `evidence` capture writes its own files into `RUN/<id>/`; its
page in `_lib/harness-api.md` says what they are. Each failing attempt overwrites the last,
so what is on disk is the last failed attempt. A row that failed and then
passed on a retry keeps that attempt's files, although its result carries no
`evidence`. The directory is dated by the attempt, in UTC, so a run that
crosses midnight UTC writes its later rows' evidence under the next date.

Whether the hook actually writes anything for a given scenario is a property
of the compiled script — whether `/scenario-matrix:matrix compile` wired one
for it — not something the runner does; its job is only to read
what's there when diagnosing, never to hand-assemble a bundle itself. Never
committed — `runsDir` is unversioned (`run.mjs` keeps it ignored with its own
`.gitignore`) and dumps may hold secrets/PII.
Persists until the user clears it.

## Guards enforced in code, not by the runner

The op-level safety rules this method used to enforce by reading a checklist
now live where the ops themselves happen:
- Every database op refuses a target outside the `scn_*` databases itself —
  the database adapter's target guard, whose reach (which of its levers call
  it, and how) is documented on that adapter's page in `_lib/harness-api.md`.
  The refusal is a `Blocked`, so it surfaces as `BLOCKED` — the guard firing
  is the guard working, never a bug in the code under test.
  Read "target" literally: the guard is on the target ARGUMENT, not on the
  statement. A statement run against a `scn_*` target that names another
  database inside its text passes it, because the client connects to the
  target and then executes whatever it is piped, against the whole server.
  What covers that is the database adapter's ambient-database lint rule
  (its `Lint:` line in `_lib/harness-api.md`), plus reading the statement —
  a statement matcher is deliberately absent, since `alias.column` is
  ubiquitous and any such regex false-positives constantly.
- An adapter that runs code inside the application under test arms a guard
  of its own there, at the connection, so a query on a non-`scn_` database
  is refused at the query, including one the body itself switched to; its
  page in `_lib/harness-api.md` documents the guard and its limits. A
  command it runs is checked against the database prefix before it starts,
  and a command whose targets cannot be determined is refused, so that
  guard fails closed.
- Run-level artifacts (`infra.artifacts`) are injected by the project's
  bring-up, not by `run.mjs`, so the refusal of an absolute, `..`-escaping,
  or product-tree source at injection lives inside that bring-up;
  `## Bring-up` in `_lib/project-api.md` says where. The matrix self-check
  (`check.mjs`) already refuses such a source in the yaml, before any run.
- `lint.mjs`, which Self-check already runs, refuses the KNOWN bypass shapes:
  an import specifier under `_lib/` that isn't `index.mjs` (the one that
  matters, since `index.mjs` doesn't re-export the raw process-boundary
  helpers the adapters use internally), a raw `http(s)://<ip>[:port]`
  endpoint (IPv4 or bracketed IPv6), and every rule an installed adapter or
  the project adds: the `Lint:` lines under each adapter's "Other
  contributions" in `_lib/harness-api.md` (an ambient database name, the
  shell-string form of a client the adapter wraps), and the project's
  `lint.rules` hook. It is a textual matcher, not a call-graph analysis: a
  script that imports `node:child_process` directly, or builds a shell
  string at run time, lints clean. Treat a clean lint as "no known bypass
  shape is present", never as proof the script cannot reach the
  environment — reading the script is still the guarantee.

What's left as the runner's own judgment call, because no code can automate
it: never edit a shipped service config (e.g. a file under a path config
`check.forbiddenArtifactPaths` lists) to make a scenario pass, and never
restart a container on your own to clear a stuck state (container lifecycle
needs the user's explicit approval) — flag it as a finding instead.

## Self-check after a run

1. For a batch run: `RUN/results.json` exists and every selected scenario
   appears in `results` exactly once. (A single inline script run has no
   `results.json` — its one stdout line and exit code are the whole result.)
   A refused or interrupted run is the exception: `results.json` says so
   (`refused` / `interrupted`), and the report says which rows never ran.
2. An evidence subdirectory exists for every `KO` scenario and for no `OK`
   scenario, except one that passed on a retry. The wrapper writes the log
   slices there on every `KO` attempt by itself, so a `KO` with no directory
   at all either failed before any attempt ran (its `why` says how) or lost
   its capture; flag it either way. A `KO` whose
   result carries no `evidence`, on a row with something to capture (a
   page), isn't the runner's bug to fix, but flag it: the compiled script
   needs a `captureEvidence` hook wired at its next `compile`.
3. `node .claude/scenarios/_lib/lint.mjs <epic>`
   prints `lint: clean`.
4. The driver's teardown actually succeeded: `run.mjs` printed no
   `teardown step failed:` line, and the teardown's own output in `{log}`
   shows it finished. With the default hook, `run.mjs` does not check the
   `lifecycle.down` command's exit status, so that output is the only
   record; `## Teardown` in `_lib/project-api.md` says what its lines look
   like. For a refused bring-up, `results.json` carries `refused` and the
   log says nothing was torn down instead. Under keep-warm (the config
   `lifecycle.keepWarmEnv` variable set to `1`), the log says `stack left UP`,
   and the report says the stack is still up. A report claiming the stack is
   restored without this having actually run is worse than an honest
   "teardown failed, ambient stack still in scn state" line.
5. Live monitoring left its trail: `{failures}` has one entry per non-OK
   row in `results.json` (or says the run had none). When a monitor ran,
   `{dir}/STOP` exists and the monitor has exited: its background task has
   ended, and no stream the project's `## Monitor` names is still running.
