import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runChecks, collectProbes, cliArgs } from '../selftest.mjs';
import { __setForTest } from '../ext.mjs';
import { config } from '../config.mjs';

const SELFTEST = fileURLToPath(new URL('../selftest.mjs', import.meta.url));

// Captures console.log for the duration of fn and returns the printed lines.
async function captured(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { value: await fn(), lines }; } finally { console.log = orig; }
}

test('--only is a prefix match', async () => {
  const ran = [];
  const mk = name => ({ name, owner: 'x', run: async () => { ran.push(name); } });
  const { value } = await captured(() => runChecks([mk('mail'), mk('mailCount'), mk('sql')], { only: 'mail' }));
  assert.deepEqual(ran, ['mail', 'mailCount']);
  assert.deepEqual(value, { ran: 2, failed: 0, skipped: 0 });
});

test('a probe whose needs are unset is skipped and listed', async () => {
  const restore = __setForTest({
    adapters: {
      demo: { selftest: [
        { name: 'demo-url', needs: ['demo.url'], run: async () => true },
        { name: 'demo-port', needs: ['demo.port'], run: async () => true },
      ] },
    },
    hooks: {},
  });
  try {
    const cfg = { demo: { url: '', port: 8080 } };
    const probes = collectProbes({}, cfg).filter(p => p.owner === 'demo');
    assert.equal(probes[0].missing, 'demo.url');
    assert.equal(probes[1].missing, undefined);
    const { value, lines } = await captured(() => runChecks(probes, {}));
    assert.deepEqual(lines, ['skip demo-url: needs demo.url', 'ok demo-port']);
    assert.deepEqual(value, { ran: 1, failed: 0, skipped: 1 });
  } finally { restore(); }
});

test('duplicate probe names fail naming both owners', () => {
  const probe = { name: 'same', run: async () => true };
  const restore = __setForTest({
    adapters: { one: { selftest: [probe] } },
    hooks: { selftest: { probes: () => [probe] } },
  });
  try {
    assert.throws(() => collectProbes({}, {}), { message: 'selftest probe same is defined by one and project' });
  } finally { restore(); }
});

test('collectProbes orders core, adapter, then project probes', () => {
  const restore = __setForTest({
    adapters: { one: { selftest: [{ name: 'a', run: async () => true }] } },
    hooks: { selftest: { probes: (reg, o) => [{ name: 'p', run: async () => o.config.k }] } },
  });
  try {
    const probes = collectProbes({}, { k: 1 });
    assert.deepEqual(probes.map(p => p.owner), ['core', 'core', 'one', 'project']);
  } finally { restore(); }
});

test('a failing probe makes exit 1 and the others still run', async () => {
  const checks = [
    { name: 'a', owner: 'x', run: async () => false },
    { name: 'b', owner: 'x', run: async () => { throw new Error('boom'); } },
    { name: 'c', owner: 'x', run: async () => undefined },
  ];
  const { value, lines } = await captured(() => runChecks(checks, {}));
  assert.deepEqual(lines, ['FAIL a: check returned false', 'FAIL b: boom', 'ok c']);
  assert.deepEqual(value, { ran: 3, failed: 2, skipped: 0 });
});

test('a probe whose needed flag is false is skipped, like an unset one', () => {
  const restore = __setForTest({
    adapters: { demo: { selftest: [{ name: 'demo-flag', needs: ['demo.enabled'], run: async () => true }] } },
    hooks: {},
  });
  try {
    const demo = cfg => collectProbes({}, cfg).find(p => p.name === 'demo-flag');
    assert.equal(demo({ demo: { enabled: false } }).missing, 'demo.enabled');
    assert.equal(demo({ demo: { enabled: true } }).missing, undefined);
    assert.equal(demo({ demo: { enabled: 0 } }).missing, undefined);
  } finally { restore(); }
});

test('the core race probe passes', async () => {
  const restore = __setForTest({ adapters: {}, hooks: {} });
  try {
    const race = collectProbes({}, {}).find(p => p.name.startsWith('race:'));
    assert.equal(await race.run({}, {}), true);
  } finally { restore(); }
});

// The child process reads the lib's real scenarios.config.json. In a project that sets
// selftest.defaultEpic, a bare `selftest.mjs` runs that project's live probes, which a unit test
// must never do, so there the spawn is skipped and cliArgs below covers the decision instead.
test('the CLI without an epic prints usage and exits 64', (t) => {
  if (config().selftest?.defaultEpic) return t.skip('this project sets selftest.defaultEpic, so a bare CLI would run its live selftest');
  const r = spawnSync(process.execPath, [SELFTEST], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage: selftest\.mjs/);
});

test('the CLI names an unknown epic in one line and exits 1, with no stack trace', () => {
  const env = { ...process.env, SCN_MATRIX_DIR: fileURLToPath(new URL('./fixtures', import.meta.url)) };
  const r = spawnSync(process.execPath, [SELFTEST, 'no-such-epic'], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /matrix not found: .*no-such-epic\.yaml/);
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});

test('cliArgs takes the epic from the arguments, else from selftest.defaultEpic', () => {
  const none = { selftest: { defaultEpic: null } };
  const some = { selftest: { defaultEpic: 'main' } };
  assert.deepEqual(cliArgs([], none), { epic: undefined, only: undefined });
  assert.deepEqual(cliArgs(['--only=mail'], some), { epic: 'main', only: 'mail' });
  assert.deepEqual(cliArgs(['other', '--only=sql'], some), { epic: 'other', only: 'sql' });
});
