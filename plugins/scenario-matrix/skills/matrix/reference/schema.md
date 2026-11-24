# Matrix schema

This page holds the matrix schema, its field rules, the state ops and the
artifact store. It documents what the core self-check (`check.mjs`) knows.
A row field, op, login op field, `env` hint, artifact kind or `env_registry`
key beyond it is declared by the project or by an installed adapter, and is
documented in `.claude/scenarios/_lib/project-api.md` and
`.claude/scenarios/_lib/harness-api.md`. `scn_` stands for the database
prefix, `dbPrefix` in `_lib/scenarios.config.json` (default `scn_`).

## Schema

```yaml
epic: <slug>
perimeter:                       # repos in scope; bugs outside are ignored
  in:  [service-a, service-b]
  out: [service-c]               # e.g. mocked/stubbed, not under test
infra:                            # required whenever any scenario uses a scn_* op
  provisioning: "the ONE-TIME test-startup for the whole run: every
    container/service that must be up and fully functional (not just
    databases — mocks, stubs, queue workers if the epic queues anything),
    every .env correction needed (DB host/name repoints, worker/queue config,
    mock-endpoint URLs). Exact script/command path, or an explicit
    'not built yet' note — never a partial list."
  teardown: "the ONE-TIME test-shutdown, run once after the whole selected
    suite finishes: symmetrically reverses every change `provisioning` made —
    restores real containers/services, reverts every .env correction, stops
    any worker it started, drops the scn_* databases (including any
    <dbPrefix>rh_* clone a failed setup rehearsal left behind), and clears every log
    source an adapter declares (the run's accumulated logs — the same DB+log
    clean the per-scenario reset does, applied once at the end so teardown
    leaves the machine clean). Exact script/command path. Must undo everything
    provisioning did, not just stop containers."
  baseline_restore: "the PER-SCENARIO clean, run before each scenario:
    restore every scn_* database to clean baseline AND clear every log source
    an adapter declares. Cleaning after a scenario is one concept — reset DB
    data + clear logs — so both live in this one mechanism (does not touch
    containers/.env/workers, those stay up for the whole run via
    provisioning/teardown). The log-clear is non-optional: without it a long
    run's logs grow until a heavy request exhausts a service's memory and
    fails every route behind it. Exact script/command path (one script doing
    both, or a DB-restore script that itself calls the log-clear)."
  env_registry:                     # optional; the stable environment facts every row reuses
    hosts:   {app: app.example.test}                       # {alias: host}
    login:                                                 # {recipe: [step lines]} plus markers
      default: ["navigate {app}", "type {id} into email", "click \"Sign in\"", "expect-screen home"]
      markers: {home: "url:^https://app.example.test/home"}   # {marker: literal assertion}
    # every other key is declared by an installed adapter or the project (see Field rules)
  artifacts:                        # optional; run-level file fixtures (see Artifacts)
    - {kind: <run-level kind>, source: <kind-dir>/<file>}
scenarios:
  - id: <family-letter>-<number>  # e.g. B-01; unique within the file
    behaviour: "one line, observable, user- or system-facing"
    reach: browser                 # browser|wiring|auth|be-only|ops
    priority: P1                   # P1|P2|P3
    env: {app: web, authed_as: "scn-admin@example.test"}
    setup:                         # before-state, ordered, typed ops
      - db: {target: scn_app, <statement>: "INSERT INTO ..."}   # see State ops
      - artifact: {kind: seed, source: seeds/big-tenant.dump, target: scn_app}
    steps:                         # actions + mid-scenario mutations, ordered
      - login: {recipe: default, id: "scn-admin@example.test"}   # replay a login recipe (see State ops)
      - action: "log in as admin, click IMPORT on the external-source row"
      - mutate: {db: {target: scn_accounts, <statement>: "UPDATE account SET disabled=1 WHERE email='x'"}}
      - action: "click re-sync"
    expected: "row status=imported; account.auth_method=sso"
    status: open                   # open|verified|drift|blocked
    last_run: null                 # date + OK/KO, set by /scenario-matrix:run
    bug_ref: null                  # bug id in a run report, set by /scenario-matrix:run
    script: _scripts/billing/B-06.mjs     # relative to .claude/scenarios/; absent = uncompiled
    compiled_from: 9f31ac4b2e77           # hash of id+behaviour+reach+env+setup+expected at compile time
    compiled: "verified 2026-07-29"       # or "pending <reason>"; never set from a KO run
```

Required on every scenario: `id`, `behaviour`, `reach`, `priority`,
`expected`, `status`. `env`/`setup`/`steps` are optional but `steps` should be
empty only for scenarios with no executable action yet (rare — prefer
`blocked` with a `setup` note over an empty scenario). `script`/
`compiled_from`/`compiled` are optional and appear only once a scenario has
been compiled (see Field rules and `compile.md`); their absence just
means `run.mjs --plan` lists the scenario as `uncompiled`.

## Field rules

- `expected` is sourced from epic intent (an AC, a design section, a PO
  decision), never inferred from current code. If no intent source can be
  pinned down -> `expected: OPEN`. (There is no `provenance` field; a code
  `file:line` locator, when useful, goes in the `behaviour` line or a comment.)
- `expected: OPEN` always pairs with `status: open` and a trailing note
  `"unspecified — needs PO"` appended to `behaviour`.
- `reach` picks the levers the compiled script is written against. Every
  reach runs the same way — a Node script under `_scripts/` importing from
  `_lib/index.mjs` — so this is a statement about which levers the script
  needs, not about who or what drives it. The levers themselves are listed in
  `_lib/harness-api.md`, never here:
  - `browser` — drives the UI, so the script opens a real browser and
    replays a login recipe through the browser levers. Not a browser MCP
    server: the script runs headless and unattended under the batch driver.
  - `wiring` — cross-service HTTP call chain, reached from the script with
    the request and stub levers and asserted with the database and log
    levers; a pivot into the app through its in-app exec lever where the leg
    is auth-walled.
  - `auth` — single sign-on / OAuth / other login path (the login lever plus
    a marker assertion).
  - `be-only` — backend assertion only, no UI: the in-app exec, command and
    database levers.
  - `ops` — scheduler / queue / infra behaviour: the command and log levers,
    queue observation.
- A `login:` op's `recipe` MUST name a key in `env_registry.login`. This is the
  anti-loop contract: the recipe carries the literal steps, so
  `/scenario-matrix:run --plan` treats a resolvable `login:` op as NOT a gap
  (it closes the `auth_reality`/`exact_cmd` classes for that scenario). An
  unresolvable `recipe` fails the self-check.
- `status` lifecycle: `open` (not yet run, or expected unknown) -> `verified`
  (ran OK) / `drift` (ran, diverged from expected — a bug) / `blocked`
  (cannot run: missing infra or precondition). `build`/`add` always start a
  scenario at `status: open`; only `/scenario-matrix:run` advances it to
  `verified`/`drift`/`blocked`.
- `script`, `compiled_from`, and `compiled` are written only by `compile` (see
  `compile.md`) — never hand-authored or hand-edited. `compiled_from` is
  computed by `_lib/hash.mjs`'s `compiledFrom()` over the row's
  `id`/`behaviour`/`reach`/`env`/`setup`/`expected`; editing `steps` or
  `priority` does NOT change it and does NOT mark a compiled script stale.
  The yaml's `compiled_from` is a RECORD of what the script was compiled
  from, not the input to any check: nothing reads it. Both staleness
  comparisons read the SCRIPT HEADER — `run.mjs` for the
  fresh/stale/uncompiled plan, `lint.mjs` for its header check — against a
  hash recomputed from the row. So a `compiled_from` edited in the yaml alone
  changes nothing, and a header edited alone (without the matching
  `scenario()` third-argument `compiledFrom`) silently disables the runtime
  gate. Write yaml field, script header and `scenario()` argument together,
  always with the same hash.
  Once a scenario carries a `script`, the script — not `steps` — is the
  authoritative HOW: `steps` stays the human-readable draft `compile` reads
  from, and re-editing it after compiling is a documentation touch-up, not a
  behaviour change, until the next `compile` re-derives the script from it.
  `compiled: "verified <date>"` requires a green rehearsal (the script exits
  `0`) at compile time; a KO rehearsal never earns `verified` — it leaves
  `compiled: "pending <bug ref>"` and the discrepancy is reported as a bug
  against the code under test, never fixed by loosening the script's assert
  to match what was observed.
- `infra.provisioning`/`infra.teardown`/`infra.baseline_restore` are mandatory
  as soon as any scenario carries a `db`/`mutate`/`env-file` op — this is what
  `/scenario-matrix:run` reads for its precondition check, its once-per-run
  bring-up/tear-down, and its between-scenario restore, instead of discovering
  (or asking ad hoc) mid-run. Point at a concrete, already-real mechanism (a
  script path, a documented command) — never "TBD" or a vague description. If
  no such mechanism exists yet, say so explicitly (e.g.
  `"not built yet — ask before first run"`) rather than inventing one.
- `provisioning` and `teardown` are a matched pair covering the FULL run-level
  environment, not just the databases: every container/service the epic's
  scenarios need running, every `.env` value that needs correcting (DB
  host/name, and any queue/worker config if a scenario's `reach` depends on
  queued/async processing), and any worker process that must be started.
  `teardown` must reverse all of it — an epic where `provisioning` starts a
  worker but `teardown` doesn't stop it is an incomplete build.
- `baseline_restore` is the per-scenario **clean**, and clean means DB data
  AND service logs — not DB alone. The mechanism MUST also clear every log
  source an adapter declares (each adapter's page in `_lib/harness-api.md`
  says which logs it reads, and whether its own reset step already clears
  them); a DB-only reset lets a long run's logs grow until a heavy request
  exhausts a service's memory and blocks every route behind it. Wire the
  log-clear into the same reset chokepoint every execution shape already
  calls (e.g. the DB-restore function itself calls the log-clear), so no
  path can skip it — not a separate step an agent might forget.
- `env_registry` (optional) is the once-per-epic home for stable environment
  facts every scenario reuses — host aliases, login recipes, and the keys the
  installed adapters and the project declare (database access commands, in-app
  exec targets, the auth reality per surface, cross-cutting gotchas, and the
  like). It lets authoring and compiling tell a genuinely missing fact from
  one already resolvable: a step whose command/host/db/auth resolves against
  `env_registry` needs no new fact, and the compiled script reads it through
  the registry instead of repeating it. Author it once from known facts; never
  repeat these per scenario. The core knows two keys: `hosts`, a map of
  `{alias: "host"}`, and `login`, a map of recipe name to a list of step lines
  plus a reserved `markers` map of marker name to a literal assertion string.
  Every other key's shape is set by the adapter, or the project's `check.keys`
  hook, that declares it; read it in `_lib/harness-api.md` and
  `_lib/project-api.md`. Placeholders such as `{host}`/`{db}`/`{file}` resolve
  against the maps.

## State ops

Concrete, replayable, inline in the yaml. Never author per-case seed or
mutate files or per-case directories.

- `setup` — ordered list of typed ops applied before `steps`:
  - `db: {target, <statement>}` — an inline statement against a named
    scenario database. The field that holds the statement is the database
    adapter's; read it in `_lib/harness-api.md`.
  - `env-file: {service, set: {KEY: VAL}, restart: bool}` — edit a service's
    `.env` for a scenario that needs a different service configuration.
  - `artifact: {kind, source, target?}` — apply a file fixture from the
    artifact store (see Artifacts). `target` (required for `kind: seed`) obeys
    the same `^scn_` guard as `db`.
  - any further op the project declares (a stub's fixture state, for
    example), as `_lib/project-api.md` documents it.
- `steps` — ordered list; each entry is either `action` (UI click / curl,
  concrete values, no vague prose), `mutate` (same op shapes as `setup`,
  interleaved so ordering vs actions is explicit), or `login` (replay a named
  login recipe from `env_registry.login`):
  - `login: {recipe, id?, stop_at?, ...}` — replay a named login recipe from
    `env_registry.login`. `recipe` (required) names the recipe. `id` — login
    identity (required unless config `check.noIdentityRecipes` lists the
    recipe, because it cannot be handed an identity). `stop_at` — a recipe
    `expect-screen` marker to halt at, for scenarios asserting a mid-flow
    segment rather than a completed login (omit = run the recipe whole). Any
    other field is a parameter a project login op consumes, as
    `_lib/project-api.md` documents it. A `login:` op is normally a
    scenario's first `step`; a login failure is `blocked` (precondition),
    never a scenario `KO`.
- `env` (browser/auth reach only) — light hint: which `app`, optional
  `base_url`, `authed_as` to start pre-authenticated, plus any hint the
  project documents in `_lib/project-api.md`. Not a full FE fixture store —
  don't grow this.

## Artifacts — file fixtures the run injects, never product code

Some scenarios need a fixture that can't be an inline string: a
service-registry entry, a stub fixture, an oversized seed blob. These live in
a **versioned artifact store** beside the matrix, and are injected into the
*ephemeral* `scn_*` stack at run time — never written into product config.

- **Store layout:** `.claude/scenarios/_artifacts/<epic>/` (the `_` prefix
  keeps it out of the `<epic>.yaml` matrix glob). Subdirs by kind, such as
  `seeds/*` for oversized seed blobs. The project documents its own kinds'
  subdirs in `_lib/project-api.md`.
- **`source`** in any `artifact` op / `infra.artifacts` entry is a path
  **relative to `_artifacts/<epic>/`**. Never absolute, never `..`-escaping,
  never a path under a product tree (a path config
  `check.forbiddenArtifactPaths` lists, a service's real config). The store
  is the only legal source root.
- **Kinds** and where each is injected by `/scenario-matrix:run`. The core
  knows one:
  - `seed` — **scenario-level** (`setup` op); applies the seed file to
    `target` (must match `^scn_`).

  Config `check.artifactKinds` and the installed adapters add the others.
  `_lib/harness-api.md` and `_lib/project-api.md` say, for each, whether it
  is **run-level** (declared under `infra.artifacts`, not in a scenario's
  `setup`) or **scenario-level** (a `setup` op), and how the run injects it.

**Why not just edit the product config.** Adding a test-only fixture to a
service's shipped config registers it for *every* developer's local stack and
permanently changes local behaviour — pollution. The store + ephemeral-inject
path keeps the fixture clearly namespaced as test scaffolding and the shipped
image untouched.

**Build-time remedy for a target the local stack lacks.** When a scenario's
target (a service, a registry entry, a tenant) isn't registered in the local
stack, do **not** leave it `open` in the hope it runs, and do not silently
plan a product-config edit. Either (a) author a local-adjusted fixture under
the store and declare it in `infra.artifacts`, or (b) if that's a whole
provisioning job (services + properties + theme assets), mark the scenario
`blocked` with that reason. Verify the target actually exists locally (a
`Verify:` line in `_lib/harness-api.md`, a check in `_lib/project-api.md`, or
the local config) at build time rather than discovering it mid-run.
