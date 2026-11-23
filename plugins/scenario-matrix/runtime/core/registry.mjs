// Single source of environment facts for compiled scenario scripts: parses
// infra.env_registry out of the epic's matrix (.claude/scenarios/<epic>.yaml,
// or <SCN_MATRIX_DIR>/<epic>.yaml when that variable is set). The matrix is
// read by matrix.mjs, which parses it exactly as PyYAML would.
//
// The core accessors live here. Every other accessor is a contribution: each
// installed adapter adds its own through `registry.accessors(raw, reg)`, and
// the project adds more through the `registry` hook of hooks.mjs.
import { join, basename } from 'node:path';
import { Blocked, Inconclusive } from './errors.mjs';
import { SCENARIOS } from './paths.mjs';
import { readMatrix } from './matrix.mjs';
import { hook, contributions } from './ext.mjs';

// Everything this module throws is typed, and almost all of it is Blocked. A
// registry miss — a typo'd host alias, a log source nobody added, an epic with
// no infra.env_registry — is an environment/authoring fact about the yaml, not
// a statement about the product, and scenario.mjs's classify() reports an
// untyped throw as a product KO. The one exception is resolveTemplate(), whose
// failure is a missing CALLER parameter rather than a missing registry key.
export function resolveTemplate(template, params = {}) {
  return String(template).replace(/\{([a-zA-Z0-9_-]+)\}/g, (_, key) => {
    if (!(key in params)) throw new Inconclusive(`unresolved placeholder: ${key}`);
    return params[key];
  });
}

// Merge `accessors` into `reg`, remembering which provider defined each name.
// A name defined twice is refused rather than overwritten, because which
// definition a script meant is not inferable.
function addAccessors(reg, owners, owner, accessors) {
  for (const [name, fn] of Object.entries(accessors ?? {})) {
    if (owners.has(name)) {
      throw new Blocked(`registry accessor ${name} is defined by ${owners.get(name)} and ${owner}`);
    }
    owners.set(name, owner);
    reg[name] = fn;
  }
}

// The log sources every adapter declares, as [{ owner, sources }].
function declaredLogSources(raw) {
  return contributions('registry')
    .filter(c => typeof c.value.logSources === 'function')
    .map(c => ({ owner: c.owner, sources: c.value.logSources(raw) ?? {} }));
}

// Testing seam: loadRegistry(epic) resolves the standard matrix path and
// delegates here. Tests load a fixture YAML straight from disk without
// hardcoding a path outside .claude/scenarios/ into the public loadRegistry(epic)
// API. `opts` reach the project's `registry` hook unchanged.
export function loadRegistryFromPath(path, epic = basename(path, '.yaml'), opts = {}) {
  const matrix = readMatrix(path);
  const raw = matrix?.infra?.env_registry;
  if (!raw) throw new Blocked(`epic ${epic} has no infra.env_registry`);

  const scenarios = matrix.scenarios ?? [];
  const reg = {
    epic,
    raw,
    rows: scenarios,
    row(id) {
      const found = scenarios.find(s => s.id === id);
      if (!found) throw new Inconclusive(`scenario ${id} not in ${epic}.yaml`);
      return found;
    },
    host(alias) {
      const h = raw.hosts?.[alias];
      if (!h) throw new Blocked(`unknown host alias: ${alias}`);
      return h;
    },
    // Where a service's log lines live, typed by HOW they are read. Each
    // adapter declares the services it can read. A name two adapters declare
    // is refused rather than resolved, because which reader a row meant is not
    // inferable.
    logSource(service) {
      const declaring = declaredLogSources(raw).filter(d => service in d.sources);
      if (declaring.length > 1) {
        throw new Inconclusive(`log source ${service} is declared by ${declaring.map(d => d.owner).join(' and ')} `
          + '-- keep it in one');
      }
      if (declaring.length === 1) return declaring[0].sources[service];
      const hints = contributions('registry').map(c => c.value.logSourceHint).filter(Boolean);
      throw new Blocked(`unknown log source: ${service}${hints.length ? ` (${hints.join('; ')})` : ''}`);
    },
    logSourceNames: () => [...new Set(declaredLogSources(raw).flatMap(d => Object.keys(d.sources)))],
    resolve: resolveTemplate,
  };

  // Build order: core, then adapters in ADAPTERS order, then the project hook.
  const owners = new Map(Object.keys(reg).map(name => [name, 'core']));
  for (const { owner, value } of contributions('registry')) {
    addAccessors(reg, owners, owner, value.accessors?.(raw, reg));
  }
  const project = hook('registry', () => ({}))(raw, opts) ?? {};
  addAccessors(reg, owners, 'hooks.mjs', project.accessors?.(reg));

  // Validation: each adapter's validator for a key the registry carries, then the hook's.
  for (const { value } of contributions('registry')) {
    for (const [key, { validate }] of Object.entries(value.keys ?? {})) {
      if (raw[key] === undefined) continue;
      const problem = validate(raw[key]);
      if (problem) throw new Blocked(`infra.env_registry.${key}: ${problem}`);
    }
  }
  project.validate?.();
  return reg;
}

export function loadRegistry(epic) {
  const path = join(process.env.SCN_MATRIX_DIR ?? SCENARIOS, `${epic}.yaml`);
  return loadRegistryFromPath(path, epic);
}
