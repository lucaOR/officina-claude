// The only reader of the project's hooks, the installed adapters and the tenant
// key. Imports are static because loadRegistry is synchronous. Hook defaults
// live at the call sites, so core never names a technology.
import * as projectHooks from './hooks.mjs';
import { ADAPTERS, PROVIDERS } from './adapters.mjs';
import { Blocked } from './errors.mjs';
import { config, __setConfigForTest } from './config.mjs';

let hooks = projectHooks;
let installed = ADAPTERS;
let providers = PROVIDERS;

function lookup(path) {
  return String(path).split('.').reduce((node, key) => (node == null ? undefined : node[key]), hooks);
}

// The project's function at a dotted path, else the fallback.
export function hook(path, fallback) {
  const v = lookup(path);
  return typeof v === 'function' ? v : fallback;
}

// Any defined value at a dotted path (for hooks that are data, not functions), else the fallback.
export function hookValue(path, fallback) {
  const v = lookup(path);
  return v === undefined ? fallback : v;
}

export function adapters() {
  return Object.entries(installed).map(([name, mod]) => ({ name, mod }));
}

const WRAPPED_FN = new Set(['beforeAttempt', 'evidence', 'httpClient']);

// Flat list of what each installed adapter contributes under `kind`. Function
// kinds come back as { owner, fn }, string kinds as { owner, pattern }, arrays
// of records have `owner` added to each item, and any other value (a mapping)
// comes back as { owner, value }.
export function contributions(kind) {
  const out = [];
  for (const { name, mod } of adapters()) {
    const v = mod[kind];
    if (v === undefined || v === null) continue;
    if (WRAPPED_FN.has(kind)) {
      if (typeof v === 'function') out.push({ owner: name, fn: v });
    } else if (kind === 'fatalLogPatterns') {
      for (const pattern of v) out.push({ owner: name, pattern });
    } else if (Array.isArray(v)) {
      for (const item of v) out.push(typeof item === 'object' && item !== null ? { ...item, owner: name } : { owner: name, value: item });
    } else {
      out.push({ owner: name, value: v });
    }
  }
  return out;
}

// The first installed adapter (in ADAPTERS order) that provides the driver wins.
function installedDriver(name) {
  for (const mod of Object.values(installed)) {
    if (mod.drivers && name in mod.drivers) return mod.drivers[name];
  }
  return undefined;
}

export function hasDriver(name) {
  return installedDriver(name) !== undefined;
}

export function driver(name) {
  const found = installedDriver(name);
  if (found !== undefined) return found;
  const names = providers[name];
  if (!names?.length) throw new Blocked(`no catalog adapter provides ${name}`);
  const [first, ...rest] = names;
  const alt = rest.length ? ` (or ${rest.join(', ')})` : '';
  throw new Blocked(`${name} needs the ${first} adapter${alt}: run /scenario-matrix:setup --add ${first}`);
}

export function tenantOf(opts) {
  const key = config().tenantKey;
  if (!key) return null;
  return opts?.[key] ?? null;
}

export function __setForTest(o = {}) {
  const prev = { hooks, installed, providers };
  if ('hooks' in o) hooks = o.hooks;
  if ('adapters' in o) installed = o.adapters;
  if ('providers' in o) providers = o.providers;
  const restoreConfig = 'config' in o ? __setConfigForTest(o.config) : null;
  return () => {
    ({ hooks, installed, providers } = prev);
    restoreConfig?.();
  };
}
