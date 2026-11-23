# Scenario harness API

This page documents the core of the harness: the names it exports, and the hooks a project can define in `hooks.mjs`. Each installed adapter appends its own section after this one, so the adapter levers and hooks are documented there and not here.

Every export below is available from the project's `index.mjs`. A compiled script imports from `index.mjs` and never from the files behind it.

## Core exports

### Scenario wrapper (`scenario.mjs`)

`scenario(id, fn, deps = {})` runs one row. `fn` receives a context `{ epic, id, page, browser, cleanups }`. The wrapper checks that the compiled script is not stale, applies `requirementGate`, runs the `reset` it was given, runs `fn`, and then runs the registered cleanups in reverse order, each one guarded so that a throwing cleanup never changes the verdict. It reports the typed outcome as one result record.

A compiled script passes these members of `deps`:

- `metaUrl: import.meta.url`, always. The wrapper takes the epic from the name of the script's parent directory, `_scripts/<epic>/`, so a script never hardcodes it.
- `compiledFrom: '<hash>'`, always, with the same hash as the script's header line. It is the only input of the runtime staleness gate. When it is absent, the gate is skipped without a warning, and a stale script runs as if it were fresh.
- `reset: ctx => reset(loadRegistry(ctx.epic))`, when the row needs the environment in its known state. The wrapper calls it before each attempt. When it is absent, the wrapper resets nothing.
- `captureEvidence`, when an adapter provides an evidence capture, such as the browser adapter's `screenshot`. The wrapper calls it after a KO or BLOCKED attempt, with the context and the evidence directory. When it is absent, no such evidence is captured.

The other members, `captureServerLogs`, `today`, `registry`, `onCtx` and `epic`, are test seams that compiled scripts never pass.

The wrapper types the outcome of `fn`:

| Thrown | Result | Exit code | Meaning |
| --- | --- | --- | --- |
| nothing | OK | 0 | The expected behaviour was observed. |
| `Ko` | KO | 1 | The product did something other than expected. |
| `Inconclusive` | INCONCLUSIVE | 2 | The row could not decide, for example a missing precondition. |
| any other error | KO | 1 | An untyped failure is read as a product failure. |
| `Blocked` | BLOCKED | 4 | The environment failed, so nothing was learned about the product. |

STALE (3) is reported when the row's `compiled_from` hash no longer matches the matrix, and SKIPPED (5) when `requirementGate` returned a reason.

- `fail(why)` throws `Ko(why)`.
- `blocked(why)` throws `Blocked(why)`.
- `inconclusive(why)` throws `Inconclusive(why)`.
- `Ko`, `Blocked` and `Inconclusive` are the three error classes. A lever types its own throws with them, and `Blocked` is the right type whenever the failure is the environment's and not the product's.

### Registry (`registry.mjs`)

`loadRegistry(epic)` reads `<epic>.yaml` from the scenarios directory, or from the directory named by `SCN_MATRIX_DIR` when that is set, and returns the registry object. The core accessors are `epic`, `raw`, `rows`, `row(id)`, `host(alias)` and `resolve`. Each installed adapter adds its own accessors, and the project's `registry` hook can add more. A name defined twice is refused rather than overwritten.

### Hash (`hash.mjs`)

`compiledFrom(row)` returns the first 12 hex characters of a sha256 over the canonical JSON of the row's `id`, `behaviour`, `reach`, `env`, `setup` and `expected` fields. Other fields, such as `status`, `steps` or `priority`, never change it. A compiled script carries the value in its header line `// scenario: <id> compiled_from: <hash>` and in its `scenario()` call.

### Observation (`observe.mjs`)

`scnFetch(url, { method, body, headers, servername })` is a request helper over Node's own `http` and `https` modules. It does not follow redirects, because a lever that silently followed one would be judging a page it never asked for. It accepts any certificate, honours a `Host` header and a TLS `servername`, and resolves to `{ ok, status, text(), json() }`. A transport failure rejects with a `Blocked`.

### Faults and concurrency (`fault.mjs`)

`race(n, fn)` runs `fn(0)` to `fn(n - 1)` at the same time and resolves to a list of `{ ok: true, value }` or `{ ok: false, error }`, in index order. It never rejects.

### Reset (`reset.mjs`)

`reset(reg, { steps, baseline })` puts the environment in its known state. It runs the phases `prepare`, `restore`, `probe` and `normalize` in that order, running every step the installed adapters contribute to a phase in adapter order. The baseline runs first in the `restore` phase. By default `baseline` is the `reset.baseline` hook, else the command named by `reset.baseline` in `scenarios.config.json`, else nothing. An error that is not already typed becomes a `Blocked`.

## Facade functions

Some names in the project's `index.mjs`, such as `logs`, `noLog`, `mail`, `mailCount`, `mailMessage`, `stub`, `routeFault`, `stubFault`, `dbFault`, `stopFault` and `schemaFreeze`, are facades. A facade is exported only when an installed adapter drives it. A project that has no adapter for a facade does not see the name in its index at all, and the generated `PROVIDERS` map records which catalog adapters can drive each one.

Calling a fault facade whose driver is missing throws a `Blocked` that names the adapter to add, and the command to add it with. For what a facade does, its arguments and its markers, read the api.md section of the adapter that drives it.

## Project hooks

Hooks are optional exports of the project's `hooks.mjs`. A nested name such as `lifecycle.isWarm` is a member of `export const lifecycle = { ... }`. Every default below lives at the call site, so the core never names a technology.

Hooks that belong to one adapter are namespaced by that adapter. Each adapter documents its own hooks in its section after this page, and this page does not list them.

### Lifecycle

All of these are called by `run.mjs`.

| Hook | Signature | Called | Default when absent |
| --- | --- | --- | --- |
| `lifecycle.isWarm` | `({ reg }) -> boolean` | Before bring-up. | Warm when the warm marker file from `scenarios.config.json` exists. |
| `lifecycle.warmUp` | `({ reg }) -> void` | Instead of bring-up when `isWarm` is true. A failure aborts the run. | Runs `reset.baseline`. |
| `lifecycle.bringUp` | `({ epic, rows, reg }) -> { ok: true } \| { refused: string }` | Once per run when the environment is not warm. A thrown `Blocked` also counts as a refusal. | Runs `lifecycle.up` from the config, or nothing when that is null. |
| `lifecycle.verifyUp` | `({ reg }) -> void` | After bring-up or warm-up, before any row, on both paths. Throw to stop the run. | No check. |
| `lifecycle.runFacts` | `({ reg }) -> object` | After the rows, before teardown, to record facts about this run. | `{}`. |
| `lifecycle.tearDown` | `({ reg }) -> void` | At the end of a run, unless bring-up was refused. | Runs `lifecycle.down` from the config, or nothing when that is null. |

`summaryExtras(facts) -> object` is a top-level hook, not a member of `lifecycle`. `run.mjs` calls it when `results.json` is written, with what `runFacts` returned, and copies its truthy values into the summary. Absent, the summary carries no extras.

A refused bring-up changed nothing, so the run records `refused` in `results.json` and tears nothing down.

A run writes its results under `<runsDir>/<epic>/<date>/`, where `runsDir` comes from `scenarios.config.json`. Run output may hold secrets, so `run.mjs` keeps `runsDir` out of git by writing a `.gitignore` containing `*` there when none exists. A project that wants to version its runs replaces the content of that file, and `run.mjs` never overwrites it. When that file cannot be written, `run.mjs` warns once on stderr and the run carries on.

On every KO or BLOCKED attempt, the scenario wrapper also writes a slice of each registered log source it can read to `<runsDir>/<epic>/<date>/<id>/logs/<service>.log`, next to the row's other evidence, without the script asking for it. The same directory holds `_sources.txt`, which lists each source with its line count or the reason it was skipped. Each installed adapter that contributes an `evidence` capture then writes its own files to the same row directory. A later attempt of the same row overwrites the files, and an OK attempt writes none.

### Registry and hosts

`registry(raw, opts) -> { accessors?(reg): object, validate?(): void }` is called by `registry.mjs` while a matrix loads. The accessors it returns are added to the registry object, and `validate` runs once loading is done. Absent, only the core and adapter accessors exist.

`resolveHost(alias, { tenant, reg, use }) -> string` turns a host alias into the host or URL a caller needs. It is called by every module that resolves an alias, and `use` says what the caller will do with the value:

- `'marker'`: the value is substituted into a marker pattern, as a host name.
- `'navigate'`: the value is opened as a page, so it must be a URL.
- `'http'`: the value is the target of a request client, as a host name or base URL.

Absent, the default returns `reg.host(alias)`, with `https://` added for `'navigate'` when the value carries no scheme. `tenant` is read from the option named by `tenantKey` in `scenarios.config.json`, and is `null` when no such key is set.

`requirementGate(row, reg, ctx) -> string | null` is called by the scenario wrapper before a row that declares `requires`. A string skips the row with that reason, and `null` lets it run. A row with no `requires` never reaches the hook. When a row declares `requires` and the project defines no gate, the row is BLOCKED rather than run unchecked, because nothing could have checked it.

### Login

- `login.ops -> { [op]: { run(step, env): Promise<void>, browserFree?: boolean, consumes?: string[] } }` adds ops to the login recipe engine. A recipe line is looked up here when its first word is not a built-in op, and an op may not redefine a built-in. `browserFree` marks an op that needs no page, and `consumes` lists the parameters that only this op applies: passing one when the op never ran makes the login INCONCLUSIVE. Absent, only the built-in ops exist.
- `login.transformRecipe(lines, { name, tenant, reg }) -> string[]` rewrites a recipe's lines before they run. Absent, the lines run as written.

### Clients

`http.extendClient(client, { reg, tenant, opts }) -> void` is called on every request client the harness builds, so a project can add its own members to it. `opts` are the options the client was built with. Absent, the client is left as built.

### Reset

`reset.baseline({ reg }) -> Promise<void>` puts the project's data in its known state. It is called by `reset.mjs` at the start of the `restore` phase and by the default `lifecycle.warmUp`. Absent, the baseline command from `scenarios.config.json` runs, or nothing happens when that is null.

### Lint

- `lint.context(raw) -> object` is called by `lint.mjs` once per matrix with the raw matrix, and the result is passed to every rule. Absent: `{}`.
- `lint.rules(ctx) -> Rule[]` is called after the adapters' rules are collected. A rule is `{ id, owner, kind: 'raw' | 'code', re, msg, mask? }`, `{ id, owner, kind: 'source', check(source, { id, hash, ctx }) -> string[] }` or `{ id, owner, kind: 'matrix', check(reg) -> string[] }`, and an id is a slug. Absent, the project adds no rules.

### Selftest

`selftest.probes(reg, { config }) -> Probe[]` is called by `selftest.mjs` after the adapters' probes are collected, for checks that cross adapters. A probe is `{ name, needs, run(reg, cfg) }`. Absent, the project adds no probes.

### Check

- `check.keys -> { [envRegistryKey]: (value) => string | null }` validates `infra.env_registry` keys that the core and the adapters do not know. A returned string is the error. A key that no adapter and no hook names passes unchecked, so the hook adds validation only for the keys it lists. Absent, every such key passes unchecked.
- `check.rowFields -> { [field]: (value, row) => string | null }` validates extra row fields. A returned string is the error. A field the hook does not list passes unchecked, and so does a listed field that a row leaves out. Absent, every extra field passes unchecked.
