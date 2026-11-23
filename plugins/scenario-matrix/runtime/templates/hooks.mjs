// Project hooks. Every export is optional and is commented out here: remove the
// comment on the ones you need. Nested names are `export const <group> = {...}`.
// Hooks that belong to an adapter are described in that adapter's section of harness-api.md.
// Each entry states its signature, the module that calls it, and what happens
// when it is absent.

// export const lifecycle = {
//   // isWarm({ reg }) -> boolean
//   // Called by run.mjs before bringing the environment up. Absent: warm when the warm marker file named in scenarios.config.json exists.
//   isWarm({ reg }) { return false; },
//
//   // warmUp({ reg }) -> void
//   // Called by run.mjs instead of bringUp when isWarm is true. Absent: runs reset.baseline.
//   warmUp({ reg }) {},
//
//   // bringUp({ epic, rows, reg }) -> { ok: true } | { refused: string }
//   // Called by run.mjs once per run; a thrown Blocked also counts as a refusal.
//   // Absent: runs lifecycle.up from scenarios.config.json, or does nothing when that is null.
//   bringUp({ epic, rows, reg }) { return { ok: true }; },
//
//   // verifyUp({ reg }) -> void
//   // Called by run.mjs after bringUp or warmUp, before any row; throw to stop the run. Absent: no check.
//   verifyUp({ reg }) {},
//
//   // runFacts({ reg }) -> object
//   // Called by run.mjs after the rows, before tearDown, to record facts about this run. Absent: {}.
//   runFacts({ reg }) { return {}; },
//
//   // tearDown({ reg }) -> void
//   // Called by run.mjs at the end of a run, unless bringUp refused. Absent: runs lifecycle.down, or
//   // does nothing when that is null.
//   tearDown({ reg }) {},
// };

// summaryExtras(facts) -> object
// Called by run.mjs when it writes results.json, with what runFacts returned; truthy values are
// copied into the summary. Absent: the summary carries no extras.
// export function summaryExtras(facts) { return {}; }

// registry(raw, opts) -> { accessors?(reg): object, validate?(): void }
// Called by registry.mjs while loading a matrix; accessors are added to the registry object and
// validate runs after loading. Absent: only the adapters' accessors and checks apply.
// export function registry(raw, opts) { return {}; }

// resolveHost(alias, { tenant, reg, use }) -> string
// Called wherever an alias is resolved: by login.mjs (browser adapter) and http.mjs (http adapter);
// use is 'marker', 'navigate' or 'http'.
// Absent: reg.host(alias), with https:// added for 'navigate' when the value has no scheme.
// export function resolveHost(alias, { tenant, reg, use }) { return alias; }

// requirementGate(row, reg, ctx) -> string | null
// Called by the scenario wrapper (scenario.mjs) before a row that declares `requires`; a string skips
// the row with that reason, null lets it run. A row without `requires` never reaches it.
// Absent: a row that declares `requires` is BLOCKED, because nothing could check it.
// export function requirementGate(row, reg, ctx) { return null; }

// export const login = {
//   // ops -> { [op]: { run(step, env): Promise<void>, browserFree?: boolean, consumes?: string[] } }
//   // Looked up by login.mjs for a recipe line whose first word is not a built-in op.
//   // Absent: only the built-in ops exist.
//   ops: {},
//
//   // transformRecipe(lines, { name, tenant, reg }) -> string[]
//   // Called by login.mjs on a recipe's lines before they run. Absent: the lines run as written.
//   transformRecipe(lines, { name, tenant, reg }) { return lines; },
// };

// http.extendClient(client, { reg, tenant, opts }) -> void
// Called by http.mjs on every client it builds, to add project members; opts are the options the client
// was built with. Absent: the client is left as built.
// export const http = { extendClient(client, { reg, tenant, opts }) {} };

// reset.baseline({ reg }) -> Promise<void>
// Called by reset.mjs, and by the default warmUp, to put the project's data in its known state.
// Absent: the baseline command from scenarios.config.json runs, or nothing happens when that is null.
// export const reset = { async baseline({ reg }) {} };

// export const lint = {
//   // context(raw) -> object
//   // Called by lint.mjs once per matrix; the result is passed to every rule. Absent: {}.
//   context(raw) { return {}; },
//
//   // rules(ctx) -> Rule[]
//   // Called by lint.mjs after the adapters' rules are collected. Absent: the project adds no rules.
//   rules(ctx) { return []; },
// };

// selftest.probes(reg, { config }) -> Probe[]
// Called by selftest.mjs after the adapters' probes are collected, for checks that cross adapters.
// Absent: the project adds no probes.
// export const selftest = { probes(reg, { config }) { return []; } };

// export const check = {
//   // keys -> { [envRegistryKey]: (value) => string | null }
//   // Read by check.mjs to validate env_registry keys the core and the adapters do not know; a string
//   // is the error. A key no adapter and no hook names passes unchecked.
//   // Absent: every such key passes unchecked.
//   keys: {},
//
//   // rowFields -> { [field]: (value, row) => string | null }
//   // Read by check.mjs to validate extra row fields; a string is the error. A field the hook does
//   // not list passes unchecked, and so does a listed field a row leaves out.
//   // Absent: every extra field passes unchecked.
//   rowFields: {},
// };

export {};
