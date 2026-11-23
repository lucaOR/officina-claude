import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkMatrix } from '../check.mjs';
import { readMatrix } from '../matrix.mjs';
import { __setForTest } from '../ext.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/neutral-valid.yaml', import.meta.url));
const CHECK = fileURLToPath(new URL('../check.mjs', import.meta.url));
const EXT = fileURLToPath(new URL('../ext.mjs', import.meta.url));

// Runs the CLI in a child whose ext state is swapped for an empty one before check.mjs
// loads, so the project's own config, hooks and adapters never reach the result.
function runCli(file) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-check-'));
  try {
    const preload = join(dir, 'preload.mjs');
    writeFileSync(preload, `import { __setForTest } from ${JSON.stringify(pathToFileURL(EXT).href)};\n`
      + '__setForTest({ hooks: {}, adapters: {}, config: {} });\n');
    return spawnSync(process.execPath, ['--import', preload, CHECK, file], { encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const valid = () => structuredClone(readMatrix(FIXTURE));

// Runs fn with the given overrides in place of the installed hooks, adapters and config.
function withExt(o, fn) {
  const restore = __setForTest({ hooks: {}, adapters: {}, config: {}, ...o });
  try { return fn(); } finally { restore(); }
}
const problems = (data, o = {}, path = FIXTURE) => withExt(o, () => checkMatrix(data, { path }));

// A scratch directory holding the matrix file's neighbour store, for artifact cases.
function withStore(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-check-'));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(dir, '_artifacts', 'neutral', f)), { recursive: true });
      writeFileSync(join(dir, '_artifacts', 'neutral', f), 'x');
    }
    return fn(join(dir, 'neutral.yaml'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const withArtifact = (art, where = 'setup') => {
  const d = valid();
  if (where === 'infra') d.infra.artifacts = [art];
  else d.scenarios[0].setup.push({ artifact: art });
  return d;
};

test('a valid matrix prints OK', () => {
  assert.deepEqual(problems(valid()), []);
  const r = runCli(FIXTURE);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'OK\n');
});

test('the CLI prints one problem per line and exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-check-'));
  try {
    const file = join(dir, 'bad.yaml');
    writeFileSync(file, 'perimeter: { in: [], out: [] }\nscenarios: []\n');
    const r = runCli(file);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'missing epic\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing epic fails', () => {
  const d = valid();
  delete d.epic;
  assert.deepEqual(problems(d), ['missing epic']);
});

test('a duplicate id fails', () => {
  const d = valid();
  d.scenarios[1].id = 'A-01';
  assert.deepEqual(problems(d), ['duplicate id A-01']);
});

test('a missing required field fails', () => {
  const d = valid();
  delete d.scenarios[0].expected;
  assert.deepEqual(problems(d), ['scenario A-01 missing required field expected']);
});

test('a bad reach, priority or status fails', () => {
  const d = valid();
  Object.assign(d.scenarios[0], { reach: 'x', priority: 'P9', status: 'done' });
  assert.deepEqual(problems(d), ['A-01: bad reach', 'A-01: bad priority', 'A-01: bad status']);
});

test('expected OPEN with a status other than open fails', () => {
  const d = valid();
  d.scenarios[1].status = 'verified';
  assert.deepEqual(problems(d), ['A-02: expected OPEN must pair with status open']);
});

test('a db target without the prefix fails, with the configured prefix', () => {
  const d = valid();
  d.scenarios[0].setup[0].db.target = 'main';
  assert.deepEqual(problems(d), ['A-01: unsafe db target main']);
  d.scenarios[0].setup[0].db.target = 'x_main';
  assert.deepEqual(problems(d, { config: { dbPrefix: 'x_' } }), []);
  assert.deepEqual(problems(d), ['A-01: unsafe db target x_main']);
});

test('a mutate db target without the prefix fails', () => {
  const d = valid();
  d.scenarios[0].steps = [{ mutate: { db: { target: 'main' } } }];
  assert.deepEqual(problems(d), ['A-01: unsafe mutate target main']);
});

test('an unknown artifact kind fails, and adapters and config add kinds', () => {
  const art = { kind: 'graph', source: 'g.dat' };
  withStore(['g.dat'], path => {
    assert.deepEqual(problems(withArtifact(art), {}, path), ["A-01 setup: unknown artifact kind 'graph'"]);
    assert.deepEqual(problems(withArtifact(art), { adapters: { demo: { artifactKinds: ['graph'] } } }, path), []);
    assert.deepEqual(problems(withArtifact(art), { config: { check: { artifactKinds: ['seed', 'graph'] } } }, path), []);
  });
});

test('an artifact source outside the store fails', () => {
  withStore([], path => {
    const run = source => problems(withArtifact({ kind: 'seed', source, target: 'scn_x' }, 'infra'), {}, path);
    assert.match(run('/etc/x').join('\n'), /^infra\.artifacts: artifact source must be relative, inside the store: '\/etc\/x'/);
    assert.match(run('../x').join(), /must be relative, inside the store: '\.\.\/x'/);
    assert.deepEqual(run('s.dat'), ['infra.artifacts: artifact source not found in store: _artifacts/neutral/s.dat']);
  });
});

test('an artifact without a source fails and skips its path checks', () => {
  assert.deepEqual(problems(withArtifact({ kind: 'seed', target: 'scn_x' })), ['A-01 setup: artifact missing source']);
});

test('an artifact source on a forbidden path fails', () => {
  withStore(['conf/live/s.dat', 'a/conf/live/s.dat', 'confx/s.dat'], path => {
    const o = { config: { check: { forbiddenArtifactPaths: ['conf/live/'] } } };
    assert.deepEqual(problems(withArtifact({ kind: 'seed', source: 'conf/live/s.dat', target: 'scn_x' }), o, path),
      ["A-01 setup: artifact source points at product config: 'conf/live/s.dat'"]);
    const nested = withArtifact({ kind: 'seed', source: 'a/conf/live/s.dat', target: 'scn_x' });
    assert.match(problems(nested, o, path).join(), /points at product config/);
    assert.deepEqual(problems(withArtifact({ kind: 'seed', source: 'confx/s.dat', target: 'scn_x' }), o, path), []);
  });
});

test('a seed artifact target without the prefix fails', () => {
  withStore(['s.dat'], path => {
    assert.deepEqual(problems(withArtifact({ kind: 'seed', source: 's.dat', target: 'main' }), {}, path),
      ["A-01 setup: seed artifact target must match ^scn_ (got 'main')"]);
    assert.deepEqual(problems(withArtifact({ kind: 'seed', source: 's.dat' }), {}, path),
      ['A-01 setup: seed artifact target must match ^scn_ (got None)']);
    assert.deepEqual(problems(withArtifact({ kind: 'seed', source: 's.dat', target: 'scn_x' }), {}, path), []);
  });
});

test('a login recipe that is not a step list fails', () => {
  const d = valid();
  d.infra.env_registry.login.sso = 'open-login';
  assert.deepEqual(problems(d), ["env_registry.login recipe 'sso' must be a step list"]);
});

test('login markers must be a map of marker to literal string', () => {
  const d = valid();
  d.infra.env_registry.login.markers = { home: '' };
  assert.deepEqual(problems(d), ['env_registry.login.markers must be a map of marker -> literal assertion string']);
});

test('hosts must be a map of alias to string', () => {
  const d = valid();
  d.infra.env_registry.hosts = { app: 3 };
  assert.deepEqual(problems(d), ['env_registry.hosts must be a map of alias -> string']);
});

test('expect-screen naming an undefined marker fails', () => {
  const d = valid();
  d.infra.env_registry.login.sso = ['open-login', 'expect-screen away'];
  assert.deepEqual(problems(d), ["login recipe 'sso': expect-screen 'away' not in login.markers ['home']"]);
});

test('a login op names a recipe that exists', () => {
  const d = valid();
  d.scenarios[0].setup[1].login.recipe = 'nope';
  assert.deepEqual(problems(d), ["A-01 setup: login recipe 'nope' not in env_registry.login ['service', 'sso']"]);
  delete d.scenarios[0].setup[1].login.recipe;
  assert.deepEqual(problems(d), ['A-01 setup: login op missing recipe']);
});

test('a browser login without id fails unless the recipe is in noIdentityRecipes', () => {
  const d = valid();
  d.scenarios[0].steps = [{ login: { recipe: 'service' } }];
  assert.deepEqual(problems(d), ["A-01 steps: browser login recipe 'service' needs an id"]);
  assert.deepEqual(problems(d, { config: { check: { noIdentityRecipes: ['service'] } } }), []);
});

test('stop_at naming an undefined marker fails', () => {
  const d = valid();
  d.scenarios[0].setup[1].login.stop_at = 'away';
  assert.deepEqual(problems(d), ["A-01 setup: stop_at 'away' not in login.markers ['home']"]);
});

test('prefixed db ops need infra provisioning, teardown and baseline_restore', () => {
  const d = valid();
  delete d.infra.provisioning;
  delete d.infra.teardown;
  delete d.infra.baseline_restore;
  assert.deepEqual(problems(d), [
    'infra.provisioning missing/empty', 'infra.teardown missing/empty', 'infra.baseline_restore missing/empty',
  ]);
  delete d.infra;
  assert.deepEqual(problems(d), ['matrix uses scn_* db ops but has no top-level infra block']);
});

test('a perimeter that is not lists fails', () => {
  const d = valid();
  d.perimeter = { in: 'x' };
  assert.deepEqual(problems(d), ['perimeter.in must be a list', 'perimeter.out must be a list']);
});

test('a failed precondition skips only the checks that need it', () => {
  const d = valid();
  d.scenarios = 'none';
  d.infra.env_registry = 'none';
  assert.deepEqual(problems(d), ['scenarios must be a list', 'infra.env_registry must be a mapping']);
});

test('a check.keys validator message is reported', () => {
  const d = valid();
  d.infra.env_registry.cache = { ttl: 'x' };
  d.infra.env_registry.other = 1;
  const hooks = { check: { keys: { cache: v => (typeof v.ttl === 'number' ? null : 'ttl must be a number') } } };
  assert.deepEqual(problems(d, { hooks }), ['env_registry.cache: ttl must be a number']);
});

test('an adapter registry validator is reported, only for a key that is present', () => {
  const d = valid();
  const adapters = { demo: { registry: { keys: { queue: { validate: v => (typeof v === 'string' ? null : 'must be a string') } } } } };
  assert.deepEqual(problems(d, { adapters }), []);
  d.infra.env_registry.queue = 4;
  assert.deepEqual(problems(d, { adapters }), ['env_registry.queue: must be a string']);
});

test('a check.rowFields validator is reported against the row', () => {
  const d = valid();
  d.scenarios[0].owner = 'x';
  const hooks = { check: { rowFields: { owner: (v, row) => `owner ${v} on ${row.id} is unknown` } } };
  assert.deepEqual(problems(d, { hooks }), ['A-01: owner x on A-01 is unknown']);
});
