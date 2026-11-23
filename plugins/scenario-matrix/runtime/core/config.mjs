// Project settings. `scenarios.config.json` (next to this file) is read once and
// deep-merged over DEFAULTS, so a project states only what differs. Every path
// in it is relative to the repository root.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Blocked } from './errors.mjs';
import { LIB, REPO } from './paths.mjs';

export const DEFAULTS = Object.freeze({
  version: 1,
  dbPrefix: 'scn_',
  tenantKey: null,
  runsDir: 'docs/scenario-runs',
  compileHint: '/scenario-matrix:matrix {epic} compile {id}',
  intent_sources: [],
  monitor: null,
  lifecycle: {
    up: null,
    down: null,
    refusedExit: 78,
    warmMarker: '.claude/scenarios/_infra/.scn-warm',
    keepWarmEnv: 'SCN_KEEP_WARM',
  },
  reset: { baseline: null },
  selftest: { defaultEpic: null },
  check: { artifactKinds: ['seed'], forbiddenArtifactPaths: [], noIdentityRecipes: [] },
  adapters: {},
});

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Plain objects merge recursively; arrays and scalars replace.
function merge(base, over) {
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    if (!(k in over)) out[k] = structuredClone(base[k]);
    else if (isPlain(base[k]) && isPlain(over[k])) out[k] = merge(base[k], over[k]);
    else out[k] = structuredClone(over[k]);
  }
  return out;
}

// An empty prefix matches every database name, so it would turn off every prefix guard at once,
// in the core and in every adapter. It is refused instead.
function checked(cfg, where) {
  if (typeof cfg.dbPrefix !== 'string' || cfg.dbPrefix.trim() === '') {
    throw new Blocked(`${where}: dbPrefix must be a non-empty string, got ${JSON.stringify(cfg.dbPrefix)}; it is what keeps every guard on the scenario databases`);
  }
  return cfg;
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return merge(DEFAULTS, {});
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Blocked(`${path} is not valid JSON: ${e.message}`);
  }
  if (!isPlain(parsed)) throw new Blocked(`${path} must hold a JSON object`);
  return checked(merge(DEFAULTS, parsed), path);
}

let cached = null;

export function config() {
  cached ??= loadConfig(join(LIB, 'scenarios.config.json'));
  return cached;
}

export function adapterConfig(name) {
  return config().adapters?.[name] ?? {};
}

export function repoPath(rel) {
  return resolve(REPO, rel);
}

// Unknown placeholders stay as written, so a hint with a typo is visible.
export function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function __setConfigForTest(obj) {
  const prev = cached;
  cached = checked(merge(DEFAULTS, obj ?? {}), 'test config');
  return () => { cached = prev; };
}
