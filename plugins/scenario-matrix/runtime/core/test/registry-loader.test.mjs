import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadRegistry, loadRegistryFromPath } from '../registry.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked, Inconclusive } from '../errors.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const FIXTURE = join(FIXTURES, 'neutral-registry.yaml');

// Every case injects its own adapters and hook, so none depends on what the
// assembled lib's hooks.mjs or adapters.mjs happen to hold.
function load(t, { adapters = {}, hooks = {} } = {}, opts, path = FIXTURE, epic = 'neutral') {
  t.after(__setForTest({ adapters, hooks }));
  return loadRegistryFromPath(path, epic, opts);
}

function tempMatrix(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-registry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tmp.yaml');
  writeFileSync(path, body);
  return path;
}

test('loadRegistryFromPath loads infra.env_registry from a fixture file', (t) => {
  const reg = load(t);
  assert.equal(reg.epic, 'neutral');
  assert.deepEqual(reg.rows.map(r => r.id), ['A-01']);
  assert.equal(reg.raw.hosts.app, 'app.test');
});

test('epic defaults to the file name without its extension', (t) => {
  t.after(__setForTest({ adapters: {}, hooks: {} }));
  assert.equal(loadRegistryFromPath(FIXTURE).epic, 'neutral-registry');
});

test('an epic with no infra.env_registry is Blocked', (t) => {
  const path = tempMatrix(t, 'epic: bare\nscenarios: []\n');
  assert.throws(() => load(t, {}, undefined, path, 'bare'),
    err => err instanceof Blocked && /epic bare has no infra\.env_registry/.test(err.message));
});

test('loadRegistry reads SCN_MATRIX_DIR before the scenarios directory', (t) => {
  t.after(__setForTest({ adapters: {}, hooks: {} }));
  const prev = process.env.SCN_MATRIX_DIR;
  process.env.SCN_MATRIX_DIR = FIXTURES;
  t.after(() => { if (prev === undefined) delete process.env.SCN_MATRIX_DIR; else process.env.SCN_MATRIX_DIR = prev; });
  const reg = loadRegistry('neutral-registry');
  assert.equal(reg.epic, 'neutral-registry');
  assert.equal(reg.row('A-01').priority, 'P1');
});

test('host() resolves a known alias and throws on an unknown one', (t) => {
  const reg = load(t);
  assert.equal(reg.host('app'), 'app.test');
  assert.throws(() => reg.host('nope'), err => err instanceof Blocked && /unknown host alias: nope/.test(err.message));
});

test('row() resolves a known scenario id and throws Inconclusive on an unknown one', (t) => {
  const reg = load(t);
  assert.equal(reg.row('A-01').behaviour, 'a saved note appears in the list');
  assert.throws(() => reg.row('A-99'),
    err => err instanceof Inconclusive && /scenario A-99 not in neutral\.yaml/.test(err.message));
});

test('resolve() substitutes a host into a template', (t) => {
  const reg = load(t);
  assert.equal(reg.resolve('curl https://{host}', { host: reg.host('app') }), 'curl https://app.test');
});

test('adapter accessors are added to the registry and receive raw and reg', (t) => {
  const seen = [];
  const reg = load(t, { adapters: {
    a: { registry: { accessors: (raw, r) => { seen.push([raw, r]); return { thing: () => `thing:${raw.hosts.app}` }; } } },
  } });
  assert.equal(reg.thing(), 'thing:app.test');
  assert.equal(seen[0][0], reg.raw);
  assert.equal(seen[0][1], reg);
});

test('opts are forwarded to the registry hook', (t) => {
  const calls = [];
  const opts = { flag: 1 };
  const reg = load(t, { hooks: { registry: (raw, o) => { calls.push([raw, o]); return { accessors: () => ({ extra: () => 'x' }) }; } } }, opts);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], reg.raw);
  assert.equal(calls[0][1], opts);
  assert.equal(reg.extra(), 'x');
});

test('a hook accessor can call core accessors through reg', (t) => {
  const reg = load(t, { hooks: { registry: () => ({
    accessors: r => ({ appUrl: () => `https://${r.host('app')}/${r.row('A-01').id}` }),
  }) } });
  assert.equal(reg.appUrl(), 'https://app.test/A-01');
});

test('two providers of one accessor fail naming both owners', (t) => {
  const adapters = {
    a: { registry: { accessors: () => ({ shared: () => 1 }) } },
    b: { registry: { accessors: () => ({ shared: () => 2 }) } },
  };
  assert.throws(() => load(t, { adapters }),
    err => err instanceof Blocked && err.message === 'registry accessor shared is defined by a and b');
});

test('a hook accessor that repeats an adapter accessor is a duplicate owned by hooks.mjs', (t) => {
  const adapters = { a: { registry: { accessors: () => ({ shared: () => 1 }) } } };
  const hooks = { registry: () => ({ accessors: () => ({ shared: () => 2 }) }) };
  assert.throws(() => load(t, { adapters, hooks }),
    err => err.message === 'registry accessor shared is defined by a and hooks.mjs');
});

test('an adapter or hook redefining a core accessor is a duplicate owned by core', (t) => {
  assert.throws(() => load(t, { adapters: { a: { registry: { accessors: () => ({ host: () => 1 }) } } } }),
    err => err.message === 'registry accessor host is defined by core and a');
  assert.throws(() => load(t, { hooks: { registry: () => ({ accessors: () => ({ row: () => 1 }) }) } }),
    err => err.message === 'registry accessor row is defined by core and hooks.mjs');
});

test('a registry hook without accessors or validate contributes nothing', (t) => {
  const reg = load(t, { hooks: { registry: () => ({}) } });
  assert.equal(reg.epic, 'neutral');
});

test('each adapter key validator runs on its key, then the hook validate runs', (t) => {
  const order = [];
  const adapters = { a: { registry: { keys: { hosts: { validate: (v) => { order.push('a'); return v.app ? null : 'needs app'; } } } } } };
  const hooks = { registry: () => ({ validate: () => order.push('hook') }) };
  load(t, { adapters, hooks });
  assert.deepEqual(order, ['a', 'hook']);
});

test('an adapter key validator returning a message is Blocked and names the key', (t) => {
  const adapters = { a: { registry: { keys: { hosts: { validate: () => 'must be empty' } } } } };
  assert.throws(() => load(t, { adapters }),
    err => err instanceof Blocked && /infra\.env_registry\.hosts: must be empty/.test(err.message));
});

test('a validator is skipped for a key the registry does not carry', (t) => {
  let ran = false;
  load(t, { adapters: { a: { registry: { keys: { absent: { validate: () => { ran = true; return 'boom'; } } } } } } });
  assert.equal(ran, false);
});

const SOURCES = {
  a: { registry: { logSources: raw => ({ web: { kind: 'one', host: raw.hosts.app } }), logSourceHint: 'add infra.env_registry.web for a one-kind service' } },
  b: { registry: { logSources: () => ({ worker: { kind: 'two' } }), logSourceHint: 'add infra.env_registry.worker for a two-kind service' } },
};

test('logSource() merges every adapter source and logSourceNames() lists them', (t) => {
  const reg = load(t, { adapters: SOURCES });
  assert.deepEqual(reg.logSource('web'), { kind: 'one', host: 'app.test' });
  assert.deepEqual(reg.logSource('worker'), { kind: 'two' });
  assert.deepEqual(reg.logSourceNames(), ['web', 'worker']);
});

test('logSource() refuses a name two adapters declare rather than guessing the reader', (t) => {
  const adapters = { ...SOURCES, c: { registry: { logSources: () => ({ web: { kind: 'three' } }) } } };
  const reg = load(t, { adapters });
  assert.throws(() => reg.logSource('web'),
    err => err instanceof Inconclusive && /log source web is declared by a and c/.test(err.message));
  assert.deepEqual(reg.logSource('worker'), { kind: 'two' });
  assert.deepEqual(reg.logSourceNames(), ['web', 'worker']);
});

test('logSource() on a missing name is Blocked and lists every adapter hint', (t) => {
  const reg = load(t, { adapters: { ...SOURCES, c: { registry: { logSources: () => ({}) } } } });
  assert.throws(() => reg.logSource('nope'), err => err instanceof Blocked
    && /unknown log source: nope/.test(err.message)
    && err.message.includes('add infra.env_registry.web for a one-kind service')
    && err.message.includes('add infra.env_registry.worker for a two-kind service'));
});

test('logSource() on a missing name still names the service when no adapter has a hint', (t) => {
  const reg = load(t);
  assert.throws(() => reg.logSource('nope'), err => err instanceof Blocked && err.message.includes('nope'));
  assert.deepEqual(reg.logSourceNames(), []);
});
