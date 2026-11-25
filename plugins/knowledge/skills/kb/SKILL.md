---
effort: medium
name: kb
description: Use for `/knowledge:kb <text>` — push an observation to the KB capture queue, from any session, no scribe required — and `/knowledge:kb run` — scribe-only, drains the queue, routes/writes KB YAML, commits (per `scribe.commit`). `/knowledge:kb run` refuses immediately unless the session is the scribe (`KNOWLEDGE_ROLE` or `CLAUDE_ROLE` is `scribe`), re-checked at the point of use, and refuses while another run holds the run lease. Launch a scribe session with `ccscribe` (`claude --agent knowledge:scribe -n kb-scribe`).
---

# KB

The scribe is a standing, project-wide role that turns queued observations into knowledge-base
entries. It is not tied to any other session: any session can push (`/knowledge:kb <text>`), and
the queue drains independently of who pushed or whether that session still runs. The project's
`.claude/knowledge/_index.md` may point at its own design notes for the role and holds the project
specifics this skill defers to.

## Firewall

- The scribe never edits code and never writes a verdict.
- The scribe is the **only** role that writes KB YAML.
- Pushers state facts, never a proposed rule — the scribe derives the rule at run time.

## `/knowledge:kb <text>` — push (any session, no scribe required)

Call `kb_queue.push(text, artifact_refs=...)` (`"${CLAUDE_SKILL_DIR}/../../scripts/kb/kb_queue.py"`).
One `O_APPEND` write, lock-guarded (`.claude/knowledge/.local/queue.lock`, through the plugin's
cross-platform lock) against a concurrent `mark_consumed`. Nothing is read back, nothing is
validated, no scribe is contacted — if no scribe ever runs, `.claude/knowledge/.local/queue.md`
is still a durable, human-readable capture list. The queue is per-machine state: it lives under
`.local/`, which is git-ignored, and a linked worktree feeds the main checkout's queue.

Queue line fields: `id`, `pusher`, `ts`, `head_sha` (at push time), `text`, `artifact_refs`
(`path:line` / SHA / test-output path — cite what backs the observation), `consumed`. State
facts, not a proposed YAML entry — routing and wording are the scribe's job, not the pusher's.

## `/knowledge:kb learn` — capture this session's learnings (any session)

Runs the capture extractor on the current session by hand, whatever `scribe.capture` says. In
this file `{root}` is the project root. Call
`python3 "${CLAUDE_SKILL_DIR}/../../scripts/capture/run_capture.py" --root {root} --session "${CLAUDE_SESSION_ID}"`.
With `--session` and no `--transcript` it reads `~/.claude/projects/<slug>/<session>.jsonl`
(the slug is the project root with every non-alphanumeric character replaced by `-`), so it
captures exactly that session. Only when neither `--session` nor `--transcript` is given does it
fall back to the newest transcript `.jsonl` in that directory. Pass
`--session <id> --transcript <path>` to capture a transcript from elsewhere. It always exits 0 and
queues the extracted rows with `meta.source=auto`; failures go to `.claude/knowledge/.local/capture.log`.
The scribe lists those rows under "Auto-captured candidates" in the next `/knowledge:kb run` plan
(score at least 0.35 shown with quote and score, the rest counted as held) and writes nothing
without approval.

## `/knowledge:kb run` — drain the queue (scribe-only)

**Refuses immediately unless `KNOWLEDGE_ROLE == "scribe"` or `CLAUDE_ROLE == "scribe"`.** Re-check
this independently every time `/knowledge:kb run` is invoked — never trust that the launch-time brief
already confirmed it, because a session's env can only be trusted at the point of use, not inherited
from an earlier hook firing. This check is a second line of defence: the `scribe-gate.py` hook is
what blocks a typed or Skill-tool `run` outside the scribe session, and inside any subagent (the
scribe is a session agent; spawned as a subagent it is refused too).

**Lease (before step 0).** Take the run lease:
`python3 "${CLAUDE_SKILL_DIR}/../../scripts/kb/kb_lease.py" acquire --session "${CLAUDE_SESSION_ID}"`.
It prints the **run id**; keep it for the whole run and pass it everywhere below.

- Exit 3: another run's lease is fresh (refreshed within `scribe.lease_minutes`, default 60). The
  holder is printed as JSON. Report the holder (session, host, started, last refreshed) and **stop**.
  Offer a takeover (`acquire ... --takeover`) only after the user confirms through AskUserQuestion
  that the other run is dead. Never take over on your own.
- A stale lease is replaced and reported on stderr (the replaced holder). A corrupt or unreadable
  lease file counts as stale: say so in one line and carry on, never a traceback.
- Every script call below passes `--lease <run id>` (`check.py`, `validate.py`, `build_digest.py`,
  `report.py`, `kb_audit.py`, and the scripts `knowledge:knowledge-check` and `knowledge:knowledge-route` run on this
  run's behalf). Every library call passes `lease=<run id>` (`kb_queue.read_unconsumed`,
  `kb_queue.mark_consumed`, and `kb_commit_guard.normalize_path`, `expand_pathspec`, `snapshot`,
  `diff`, `exists_at_head`, `rollback`). Only a call carrying the matching run id refreshes the lease, so
  pushes, git hooks and other sessions can never keep a dead run's lease alive.
- Any refusal or abort below, and step 10, ends with
  `python3 "${CLAUDE_SKILL_DIR}/../../scripts/kb/kb_lease.py" release --lease <run id>`.

**Without git.** First check whether the project is a git work tree
(`git -C <repo-root> rev-parse --is-inside-work-tree` prints `true`). When it is not, the run
skips step 0 and step 8, because there is no `git status` to snapshot and no commit to guard,
skips steps 9.2-9.4 (the run only writes files), and skips the git half of the abort-time
rollback: rollback then means deleting the files this run created and restoring nothing else.
Everything else, the lease and the queue included, works the same.

0. **Precondition.** Snapshot (`kb_commit_guard.snapshot(..., lease=<run id>)`) `git status --porcelain` over the commit pathspec
   (`scribe.pathspecs` in `.claude/knowledge/config.yaml`, default `.claude/knowledge`), passed
   as configured: `snapshot` expands its glob entries itself and normalizes them through the
   `scribe.path_translations` symlink translation (below). Non-empty → **refuse the run
   immediately** (release the lease), report the foreign paths by name, do not proceed to step 1. This catches dirt
   already inside the pathspec at run start, which a pathspec-limited commit would otherwise
   silently sweep in regardless of what later steps write.
1. `kb_queue.read_unconsumed(lease=<run id>)` — every row with `consumed=false`. For each, report its age and
   whether its cited `path:line` still resolves against current HEAD (stale citations are
   surfaced, never silently dropped). An empty queue does not end the run while a health sweep is
   due: carry on to step 2 and the Health section.
2. Read the working diff (uncommitted changes against HEAD) and run `knowledge:knowledge-check` over it —
   in addition to, not instead of, the per-edit `check-on-edit.py` hook. Violations fold in as
   further candidates alongside the queue rows. Then run the health sweep's plan:
   `python3 "${CLAUDE_SKILL_DIR}/../../scripts/kb/kb_audit.py" plan --lease <run id>` (add `--force`
   for `run --audit`). It always runs `validate.py`, and when the sweep is due (`scribe.audit_every_days`,
   default 7, `0` = every run) also `report.py`. It prints `{"full": bool, "findings": [...]}`; findings
   the user kept as-is are already filtered out while the rules behind them are unchanged.
3. Present **one** combined ROUTE/MEMORY/DROP/ASK plan (queue rows + folded-in violations
   together; `source=auto` rows go under "Auto-captured candidates" per the scribe agent: score
   at least 0.35 listed with quote and score, the rest counted as held), per `knowledge:knowledge-capture`'s iron law, followed by a **Health** section that
   lists the `plan` findings grouped by category and triaged per "Health triage" below. Read-only —
   nothing written to the KB, the queue, or git yet.
4. User dispositions the plan, per-item, not all-or-nothing. ROUTE and MEMORY items proceed
   below. DROP items are discarded: nothing is written to the KB, memory, or git, and the row is
   removed from the queue **right away** via `kb_queue.mark_consumed(id, lease=<run id>)`. A DROP persists
   nothing, so it has no commit to wait for, and the step-10 ordering does not apply to it; a
   later abort or rollback in this run does not bring a DROPped row back. Without this, a
   DROPped row stays `consumed=false` and resurfaces on every run. ASK items are deferred and
   stay `consumed=false` for the next run, same as an unread row. Each Health finding gets one of:
   an accepted fix (a YAML edit, step 5), **keep as-is** (the user judged the finding acceptable),
   or left for the next run. Keep as-is runs
   `python3 "${CLAUDE_SKILL_DIR}/../../scripts/kb/kb_audit.py" keep --category <C> --fqid <X> [--fqid <Y> ...] --lease <run id>`
   right away: it persists nothing in git, and the finding stays hidden until one of its rules
   changes (an `ERROR` is never hidden).
5. For each ROUTE item: invoke `knowledge:knowledge-route`, which writes the YAML entry (scope × kind
   already resolved by the plan, not re-asked). For each MEMORY item: written via the normal
   auto-memory path, outside the KB pathspec entirely. An accepted Health fix is an edit to
   existing YAML, made through `knowledge:knowledge-route` like any other write, and its paths join the
   write manifest, so steps 6-9 and the rollback cover it.
6. **Aggregate gate (Obligation 1).** Re-run `knowledge:knowledge-check`, scoped to only the paths step 5
   just wrote. This catches a cross-entry problem the per-edit hook cannot — an entry that passes
   alone but is wrong relative to another entry the same run just wrote (a duplicate id, or two
   entries that individually pass but jointly violate a cross-entry rule). Any `[blocking]`
   finding aborts the run via the rollback rule below: no digest rebuild, no commit, the
   offending item(s) reported by name and left `consumed=false`. `[recommended]` findings do not
   abort but are surfaced alongside the commit confirmation at step 8, since there is no
   commit-time enforcement for them at the repo root.
7. Rebuild the digest of each scope step 5 wrote to
   (`"${CLAUDE_SKILL_DIR}/../../scripts/build_digest.py" --root <scope dir> --lease <run id>`, one scope per call). This is itself a write inside the commit pathspec, so
   it must happen **before** the commit-guard's "after" snapshot, not after it.
8. Run `kb_commit_guard`: diff (`kb_commit_guard.diff(..., root=<root>, lease=<run id>)`) the post-step-7 pathspec snapshot (normalized) against exactly
   what steps 5 and 7 wrote. Anything extra aborts the run — nothing commits, nothing gets marked
   consumed. This is the second half of the before/after pair step 0 opens: step 0 rules out
   foreign dirt present *before* the run started; this step catches a write landing *during* the
   run. Neither substitutes for the other.
9. **On a clean diff, in this exact order:**
   1. Build the pathspec with `kb_commit_guard.expand_pathspec(<root>, <scribe.pathspecs>,
      lease=<run id>)` (`scribe.pathspecs` in `.claude/knowledge/config.yaml`, default
      `[.claude/knowledge]`). It expands each glob entry to the folders it matches in this
      checkout and drops a glob matching nothing, the same expansion both snapshots used; never
      hand git an unexpanded glob, which `git status` silently matches to no file and `git add`
      refuses. (A project that keeps its service registries under one shared directory, for
      example, lists `.claude/knowledge` plus `shared/*/.claude/knowledge`.) A plain entry is
      kept as written, so the snapshots still see a folder deleted whole; before the commit, drop
      a plain entry that names no folder in this checkout. A pathspec entry matching nothing aborts a real `git commit` (measured:
      exit 1 on git 2.43.0, both plain and glob pathspec forms — not a hypothetical, and not
      128, so don't code a 128 check). Directory form throughout — never a `*.yaml` header glob,
      which silently drops tracked non-YAML files (e.g. `epics/*.yaml` is fine, but a glob
      wouldn't catch every file `knowledge:knowledge-route` might write under the tree).
   2. `git add --` that same pathspec, directory form, **before** committing (without git,
      skip steps 2-4, see **Without git** above: the run only writes files, and step 10 follows
      the write). This is not
      optional and is not in the original design — RED-phase testing found that a pathspec-limited
      `git commit -- <pathspec>` **without** a preceding `git add` on that pathspec exits 0 but
      silently drops newly created untracked files from the commit, reporting success on a partial
      write. `kb_commit_guard`'s clean-diff check at step 8 cannot catch this either way: a file
      omitted from the commit is still "dirty" in both the correct and the silently-broken
      outcome, so the guard sees no difference. Never `git add -A` — this defeats the entire
      purpose of a scoped pathspec.
   3. **Commit mode, from `scribe.commit`.** `commit` (default): `git commit`, pathspec-limited
      to the same pathspec, never through a symlinked `.claude` (stage through the translated
      real path — see Symlink translation below). No further ask. `stage`: stop after the
      `git add --` of step 2; do not commit, leave the staged files for the user, and skip the
      post-commit verification below (verify instead that `git diff --cached --name-only`
      matches the write manifest). **Never `git push`.**
   4. **Post-commit verification** (`commit` mode only). `git show --name-only HEAD` and compare against the write
      manifest (the exact paths steps 5 and 7 wrote). A mismatch is a hard error — report it and
      **do not proceed to step 10** even though the commit already landed; this is the guard
      against the exact silent-drop failure mode in (2) slipping past everything upstream of it.
10. **Only after the result is safely recorded** — in `commit` mode, after both the commit and its
    post-commit verification succeed; in `stage` mode, after the staged-files check of step 9.3
    passes; without git, after step 7's writes:
    `kb_queue.mark_consumed(id, lease=<run id>)` for every ROUTEd/MEMORYed row (never for ASK;
    DROPs were already consumed at step 4). In `stage` mode the staged files stay uncommitted
    inside the pathspec, so the next run's step 0 refuses until the user commits them (or
    unstages them); say so when the run ends. If the `plan` was full, then run
    `python3 "${CLAUDE_SKILL_DIR}/../../scripts/kb/kb_audit.py" mark-full --lease <run id>`, so the
    next sweep is due `scribe.audit_every_days` from now; a run that aborted never marks it. Then
    **release the lease** (`kb_lease.py release --lease <run id>`). Marking
    consumed before the commit lands would let an abort at step 8/9 or a commit failure discard a
    capture that was never actually persisted — data loss with no recovery path, since the source
    line no longer reads as pending. This ordering held under direct sunk-cost pressure in
    RED-phase testing and is not negotiable at run time.

## Health triage

The Health section of the plan comes from `kb_audit.py plan`: `validate.py` on every run, and on a
full run also the ledger signal from `report.py`. This section is the periodic full-tree backstop
to `knowledge:knowledge-route`'s write-time lint. It also catches hand-edits that bypassed the
router. Triage each finding by its category, and put the proposal in the plan; nothing is written
before the user dispositions it.

**Graph findings (`validate.py`)**

- `ERROR` -> fix at the source YAML (dangling edge target; illegal override of a `binding` rule;
  duplicate FQID; two same-scope overrides of one rule; `digest_out_of_sync`). Mechanical: propose the
  edit directly, then re-run `validate.py --lease <run id>` to confirm it is gone.
- `CANDIDATE` clusters -> for each (same topic, overlapping `applies_to`, no declared edge), read the
  rule bodies and judge actual contradiction. Delegate a large cluster to a sub-agent: give it the
  FQIDs and bodies and ask "do any of these conflict? which pair, and how?" Record the resolution as an
  edge (`overrides` / `conflicts_with`) or confirm independence by keeping it as-is.
- `FAN-OUT [zombie_default]` -> every service overrides a root-scope rule. If the overrides agree,
  promote (rewrite the root rule, drop the overrides); if they disagree, retire the root default (the
  concern is per-service). `FAN-OUT [healthy]` is informational (sanctioned exceptions).
- `WARN id_only_rule` -> the rule is `digest_only`, not resident, and has no `check`, so the model
  only ever sees its bare id on the digest's `also:` line. Advisory: confirm the id is
  self-describing, or set `resident: true`.
- `WARN oversize_jit_rules` -> a one-line summary of collapsed rules whose rendered body exceeds the
  on-edit hook's per-file byte cap, so the hook can never inject them. Advisory: `validate.py
  --oversize` lists the individual rules; shorten the body or accept that the body is reached only
  by looking the rule up (the digest's trailer says how).

**Ledger signal (`report.py`, full run only)**

- `DEAD` (in registry, never fired) -> retirement or re-glob candidates. Treat as a weak signal: zero
  fires can mean the rule's area simply was not touched in any checked diff, not that the rule is
  useless. Cross-check before proposing removal.
- `FREQUENTLY VIOLATED` -> reword for clarity, or promote `recommended` -> `blocking`.
- `NOISY` reminders (judgment rules, no check, recurring) -> check-synthesis candidates; consider
  adding an executable `check:` so they enforce deterministically. When the rule requires genuine
  semantic judgment a shell check cannot approximate without misfiring the other way (for example
  classifying inbound vs. outbound in a comment), tag it `sweep_only: true` instead: `check.py` then
  excludes it from `check-on-edit.py` and `knowledge:knowledge-check`, and only a caller that passes
  `--include-sweep-only` (a review sweep, if the project has one; its `_index.md` names it) still
  reminds on it, once per review instead of once per commit.

  Do NOT reach for `no_jit` in the same breath. Reminder noise and authoring guidance are separate
  channels: `sweep_only` quiets the per-commit REVIEW line, while the rule's body is still injected
  by `inject-rules-on-edit.py` before the first matching write of a session, which for a non-resident
  rule is its only edit-time delivery. Add `no_jit: true` only when the body genuinely cannot inform
  the writing, such as a comment-phrasing or naming nit that applies to finished text. A structural
  or placement rule keeps its injection even when its reminder is deferred. Judge the two separately,
  per rule; a high reminder-hit count alone says nothing about whether the injection earns its keep.
  Check the `RETIRE` candidates (delivered, never caught anything, never cited) and the usage
  channel counts they read from the local usage telemetry, not just the reminder count in isolation.
- `RETIRE` candidates -> confirm by reading the rule before proposing to retire it. Citations are a
  floor (thinking blocks are not counted), so an absence of citations is not proof of uselessness.

The ledger is local and gitignored, so it reflects THIS machine's activity only.

**Report signals are proposals, not verdicts.** Once, the top "promote to blocking" candidate's
43 findings were all false positives: a high violation count measures how often a check fired, not
whether it was right. Read the cited findings before proposing a promotion.

**Staleness (full run only, judgment).** Only when the `plan` was full; a normal run skips it.
Do not read every rule: pre-filter mechanically to the rules whose `source` names a repository path
that no longer exists (test each named path with `test -e`), and judge only those. Then check each
epic's `status`: flag shipped epics that should be distilled into conventions and `status` lines that
are out of date. Propose updates; do not auto-rewrite bodies.

**Verify clean.** After the accepted fixes are written (step 5), re-run `validate.py --lease <run id>`
and confirm no `ERROR` lines remain and every surfaced `CANDIDATE` / `FAN-OUT` has a recorded
decision (an edge, an accepted fix, or keep as-is). Rebuild the digest of any scope you changed
(step 7). `WARN id_only_rule` and `WARN oversize_jit_rules` are advisory: they never change
`validate.py`'s exit code, so their presence does not block declaring the base clean. The registry
YAML and its rebuilt `_digest.md` commit together in step 9, because `validate.py` treats digest
drift as an `ERROR` that exits 1.

**Red flags — stop**

- Treating a `CANDIDATE` cluster as a conflict without reading the bodies.
- Auto-promoting a zombie default whose overrides actually disagree.
- Declaring the base clean while `ERROR` lines remain.
- Promoting a rule to `blocking` on report numbers alone.

## Error handling

**General rule: abort-time rollback.** Any abort after step 5 has written anything restores the
pre-step-0 tree before exiting — otherwise the *next* run's step 0 would see this run's abandoned
writes as foreign dirt and refuse, misattributing this run's own work to a third party.

- **Scope.** Rollback targets only the write-manifest paths steps 5-7 built for step 8's diff —
  never the whole commit pathspec. A pathspec-wide `git checkout` would discard a third party's
  unrelated uncommitted work sitting in the same folder (observed happening repeatedly).
- **Verb**, resolved per manifest path **at rollback time**, not cached from when the path was
  first written (`kb_commit_guard.exists_at_head`):
  - Exists at current HEAD (`exists_at_head(..., lease=<run id>)`; `git rev-parse --verify -q HEAD:<path>` exits 0) → `git checkout --
    <path>`.
  - Does not exist at HEAD (exits 1) → `rm -f <path>`.
  - Any other exit code (e.g. 128, cwd outside any git work tree) → hard error, report it, never
    `rm -f` on that basis. (A project that is not a git work tree never gets here: see **Without
    git**, where rollback deletes only the files this run created.)
- **Loop, don't short-circuit** — process every manifest path regardless of any single path's
  result (`kb_commit_guard.rollback(..., lease=<run id>)`).
- Nothing rolled back is marked consumed — the queue row stays `consumed=false` and is
  reprocessed next run, same as an ASK.
- **After the rollback, release the lease** (`kb_lease.py release --lease <run id>`). A run that
  dies without releasing is not a problem for long: its lease goes stale after `scribe.lease_minutes`.

**Dead or wedged run.** There is no pid to probe, because pids do not cross the
devcontainer/host boundary and a liveness probe is not portable. A run that crashed leaves its lease
to go stale; a run that is merely idle keeps it fresh only while its run id keeps refreshing it. The
next `/knowledge:kb run` therefore refuses with the holder's session, host and times, and a human
(or the user, through AskUserQuestion) decides whether to take over. No automatic override, ever.

**The `mark_consumed` race** (Obligation 3): `kb_queue.py` holds `.claude/knowledge/.local/queue.lock` for the
duration of both `push`'s append and `mark_consumed`'s read-modify-write, so a `push` arriving
mid-`mark_consumed` waits rather than interleaving.

## Symlink translation (load-bearing for every pathspec operation)

A project may keep a service's `.claude` as a symlink into a root-tracked directory.
`scribe.path_translations` in `.claude/knowledge/config.yaml` lists the rewrites, each
`{from: "{service}/.claude", to: "shared/{service}/.claude"}`, and a rewrite applies only
when `<service>/.claude` really is a symlink. Staging
*through* the symlinked path is a hard git failure (`fatal: pathspec '...' is beyond a symbolic
link`); staging the real (translated) path succeeds. Every place that
stages or diffs a KB path — the commit itself, and both of `kb_commit_guard`'s snapshots — must
translate to the real path first, not after (`kb_commit_guard.normalize_path`, in
`"${CLAUDE_SKILL_DIR}/../../scripts/kb/kb_commit_guard.py"`). With an empty
`scribe.path_translations` nothing is rewritten.

## Commit authority

With `scribe.commit: commit` the scribe may commit in the root repo without asking: the user chose
that setting at setup. It never commits inside a submodule or a nested clone — propose the message
there instead, though this shouldn't arise since no KB path lives in one. The project's `_index.md`
may name its own conventions here. Never `git push`, no exceptions.

## Second-scribe guard: the run lease

The guard is on the **run**, not the session. A run holds `.claude/knowledge/.local/scribe-lease.json`
(run id, session id, host, started, refreshed) from the lease step until step 10 or the abort-time
rollback releases it. A second `/knowledge:kb run` refuses while the lease is fresh. A `/clear` or a
resume loses the run id from context, so that run is over: its lease goes stale, or the next run
takes it over after confirmation. A second scribe *session* can still start; its SessionStart brief
warns when a fresh lease is held.

The lease is necessary but not sufficient. It only catches a second *scribe run*. A live non-scribe
session can and has written inside the KB pathspec unrelated to any scribe run (three independent
observed collisions). This is exactly why step 0 and step 8 exist as a before/after pair around the
run, rather than relying on the lease alone: the snapshots catch writes by sessions the lease never
could.

## Non-goals

- No ledger, no peer, no hand-off protocol — the scribe is solitary.
- No auto-drop of stale queue entries — age and staleness are surfaced, never silently expired.
- No push, ever, from `/knowledge:kb run`'s own commit.
- No modification to the plugin's `check-on-edit.py` hook, the pre-commit hook, or
  `build_digest.py` — used as-is.

## First-run check (manual, not automated)

`/knowledge:kb run` is agent-followed prose, not a callable function — walk this once in a scratch checkout
before trusting it against the real queue and the real KB. RED-phase adversarial pressure-testing
already covers items 3 (step-9 ordering, under direct sunk-cost pressure), 5, and elements of 7
against the raw design — re-run the full checklist here against the *written* skill, not the prose,
since GREEN means a re-run against what actually ships:

1. Launch a scribe (`ccscribe`) against a throwaway clone. Confirm the brief injects with the
   queue count, and that a typed `/knowledge:kb run` in a plain session is blocked by the gate.
2. From a separate session, `/knowledge:kb <text>` a couple of observations. Confirm they land in
   `.claude/knowledge/.local/queue.md`, `consumed=false`.
3. In the scribe session, `/knowledge:kb run`. Confirm the combined plan lists the pushed rows; ROUTE/MEMORY
   dispositions write through `knowledge:knowledge-route`/auto-memory; the digest rebuild runs before the
   guard's "after" snapshot; `git add --` runs before `git commit --`; the commit lands
   pathspec-limited with no push; post-commit verification passes; only the ROUTEd/MEMORYed rows
   are removed from `.claude/knowledge/.local/queue.md`.
4. Mid-run, from a third session, edit a tracked KB YAML file while the plan sits awaiting
   disposition. Confirm the guard catches it, the run aborts, rollback restores exactly what this
   run had written, and no queue row is marked consumed.
5. Start `/knowledge:kb run` in a second scribe while the first run holds the lease (sitting at the
   plan). Confirm refusal naming the first run's session, host and times, and a takeover offer only
   through AskUserQuestion.
6. Kill the first scribe and let `scribe.lease_minutes` pass (or set it to 1) — confirm the stale
   lease does not block a new run and that the replaced holder is reported. Also corrupt the lease
   file by hand and confirm the run proceeds with a warning, never a traceback.
7. **Obligation 1, blocking path.** Push an observation that, once routed, makes the scoped
   `knowledge:knowledge-check` re-run at step 6 report a blocking finding (e.g. it duplicates a rule the
   pathspec already carries). Confirm the run aborts at the gate, the write-manifest rollback
   fires (no digest rebuild, no commit), and the queue row stays `consumed=false`.
8. **Obligation 1, recommended path.** Push an observation that routes clean but that
   `knowledge:knowledge-check` flags only as non-blocking. Confirm the run completes normally and the
   finding is surfaced alongside the commit confirmation, not silently dropped.
9. **New in GREEN, not covered by any RED scenario yet.** In a checkout with no
   extra `scribe.pathspecs` directories at all, confirm step 9.1's `expand_pathspec` correctly
   produces a pathspec of just `.claude/knowledge` and the commit does not abort.
10. **New in GREEN.** Force a post-commit verification mismatch (e.g. stub the write manifest to
    omit a file steps 5-7 actually wrote) and confirm the run reports a hard error and does not
    proceed to marking any row consumed, even though the commit already landed.
11. **DROP is final.** DROP one queue row and ASK another, then `/knowledge:kb run` again. Confirm the
    DROPped row is gone from `.claude/knowledge/.local/queue.md` and absent from the new plan, while the ASK row
    is listed again.
