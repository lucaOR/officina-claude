# Authoring compiled scenarios

How to write, lint, run and triage a compiled scenario in `.claude/scenarios/`. Read `README.md` first for the setup; this file assumes the environment already comes up.

A **scenario matrix** is `.claude/scenarios/<epic>.yaml`: one row per behaviour, each with a `behaviour`, a `reach`, a `setup` fixture and an `expected`. A **compiled scenario** is `_scripts/<epic>/<id>.mjs`, an executable assertion of exactly what that row's `expected` claims. The row is the specification, and the script is its enforcement. Everything below follows from that one relationship.

`_lib/harness-api.md` lists every function a script may import. This file says how to use them, not which ones exist.

---

## 0. The two standing policies

These outrank every other instruction here.

**Correct a provably wrong row.** A script's asserts must come from the row's own `expected` and `setup`. When either is provably wrong, correct the row and record the edit in the corrections table at the end of this file. The matrix stays the single source of truth and keeps its regression guards. "Provably wrong" means demonstrated against the product's source or a live observation, never "the run printed something else". The usual defects are a `setup` that never reaches the branch the row tests, so the row passes on a path that never executed, and an `expected` whose count or wording is wrong once the fixture is right.

**Never bend an assert to make a run green.** If the product does something `expected` forbids, that is a finding: report it, mark the row as pending that finding, and leave the assert alone. A red row that found a real bug is worth more than a green one.

The two policies pull in opposite directions on purpose. The first says to correct the row when the row is wrong, and the second says never to touch the assert when the product is wrong. Telling them apart is the judgement that makes the harness worth having. If you cannot tell, raise it instead of deciding quietly.

## 1. Author (offline, no environment needed)

Authoring reads the product's source and writes one file. Keep it offline on purpose: a script written while watching a run tends to encode what the run printed instead of what the row claims, which is exactly what section 0 forbids.

Read the row first with `node _lib/query.mjs <epic> <id>`. Then start from an existing compiled script with the same `reach`, because each reach has a settled shape that is easier to copy than to rederive.

Before writing asserts, re-check the row's own verdict. A row classified as compilable by reading alone can turn out to need a lever that does not exist. Section 6 covers what to do then.

## 2. Lint

    node .claude/scenarios/_lib/lint.mjs <epic>      # must print "lint: clean"

Lint-clean means no known bypass shape is present. It never means the script cannot reach the wrong environment, and `lint.mjs`'s own header lists what it does not close, so reviewing the script is still the guarantee.

## 3. Run

    node .claude/scenarios/_lib/run.mjs <epic> [family|id]

Run it serially: one `run.mjs` at a time, and nothing else touching the scenario environment while it goes. If you drive it from an agent, dispatch exactly one, and check the session's permission mode first, because an interactive prompt inside a background task stalls it invisibly and the run just looks hung.

`run.mjs` owns the environment's lifecycle at both ends. After it finishes, the environment is down, so a compiled script run by hand straight afterwards fails on the missing environment. That failure is typed BLOCKED and has nothing to do with the script. Bring the environment up with `_infra/up.sh` first, or set `SCN_KEEP_WARM=1` on the run before it.

## 4. Triage

    KO            the script is wrong until proven otherwise; then report the finding and
                  mark the row pending it. Never bend the assert.
    BLOCKED       a precondition or a missing lever. Not a bug, never filed as one.
    INCONCLUSIVE  keep the inconclusive() call and mark the row pending inconclusive.
    STALE         recompile and rerun; leave the row's status untouched.
    SKIPPED       requirementGate returned a reason; read it.

The exit codes are `0` OK, `1` KO, `2` INCONCLUSIVE, `3` STALE, `4` BLOCKED, `5` SKIPPED.

BLOCKED is not a silent pass. Every BLOCKED gets read and attributed, because the harness routes the conditions it cannot judge here instead of guessing, and an unexamined BLOCKED is the one way a batch can quietly lose a real signal.

Attributing a BLOCKED never licenses fixing it by hand. Never edit a shipped service config or a deployment file to make a scenario pass. A scenario that cannot pass without such a change is a finding: report it and leave the row BLOCKED. A typed BLOCKED that names a real environment defect is the harness succeeding.

## 5. Traps that bite a batch

- **A fixture that omits a column the product treats specially.** A missing value is not the same as a default, and a null can take a different branch from the value the product would have written itself. Seed every column the branch under test reads, explicitly.
- **A fixture that never reaches the branch.** Before trusting a green row, check that its `setup` makes the product take the path the row names. Make the negative control as real as the positive one: a row that claims "X is not sent" needs a live path on which something else is sent.
- **A shared singleton that a retry loop can exhaust.** A component that gives up for good after a few failed attempts will fail every later row, however correct. When a stub is broken, stop and ask for the restart; do not keep retrying.
- **A fixture identity shared with another row.** Rows run on one shared environment, so make each row's identities unique.

## 6. `needs-lever` and `non-compilable` rows

Neither is skipped silently. Both are recorded, and both change what a batch reports.

- **`needs-lever`**: the behaviour is assertable and the harness has no way to reach it. Either build the lever first, with its guard and its test, and then compile against it (section 11), or leave the row uncompiled. Leaving it uncompiled is safe and visible: `run.mjs` records it as BLOCKED with `why: 'uncompiled'` and never executes it.
- **`non-compilable`**: no assert exists to write. Record the reason on the row and move on. Do not invent an assert to have something to compile.

Before believing either verdict, check whether the blocking clause is load-bearing on the claim the row actually makes. A clause that looks blocking is often bundled onto the row beside the real claim and can be dropped without weakening it. A comparison across rows, or a property that lives inside a process no lever can read, is usually of that kind.

The commonest genuine non-compilable is a row whose `expected` is a placeholder such as "OPEN". That is an undecided acceptance criterion, which is a product gap and not a harness one. Raise it as a product question.

## 7. Authoring contract

- **Both staleness stamps, same hash.** The header line `// scenario: <id> compiled_from: <hash>` and `{ metaUrl: import.meta.url, compiledFrom: '<hash>' }` as `scenario()`'s third argument. Take the hash from `node _lib/hash.mjs <epic> <id>`. The two are checked in different places and neither substitutes for the other: `lint.mjs` and `run.mjs --plan` compare the header with the freshly computed hash before a run, and the argument is the run-time gate that stops a stale script mid-flight.
- The row's own `compiled_from` field is a stamp in appearance only. Nothing reads it, because the hash covers `id`, `behaviour`, `reach`, `env`, `setup` and `expected`. Keep it accurate as provenance, and never treat it as a gate.
- Import from `_lib/index.mjs` only. Importing a Node built-in such as `node:fs` or `node:child_process`, or building a shell string at runtime, can lint clean while defeating the guards.
- No unused imports and no unused top-level helper or constant. A helper copied from a sibling script and never called reads like an assert the row makes, and `lint.mjs` reports both.
- `fail()` is a product failure, `blocked()` is an unmet precondition, and `inconclusive()` means the harness cannot tell. Never use `fail()` for a missing precondition.
- Make fixture identity unique to the row, and delete the row's own rows before seeding, so a half-finished earlier run cannot make this one pass or fail for the wrong reason.
- One assert per clause of `expected`, each with a failure message that names the expected and the observed value.
- Cardinality as well as identity. An assert that only checks "item X has outcome Y" cannot see a spurious extra item, so every bucket for which `expected` gives a count gets an explicit count assert.
- Asserts come from `expected`, never from what the first rehearsal printed.
- A clause with no observation point is raised, never guessed at.
- Retries are opt-in per row: `retries: N`, and optionally `retry_delay_ms: N`, which backs off linearly. They make `scenario()` rerun the whole attempt, reset and setup included, up to N extra times on KO or BLOCKED. INCONCLUSIVE never retries, because it means the row asked for something no attempt count can fix. Evidence on disk reflects the last failing attempt, and the NDJSON line carries `attempts` whenever more than one attempt ran, so a retried pass stays visible in triage. Reserve retries for a row whose root cause is genuinely unknown. When the cause is known, fix the design, because retrying a known coin flip only rerolls it.

## 8. Classification rules

**Never let a `try` span an action that drives the product when its catch classifies `blocked()`.** Laundering a KO into BLOCKED is the worst failure this harness can have: it removes a real product bug from the count and points the reader at innocent infrastructure. Where a case is ambiguous, resolve it before the action, on independent evidence, instead of in a catch around it. Diagnose a precondition first, and then leave the action free to mean exactly what it says.

**An action against a stand-in's own interface must rethrow `blocked()`, and an action against the product's must stay KO.** The test is always whose interface it is. A failure in a stand-in the harness supplies would otherwise accuse the product.

**Check a marker's `.kind` before using its `.value`.** `reg.marker()` returns `{kind, value}`. Markers sit outside the hashed fields and the lint is textual, so retyping a marker from one kind to another can make an assert test a value of the wrong kind, never match, and pass vacuously forever. Guard the kind and call `inconclusive()` when it changes.

**Pass an evidence-capture function as the identifier, not as a string.** A string does not crash, because the wrapper guards the call, but it silently yields an empty evidence directory on exactly the failing runs where the evidence is needed.

## 9. Observation-point preference

Prefer the earliest observation point that can answer the clause:

1. **Persisted state**, read through the data levers, for anything the product stores.
2. **A stand-in's request journal**, for "sends X downstream". It observes what the product actually sent, so a bug outside the perimeter cannot fail an inside row.
3. **An intercepted response**, for anything the interface renders but does not store.
4. **A log**, last, for behaviour that leaves no other trace.

A journal has no per-row reset of its own, unlike the baseline-restored data, so a script that reads one clears it first. Never re-implement a control-plane call privately in a script. If a lever is missing, build it (section 11) and export it from `index.mjs`, instead of reaching around it.

A single-row read that throws `Ko` on more than one row deserves care, because `Ko` means the product misbehaved. An unbounded read on a shared table reports a harness condition as a product bug. Use it only where something makes at-most-one true, such as a primary key. Elsewhere, read all the rows and triage the cardinality explicitly. Adding `LIMIT 1` is the wrong fix, because it picks arbitrarily and hides the condition.

## 10. Poll and wait triage follows the row's own `expected`

No fixed rule says what a terminal status means. It depends on what the row claims. One row may treat a terminal status as a real `fail()` because its `expected` says that outcome must not happen, and another may treat the same observation as the signal that it is safe to check a stand-in, because its `expected` is silent on that status.

Asserting on something `expected` is silent about is an invented assert. For the same reason a poll timeout is triaged by what the row's own `expected` makes of each state, never collapsed to one verdict.

## 11. Adding a lever

A lever is a project function that a script imports from `index.mjs`. Add one when a row first needs something the installed adapters do not offer, and check `_lib/harness-api.md` first, because the adapter you need may already have it.

1. Put it in its own file under `_lib/`, and name it for what it does.
2. Before writing the body, answer five questions in the file's header comment:
   1. How is it stood up for real?
   2. How do you know it is ready, without waiting a fixed time?
   3. What deterministic marker shows it processed something?
   4. How do you force it to fail and undo that?
   5. What does it do that the others do not?
3. Guard it. A lever that can reach the wrong environment checks first, and throws `Blocked` when the environment is at fault and `Ko` only when the product is.
4. Test it under `_lib/test/` with `node --test`, offline, with no real environment.
5. Export it by name in `_lib/project-exports.mjs`, then regenerate `index.mjs` and `harness-api.md`.
6. Document it in `_lib/project-api.md`.

A project's own file in `_lib/` is project-owned: the plugin never replaces it, and a file the manifest does not list is yours.

---

## Row corrections

Every edit made to a row's own fields under the "correct a provably wrong row" policy, so the matrix's drift from its authored state is auditable in one place. A batch appends here and never silently amends a row.

| id | field | what was wrong | batch | hash before and after |
|---|---|---|---|---|
