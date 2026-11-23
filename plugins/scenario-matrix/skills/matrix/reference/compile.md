# Compile procedure (`<epic> compile [selection]`)

Turns a built row into an executable script under
`.claude/scenarios/_scripts/<epic>/<id>.mjs` and rehearses it once, live,
before the row is trusted. A compiled script shares the whole-file exit
contract: `0` OK, `1` KO, `2` INCONCLUSIVE, `3` STALE (the script's own
runtime gate found the `compiledFrom` it was given no longer matches the
row's current hash; `run.mjs --plan` reports the same underlying condition
statically, from the header line, before any script runs — see step 4 of the
Procedure for how the two relate), `4` BLOCKED (a precondition failed, e.g. a
`login:` op). Rehearsal at compile time only ever meaningfully lands on
`0`/`1`/`2` — a script can't be STALE against the row it was just compiled
from, and a BLOCKED rehearsal reads as a compile-time precondition problem to
fix, not a result to stamp.

Read `.claude/scenarios/_lib/harness-api.md` and
`.claude/scenarios/_lib/project-api.md` before compiling. Together they list
the levers a compiled script may call: the core, one section per installed
adapter, then the project's own levers. This page never lists levers by name.
A lever those pages do not document does not exist yet (see Ops with no lever
yet).

## Ops with no lever yet

An authorable op can have no exported lever in `_lib/index.mjs`. Check
`_lib/harness-api.md`: unless the project has written one, `env-file:
{service, set, restart}` and the scenario-level `artifact: {kind, source,
target?}` op have none (a run-level `infra.artifacts` entry is a different
shape — the project's bring-up injects it, not a script-level lever). An op
the project declares is in the same state until the project writes its lever.
If a row's `setup`/`mutate` carries such an op, do not hand-roll it when
writing the script: no raw `fs` write to a service's `.env`, no raw copy into
a container, no shelling out around `index.mjs`. A compiled script imports
only from `index.mjs`, and while `lint.mjs` does refuse an import under
`_lib/` that isn't `index.mjs`, a hand-rolled version built on `node:fs` or
`node:child_process` — neither of which is under `_lib/` — lints clean while
being exactly the kind of environment-reach-outside-the-lib the lint exists
to prevent. Build the missing lever instead.

The same rule covers an API-only row, one that drives the product over HTTP
with no browser at all: the browser-free request client that
`_lib/harness-api.md` documents is the lever for it (logged in by whichever
recipe `_lib/project-api.md` documents for API-only rows), and it carries its
own cookie jar. Do not reach for `node:https` or a shelled-out `curl` because
the row happens not to need a page.

A fixture op can also have a lever-free route. A stub that re-reads its
fixture file from disk on every request can serve a fixture every scenario
shares from a versioned file under `_infra/`, already being served by the
time a script runs. The script then **verifies** the fixture instead of
writing it — it duplicates the literals it depends on and `blocked()`s if the
stub is not serving them, so a fixture change fails loudly at the
precondition rather than silently downstream. That works only for additive,
shared fixture state; a row needing a fixture that contradicts another row's
must call the fixture lever instead, because rewriting the tracked file
mid-run is the same violation as hand-rolling `env-file`.

The route is one of two:
- Build the lever in `_lib` first, with its guard, then compile against it.
  For `env-file`: snapshot the target file before writing, restore it even
  when the scenario fails, and refuse a `set` that would repoint a DB
  host/name outside the `scn_*` stack. For `artifact`: refuse an absolute,
  `..`-escaping, or product-tree source — the same rule the authoring-time
  self-check (`check.mjs`, Self-check after every write in
  `${CLAUDE_SKILL_DIR}/SKILL.md`) already enforces on the yaml, now needed at
  execute time too. Document the new lever in `_lib/project-api.md`.
- Or leave the row uncompiled. That is safe and visible, not a silent gap:
  `run.mjs` records an uncompiled row as `BLOCKED` with `why: 'uncompiled'`
  and never executes it.

## Procedure

1. Require the scn stack up and `_lib/selftest.mjs` green before compiling
   anything — compiling against a broken lever bakes in a false green:
   ```bash
   cd <repo-root>/.claude/scenarios
   node _lib/selftest.mjs <epic>
   ```
   `selftest: N check(s) ran, M failed` with `M` above `0` — stop and fix the
   lever (or ask) before writing any script against it.
2. Run the setup rehearsal. A database adapter that has one adds a section
   about it to `_lib/harness-api.md`, with the command to run over the
   matrix. It executes every scenario's `db` setup statements against the
   real schema without leaving a change in the scenario databases, so a
   statement that does not fit the schema is found before any script is
   written against it. The rehearsal is mandatory before a row is stamped
   `verified`: a row whose setup fails it gets its `setup` fixed first,
   never a `verified` stamp. If no installed adapter's page has a rehearsal
   section, say that the pre-rehearsal is unavailable for this project; the
   rehearsal of the compiled script (step 5) still applies.
3. Read the row plus the code under test; resolve endpoints and selectors.
4. Write `_scripts/<epic>/<id>.mjs`, importing from `_lib/index.mjs` and
   nothing else, with asserts derived from `expected`. `index.mjs` is the
   single import surface (a host/container rename then stays a one-file
   edit), and `lint.mjs` does enforce that specifier rule: any import under
   `_lib/` whose tail is not `index.mjs` fails the lint. That rule is the
   load-bearing one, because `index.mjs` deliberately does not re-export
   the raw process-boundary helpers the adapters use internally — going
   through it is what makes the raw levers unreachable rather than merely
   discouraged. If a script needs a lever `index.mjs` lacks, re-export it
   through `project-exports.mjs`, which the generated `index.mjs`
   re-exports; never open a second import path.
   What `lint.mjs` canNOT see, so do not read a clean lint as proof of it:
   it is a textual matcher, not a call-graph analysis. A script that imports
   `node:child_process` directly, or assembles a shell string at run time,
   lints clean. The shell-string rules the adapters add (the `Lint:` lines
   under each adapter's "Other contributions" in `_lib/harness-api.md`)
   match literal text at the call site, not argv arrays.
   Clean means "no known bypass shape is present"; reading the script is
   still the guarantee.
   The file needs a `#!/usr/bin/env node` shebang and a header line reading
   exactly `// scenario: <id> compiled_from: <hash>`; `lint.mjs` parses that
   header line statically — the header's id must equal the row id, and
   whenever the CLI supplies the row's current hash the header's hash must
   equal it too, so a header left stale against a row that changed since
   compile fails lint with a "recompile" message rather than passing
   silently — and also requires a `scenario(...)` wrapper call to be
   present at all (see Self-check in `${CLAUDE_SKILL_DIR}/SKILL.md`). Neither
   of those static checks is what the *runtime* staleness gate reads, though.
   `scenario()`'s only staleness input is the `compiledFrom` key of its own
   third argument:
   `scenario(id, fn, { metaUrl: import.meta.url, compiledFrom: '<hash>' })`.
   Its internal `checkStale()` opens with `if (!compiledFrom) return;`, so a
   script whose `scenario()` call omits `compiledFrom` never checks staleness
   at runtime — silently, forever, with no error and no warning. `lint.mjs`
   does not catch the omission either: its wrapper check is a bare
   `scenario('` regex that never inspects the third argument. This is
   not a theoretical gap — `run.mjs`'s run loop only special-cases
   `uncompiled` scripts; a `stale` script is spawned exactly like a `fresh`
   one, so the driver has no independent backstop and relies entirely on the
   script's own runtime gate to self-report `STALE`. So the compile step
   must write BOTH the header line AND pass
   `{ metaUrl: import.meta.url, compiledFrom }` as the `scenario()` call's
   third argument, using the same hash for the header and for
   `compiledFrom` — never one without the other.
5. Rehearse:
   ```bash
   cd <repo-root>/.claude/scenarios
   node _scripts/<epic>/<id>.mjs
   ```
6. Exit `0` (OK) -> stamp `script` (the path just written), `compiled_from`
   (the hash `_lib/hash.mjs`'s `compiledFrom()` computed for this row), and
   `compiled: "verified <date>"`.
7. Exit `1` (KO) -> decide script-wrong (a bad selector/endpoint/assert in
   the script itself — fix the script and re-run) versus product-wrong (the
   code under test doesn't do what `expected` says). Product-wrong: leave
   `compiled: "pending <bug ref>"` and report the bug — never bend the
   script's assert to match what was observed.
8. Exit `2` (INCONCLUSIVE) -> the assert is subjective-UX and the script
   correctly called `inconclusive()` rather than guessing; keep that call and
   record `compiled: "pending inconclusive"`.

After compiling, run the compile-time checks in Self-check
(`${CLAUDE_SKILL_DIR}/SKILL.md`) to confirm the epic's overall compile state.
