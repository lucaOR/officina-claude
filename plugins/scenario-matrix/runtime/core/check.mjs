// The matrix self-check. checkMatrix collects every problem instead of stopping
// at the first; a failed structural precondition skips only the checks that need
// it. Messages keep the formatting of the Python assertions this replaced:
// strings in single quotes, `None` for a missing value, lists as ['a', 'b'].
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Blocked } from './errors.mjs';
import { readMatrix } from './matrix.mjs';
import { config } from './config.mjs';
import { adapters, contributions, hookValue } from './ext.mjs';
import { isMain } from './paths.mjs';

const REACH = ['browser', 'wiring', 'auth', 'be-only', 'ops'];
const PRIORITY = ['P1', 'P2', 'P3'];
const STATUS = ['open', 'verified', 'drift', 'blocked'];
const REQUIRED = ['id', 'behaviour', 'reach', 'priority', 'expected', 'status'];
const CORE_KEYS = new Set(['hosts', 'login']);

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const orMap = v => (isMap(v) ? v : {});
const isStr = v => typeof v === 'string';
const present = (obj, key) => Object.hasOwn(obj, key);

// Python's repr() for the values a matrix holds.
function repr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (isStr(v)) {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('\r', '\\r');
    return q + (q === "'" ? body.replaceAll("'", "\\'") : body) + q;
  }
  if (Array.isArray(v)) return `[${v.map(repr).join(', ')}]`;
  if (isMap(v)) return `{${Object.entries(v).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(', ')}}`;
  return String(v);
}

const sortedRepr = names => repr([...names].sort());

function knownKinds() {
  const kinds = new Set(config().check.artifactKinds);
  for (const { mod } of adapters()) for (const k of mod.artifactKinds ?? []) kinds.add(k);
  return kinds;
}

// A forbidden entry is a run of whole path segments, matched anywhere in the source.
function onForbiddenPath(src, forbidden) {
  const padded = `/${src}/`;
  return forbidden.some(entry => padded.includes(`/${String(entry).replace(/^\/+|\/+$/g, '')}/`));
}

function checkRegistry(reg, out) {
  if (present(reg, 'hosts')) {
    const h = reg.hosts;
    if (!(isMap(h) && Object.values(h).every(isStr))) out.push('env_registry.hosts must be a map of alias -> string');
  }
  if (present(reg, 'login')) {
    const lg = reg.login;
    if (!isMap(lg)) {
      out.push('env_registry.login must be a map');
    } else {
      for (const [k, v] of Object.entries(lg)) {
        if (k === 'markers') {
          if (!(isMap(v) && Object.values(v).every(x => isStr(x) && x))) {
            out.push('env_registry.login.markers must be a map of marker -> literal assertion string');
          }
        } else if (!Array.isArray(v)) {
          out.push(`env_registry.login recipe ${repr(k)} must be a step list`);
        }
      }
    }
  }
  // Every other key belongs to an adapter or the project; unknown keys pass.
  const validators = new Map();
  const add = (key, fn) => validators.set(key, [...(validators.get(key) ?? []), fn]);
  for (const { value } of contributions('registry')) {
    for (const [key, { validate }] of Object.entries(value.keys ?? {})) add(key, validate);
  }
  for (const [key, fns] of Object.entries(hookValue('check.keys', {}))) {
    for (const fn of [fns].flat()) add(key, fn);
  }
  for (const [key, fns] of validators) {
    if (CORE_KEYS.has(key) || !present(reg, key)) continue;
    const seen = new Set();
    for (const fn of fns) {
      const problem = fn(reg[key]);
      if (problem && !seen.has(problem)) {
        seen.add(problem);
        out.push(`env_registry.${key}: ${problem}`);
      }
    }
  }
}

export function checkMatrix(data, { path } = {}) {
  const out = [];
  if (!isMap(data)) return ['matrix must be a mapping'];
  const cfg = config();
  const prefix = cfg.dbPrefix;
  const epic = data.epic;
  if (!(isStr(epic) && epic)) out.push('missing epic');

  const perimeter = data.perimeter;
  for (const side of ['in', 'out']) {
    if (!Array.isArray(orMap(perimeter)[side])) out.push(`perimeter.${side} must be a list`);
  }
  if (!Array.isArray(data.scenarios)) out.push('scenarios must be a list');

  const store = path ? resolve(dirname(resolve(path)), '_artifacts', String(epic)) : null;
  const kinds = knownKinds();
  const forbidden = cfg.check.forbiddenArtifactPaths;
  const noIdentity = cfg.check.noIdentityRecipes;

  function checkArtifact(where, art) {
    if (!isMap(art)) { out.push(`${where}: artifact must be a map`); return; }
    const { kind, source: src } = art;
    if (!kinds.has(kind)) out.push(`${where}: unknown artifact kind ${repr(kind)}`);
    if (!src) {
      out.push(`${where}: artifact missing source`);
    } else {
      const s = String(src);
      if (isAbsolute(s) || s.split('/').includes('..')) {
        out.push(`${where}: artifact source must be relative, inside the store: ${repr(src)}`);
      }
      if (onForbiddenPath(s, forbidden)) out.push(`${where}: artifact source points at product config: ${repr(src)}`);
      if (store && !existsSync(resolve(store, s))) {
        out.push(`${where}: artifact source not found in store: _artifacts/${epic}/${s}`);
      }
    }
    if (kind === 'seed' && !(isStr(art.target) && art.target.startsWith(prefix))) {
      out.push(`${where}: seed artifact target must match ^${prefix} (got ${repr(art.target)})`);
    }
  }

  const infra = isMap(data.infra) ? data.infra : null;
  for (const art of (infra?.artifacts || [])) checkArtifact('infra.artifacts', art);

  const reg = infra?.env_registry;
  if (reg !== undefined && reg !== null) {
    if (isMap(reg)) checkRegistry(reg, out);
    else out.push('infra.env_registry must be a mapping');
  }

  // Login recipes and markers need a login map; without one these checks are skipped.
  const login = isMap(reg) && isMap(reg.login) ? reg.login : null;
  const markers = new Set(isMap(login?.markers) ? Object.keys(login.markers) : []);
  const recipes = new Set(login ? Object.keys(login).filter(k => k !== 'markers') : []);
  if (login && markers.size) {
    for (const [name, steps] of Object.entries(login)) {
      if (name === 'markers' || !Array.isArray(steps)) continue;
      for (const st of steps) {
        if (isStr(st) && st.startsWith('expect-screen ')) {
          const mk = st.split(/\s+/).filter(Boolean).slice(1).join(' ').trim();
          if (!markers.has(mk)) {
            out.push(`login recipe ${repr(name)}: expect-screen ${repr(mk)} not in login.markers ${sortedRepr(markers)}`);
          }
        }
      }
    }
  }

  function checkLogin(where, op) {
    const r = orMap(op).recipe;
    if (!(isStr(r) && r)) {
      out.push(`${where}: login op missing recipe`);
    } else {
      if (recipes.size && !recipes.has(r)) {
        out.push(`${where}: login recipe ${repr(r)} not in env_registry.login ${sortedRepr(recipes)}`);
      }
      if (!present(orMap(op), 'id') && !noIdentity.includes(r)) {
        out.push(`${where}: browser login recipe ${repr(r)} needs an id`);
      }
    }
    const sa = orMap(op).stop_at;
    if (sa !== undefined && sa !== null && markers.size && !markers.has(sa)) {
      out.push(`${where}: stop_at ${repr(sa)} not in login.markers ${sortedRepr(markers)}`);
    }
  }

  const rowFields = Object.entries(hookValue('check.rowFields', {}));
  const seen = new Set();
  let sawDbTarget = false;
  for (const s of Array.isArray(data.scenarios) ? data.scenarios : []) {
    if (!isMap(s)) { out.push(`scenario ${repr(s)} must be a map`); continue; }
    const sid = present(s, 'id') ? s.id : '?';
    if (seen.has(sid)) out.push(`duplicate id ${sid}`);
    seen.add(sid);
    for (const k of REQUIRED) if (!present(s, k)) out.push(`scenario ${sid} missing required field ${k}`);
    if (present(s, 'reach') && !REACH.includes(s.reach)) out.push(`${sid}: bad reach`);
    if (present(s, 'priority') && !PRIORITY.includes(s.priority)) out.push(`${sid}: bad priority`);
    if (present(s, 'status') && !STATUS.includes(s.status)) out.push(`${sid}: bad status`);
    if (s.expected === 'OPEN' && s.status !== 'open') out.push(`${sid}: expected OPEN must pair with status open`);

    for (const op of (s.setup || [])) {
      const target = orMap(orMap(op).db).target;
      if (target) {
        sawDbTarget = true;
        if (!(isStr(target) && target.startsWith(prefix))) out.push(`${sid}: unsafe db target ${target}`);
      }
      if (orMap(op).artifact) checkArtifact(`${sid} setup`, op.artifact);
      if (orMap(op).login) checkLogin(`${sid} setup`, op.login);
    }
    for (const step of (s.steps || [])) {
      const mutate = orMap(orMap(step).mutate);
      const target = orMap(mutate.db).target;
      if (target) {
        sawDbTarget = true;
        if (!(isStr(target) && target.startsWith(prefix))) out.push(`${sid}: unsafe mutate target ${target}`);
      }
      if (mutate.artifact) checkArtifact(`${sid} mutate`, mutate.artifact);
      if (orMap(step).login) checkLogin(`${sid} steps`, step.login);
    }
    for (const [field, fn] of rowFields) {
      if (!present(s, field)) continue;
      const problem = fn(s[field], s);
      if (problem) out.push(`${sid}: ${problem}`);
    }
  }

  if (sawDbTarget) {
    if (!infra) {
      out.push(`matrix uses ${prefix}* db ops but has no top-level infra block`);
    } else {
      for (const k of ['provisioning', 'teardown', 'baseline_restore']) {
        if (!infra[k] || (typeof infra[k] === 'object' && !Object.keys(infra[k]).length)) out.push(`infra.${k} missing/empty`);
      }
    }
  }
  return out;
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: check.mjs <matrix.yaml>');
    process.exit(64);
  }
  let data;
  try {
    data = readMatrix(file);
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
    console.error(err.message);
    process.exit(2);
  }
  const problems = checkMatrix(data, { path: file });
  if (problems.length) {
    console.log(problems.join('\n'));
    process.exit(1);
  }
  console.log('OK');
}
