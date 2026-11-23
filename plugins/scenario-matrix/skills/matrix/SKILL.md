---
name: matrix
description: Use when the user invokes /scenario-matrix:matrix, or asks to build, add, update, remove, list, or compile scenarios in a behaviour-driven test matrix for an epic — the living scenario tracker stored in .claude/scenarios/<epic>.yaml, whose rows compile into executable scripts.
argument-hint: '[<epic> [list | show <id> | build | add "<behaviour>" | update <id> <text> | remove <id> | compile [selection]]]'
effort: medium
---

# /scenario-matrix:matrix

`<repo-root>` below stands for the absolute path of this repository checkout: the
session's primary working directory, or the worktree's root when working in one.
Substitute it before running a command; never hardcode a machine-specific path.

Living, behaviour-driven test matrix per epic, stored versioned at
`.claude/scenarios/<epic>.yaml` (repo root). Hand-editable; this skill is how
Claude builds, compiles, and mutates it. Phase 1 of a two-phase method —
phase 2 is `/scenario-matrix:run`, which executes the compiled scripts
across a full run and reports results. This skill's own execution stays
scoped to `compile`'s rehearsals: the setup rehearsal, and the one-time
rehearsal of the script it just wrote for a row. The only fields it ever
writes back are the starting `status: open` that `build`/`add` produce and,
from `compile`, `script`/`compiled_from`/`compiled` (see Field rules in
`${CLAUDE_SKILL_DIR}/reference/schema.md`). Ongoing `status`/`last_run`/`bug_ref`
across a full run remain `/scenario-matrix:run`'s job.

**Reading it:** to inspect existing scenarios, query rather than `Read` the matrix — it
can run to thousands of lines, and a whole-file read of it is replayed on every later turn:

```bash
node .claude/scenarios/_lib/query.mjs <epic> <id>              # one record
node .claude/scenarios/_lib/query.mjs <epic> <family> --list   # id + status + behaviour
node .claude/scenarios/_lib/query.mjs <epic> --infra           # the preamble only
```

A selector matches an id exactly (case-insensitive), or else as an id prefix. No
match exits `1` and lists the available ids. `--json` prints the same selection as JSON.

A whole-file `Read` is right only when *writing* — `build`, `add`, `update`, `remove` —
where the surrounding lines are needed to place the edit.

One entry per **observable behaviour**, not per code path. `expected` is
always sourced from epic intent (acceptance criteria, design docs, PO
decisions) — **never inferred from what the current code does** (that just
rubber-stamps existing behaviour, bugs included). If intent can't be pinned
down, the scenario gets `expected: OPEN` rather than a guess.

## What to read, and when

| File | Holds | Read it |
|---|---|---|
| `${CLAUDE_SKILL_DIR}/reference/schema.md` | the matrix schema, field rules, state ops and artifacts | before `build`, `add`, `update` and `compile`, and whenever a field's meaning is in question |
| `${CLAUDE_SKILL_DIR}/reference/compile.md` | the compile procedure, and the ops with no lever yet | before `compile` |
| `.claude/scenarios/_lib/harness-api.md` | every lever a compiled script may import: the core page, one page per installed adapter (its registry keys, hooks, the setup rehearsal a database adapter contributes, and its `Verify:` lines), then the project's levers | before `build` and `compile` |
| `.claude/scenarios/_lib/project-api.md` | the project's own levers, and what the project declares beyond the schema | before `build` and `compile` |
| `.claude/scenarios/_lib/scenarios.config.json` | `dbPrefix`, `intent_sources`, and the `check` lists the self-check reads | before `build` |

The schema in this skill documents what the core self-check knows. Everything
else a row or the registry may carry is declared by the project or by an
installed adapter: extra row fields and registry keys (the `check.rowFields` and
`check.keys` hooks), login op fields, `env` hints, artifact kinds (config
`check.artifactKinds`, and each adapter's own). Those are documented in
`_lib/project-api.md` and `_lib/harness-api.md`, which is why both are read
before `build` and `compile`.

## Safety — dedicated databases only

`scn_` below is the default database prefix. The project's prefix is `dbPrefix`
in `_lib/scenarios.config.json`: read `scn_` as that value wherever this skill uses it.

- Every `db`/`mutate` `target` and every `env-file` DB-pointing `set` key MUST
  reference a dedicated, disposable scenario database (convention: `scn_*`,
  e.g. `scn_app`, `scn_accounts`). Never a dev, staging, or production database.
- When building or adding a scenario, refuse to write a `db`/`mutate`/`env-file`
  op whose target does not match `^scn_` (or whose `env-file.set` would repoint
  a service's `*_DB_HOST`/`*_DB_DATABASE` outside the `scn_*` stack). Ask the
  user for the correct scenario-DB name instead of guessing one.
- The dedicated `scn_*` stack is provisioned/torn down by `/scenario-matrix:run`
  itself (via `infra.provisioning`/`infra.teardown`), once per run. This skill
  never creates or tears it down — it only records the mechanism
  `/scenario-matrix:run` will execute.
- Every `artifact.source` (in `infra.artifacts` or a `setup` op) MUST resolve
  inside `.claude/scenarios/_artifacts/<epic>/`. Refuse to write an op whose
  `source` is absolute, `..`-escapes the store, or points at a product tree
  (a path config `check.forbiddenArtifactPaths` lists, a service's real config).
  A test fixture is authored in the store, never by editing shipped config.

## Commands

| Invocation | Behavior |
|---|---|
| `/scenario-matrix:matrix` | List every file in `.claude/scenarios/`: epic slug + scenario count + open count |
| `/scenario-matrix:matrix <epic>` or `list <epic>` | Render the matrix as a table: id, behaviour, reach, priority, status |
| `/scenario-matrix:matrix <epic> show <id>` | Print one scenario in full |
| `/scenario-matrix:matrix <epic> build` | Derive the full matrix from the epic's intent sources and memory (see Build procedure) |
| `/scenario-matrix:matrix <epic> add "<behaviour>"` | Draft one scenario (id, reach, priority, setup/steps, expected), show the draft, confirm with the user, then append |
| `/scenario-matrix:matrix <epic> update <id> <text>` | Update fields per instruction; show a diff of the scenario before writing |
| `/scenario-matrix:matrix <epic> remove <id>` | Hard-delete the entry; confirm first |
| `/scenario-matrix:matrix <epic> compile [selection]` | Write/refresh the executable script for each selected scenario (default: all), rehearse it live, stamp `script`/`compiled_from`/`compiled` (see `${CLAUDE_SKILL_DIR}/reference/compile.md`) |

Natural-language forms map to the same operations ("add a scenario to
billing for the duplicate-invoice case", "what scenarios are open on
billing").

## Build procedure (`build <epic>`)

1. Read the epic's intent to enumerate observable behaviours: the files the
   `intent_sources` globs in `_lib/scenarios.config.json` match, with `<epic>`
   replaced by the epic's slug, and relevant memory (per this repo's
   memory-routing rules). When `intent_sources` is empty, ask the user where
   the epic's intent (ACs, design docs) lives. Read `_lib/harness-api.md` and
   `_lib/project-api.md` too. One behaviour per scenario — not one row per
   code branch or per sub-case.
2. For every behaviour, resolve `expected` from a traceable intent source. If
   none exists, ask the user once; if still unresolved, write
   `expected: OPEN` and note why in the `behaviour` line. Never infer
   `expected` from what the code currently does.
3. Where a code `file:line` locator helps whoever runs the scenario later,
   put it in the `behaviour` line or a trailing comment — a locator aid, not
   the source of `expected`, and never required.
4. Establish `perimeter.in`/`perimeter.out` from the epic's known repo
   boundaries; ask if unclear.
5. Resolve `infra.provisioning`/`infra.teardown`/`infra.baseline_restore` —
   search for an already-existing out-of-band mechanism first (compose
   overlays, dump/load scripts, worker/queue startup commands, a prior
   harness's setup docs, the `lifecycle` and `reset` commands in
   `_lib/scenarios.config.json`) before asking. Check what each scenario's
   `reach` and `setup` actually need (containers, `.env` corrections,
   queued/async processing needing a worker) so `provisioning` is complete,
   not DB-only — and confirm `teardown` reverses every one of those. Only ask
   the user once per epic if genuinely nothing is found, and record the
   answer as given — including "not built yet" if that's the honest state.
   Never leave this unresolved silently; a matrix with `db`/`mutate` ops and
   no `infra` block, or an `infra` block missing `teardown`, is an incomplete
   build.
6. Assign `reach` and `priority` per scenario, draft `setup`/`steps` per the
   State ops rules in `${CLAUDE_SKILL_DIR}/reference/schema.md` (respecting the
   dedicated-database safety rule).
7. **Verify every referenced mechanism actually exists** before assigning
   `status: open` — an op that names a config key, a service, or any other
   mechanism must resolve against the real local stack, not be assumed.
   Concretely: an `env-file.set` key must be grep-confirmed present in the
   target service's `.env`/`.env.example`; anything else is checked with the
   `Verify:` lines under each adapter's "Other contributions" in
   `_lib/harness-api.md` (a table in a database, a command in a service, a
   file inside a container), or with a check the project documents in
   `_lib/project-api.md`. A target the local stack does not have is given a
   store artifact per Artifacts in `${CLAUDE_SKILL_DIR}/reference/schema.md`.
   A referenced mechanism that doesn't exist is a fabricated op — never write
   it; author the artifact, mark `blocked`, or ask.
8. Write the yaml, then run the Self-check below. Do not author any
   per-scenario directory, README, or run script.

## Error handling

- Unknown epic on `add`/`build`: offer to create
  `.claude/scenarios/<epic>.yaml` with `perimeter` established first.
- Unknown epic on read: list available epic files under `.claude/scenarios/`.
- Duplicate `id` on `add`: ask — suffix the new id or merge into the existing
  scenario.
- Malformed YAML on read: report the parse error and STOP. Never overwrite or
  regenerate a file that fails to parse.
- Unknown `<id>` on `update`/`remove`: list the file's ids.
- A drafted `db`/`mutate`/`env-file` op whose target isn't `^scn_`: refuse to
  write it, ask the user for the correct scenario-DB name.

## Self-check after every write

```bash
node .claude/scenarios/_lib/check.mjs .claude/scenarios/<epic>.yaml
```

`check.mjs` is the self-check. It replaces the inline check this method used
to carry, and it reads from the project what that check hard-coded: the
database prefix from config `dbPrefix` (default `scn_`), the artifact kinds
from config `check.artifactKinds` plus each installed adapter's, the product
paths an artifact source may not point into from config
`check.forbiddenArtifactPaths`, the login recipes that take no identity from
config `check.noIdentityRecipes`, and the extra `env_registry` keys and row
fields from the adapters and from the project's `check.keys` and
`check.rowFields` hooks. It checks:

- `epic` is a non-empty string; `perimeter.in`, `perimeter.out` and
  `scenarios` are lists.
- Every scenario has `id`, `behaviour`, `reach`, `priority`, `expected` and
  `status`, and no id repeats. `reach` is one of
  `browser`/`wiring`/`auth`/`be-only`/`ops`, `priority` one of `P1`/`P2`/`P3`,
  and `status` one of `open`/`verified`/`drift`/`blocked`. `expected: OPEN`
  must pair with `status: open`.
- Every `db` target in `setup` and every `db` target under a `mutate` matches
  `^scn_`. A matrix with any such target needs a top-level `infra` block with a
  non-empty `provisioning`, `teardown` and `baseline_restore`.
- Every artifact (in `infra.artifacts`, a `setup` op or a `mutate`) has a known
  kind and a `source` that is relative, inside the store, not under a forbidden
  product path, and present under `_artifacts/<epic>/`. A `seed` artifact's
  `target` must match `^scn_`.
- `infra.env_registry` is a mapping. `hosts` must be a map of alias -> string.
  `login` must be a map of recipe -> step list, plus `markers`, a map of
  marker -> literal assertion string. Once markers exist, every recipe's
  `expect-screen <marker>` must name a defined marker. Every other key is
  checked by the adapter or the project hook that declares it.
- A `login:` op names a `recipe`. Once a `login` block exists (membership is
  only enforced then), the recipe must be one of its keys. A recipe not listed
  in `check.noIdentityRecipes` needs an `id`. Once markers exist, a `stop_at`
  must halt at a defined marker.
- Each extra row field the project declares passes its `check.rowFields`
  validator.

Exit `0` with `OK` printed = pass. Exit `1` prints one problem per line: fix
the file and retry. Exit `2` means the file could not be read as a matrix (not
found, not valid YAML, or an unquoted date); for a parse error, see Error handling.
Never leave a written matrix file in a state that fails this check.

After compiling (or whenever a compiled script might have drifted from its
row), also run:

```bash
cd <repo-root>/.claude/scenarios/_lib
npm test                    # lib unit tests green
node lint.mjs <epic>        # every compiled script clean
node run.mjs <epic> --plan  # no unexpected stale/uncompiled
```

`lint.mjs` only lints scripts that exist on disk, so an epic where nothing
has been compiled yet also prints `lint: clean` — a clean lint is never
proof that everything is compiled. `run.mjs --plan` is what answers
completeness: it prints `fresh N · stale N · uncompiled N` plus the stale and
uncompiled id lists, taking no lock and running nothing. Any `stale` or
`uncompiled` count belongs only to scenarios `compile` hasn't reached yet —
never leave it unexplained.
