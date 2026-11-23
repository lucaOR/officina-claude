// The plugin's own additions to the wrapper: the project requirement gate and
// the adapter contributions (beforeAttempt, evidence). Classification and retry
// behaviour inherited from the original wrapper live in classification.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ko, Blocked, Inconclusive } from '../errors.mjs';
import { __setForTest } from '../ext.mjs';
import { runScenario } from './support/run-scenario.mjs';

const withHooks = (t, hooks) => t.after(__setForTest({ hooks }));
const withAdapters = (t, adapters) => t.after(__setForTest({ hooks: {}, adapters, providers: {} }));

// --- The requires gate -------------------------------------------------------

test('a row with requires and no gate is BLOCKED', async (t) => {
  withHooks(t, {});
  let bodyRan = false;
  const reg = { row: () => ({ id: 'G-01', requires: ['feature'] }) };
  const out = await runScenario('G-01', () => { bodyRan = true; }, { registry: () => reg });
  assert.equal(out.result, 'BLOCKED');
  assert.equal(out.exit, 4);
  assert.equal(out.why, 'row G-01 declares requires but hooks.mjs defines no requirementGate');
  assert.equal(bodyRan, false);
});

test('a gate reason makes the row SKIPPED', async (t) => {
  let seen;
  withHooks(t, { requirementGate: (row, reg, ctx) => { seen = { row, reg, ctx }; return 'feature is off here'; } });
  const reg = { row: () => ({ id: 'G-02', requires: ['feature'] }) };
  const out = await runScenario('G-02', () => {}, { registry: () => reg });
  assert.equal(out.result, 'SKIPPED');
  assert.equal(out.why, 'feature is off here');
  // The gate receives the row, the registry and the attempt context.
  assert.deepEqual(seen.row.requires, ['feature']);
  assert.equal(seen.reg, reg);
  assert.equal(seen.ctx.id, 'G-02');
});

test('a null gate runs the row', async (t) => {
  withHooks(t, { requirementGate: () => null });
  let bodyRan = false;
  const reg = { row: () => ({ id: 'G-03', requires: ['feature'] }) };
  const out = await runScenario('G-03', () => { bodyRan = true; }, { registry: () => reg });
  assert.equal(out.result, 'OK');
  assert.equal(bodyRan, true);
});

test('an async gate is awaited', async (t) => {
  withHooks(t, { requirementGate: async () => 'later' });
  const reg = { row: () => ({ id: 'G-04', requires: ['feature'] }) };
  const out = await runScenario('G-04', () => {}, { registry: () => reg });
  assert.equal(out.result, 'SKIPPED');
  assert.equal(out.why, 'later');
});

test('a row with no requires never calls the gate, nor needs one', async (t) => {
  let asked = false;
  withHooks(t, { requirementGate: () => { asked = true; return 'declined'; } });
  const out = await runScenario('G-05', () => {}, { registry: () => ({ row: () => ({ id: 'G-05' }) }) });
  assert.equal(out.result, 'OK');
  assert.equal(asked, false);

  const empty = await runScenario('G-06', () => {}, { registry: () => ({ row: () => ({ id: 'G-06', requires: [] }) }) });
  assert.equal(empty.result, 'OK');
  assert.equal(asked, false);
});

test('a gate that throws a typed error keeps its class', async (t) => {
  withHooks(t, { requirementGate: () => { throw new Blocked('state file missing'); } });
  const reg = { row: () => ({ id: 'G-07', requires: ['feature'] }) };
  const out = await runScenario('G-07', () => {}, { registry: () => reg });
  assert.equal(out.result, 'BLOCKED');
  assert.equal(out.why, 'state file missing');
});

// --- Adapter contributions ---------------------------------------------------

test('beforeAttempt runs for every adapter, in order, after the slice mark and before reset', async (t) => {
  const order = [];
  withAdapters(t, {
    first: { beforeAttempt: ctx => order.push(`first:${ctx.id}`) },
    second: { beforeAttempt: async () => { order.push('second'); } },
  });
  const reg = { row: () => ({ id: 'B-01' }) };
  const out = await runScenario('B-01', () => { order.push('fn'); }, {
    registry: () => reg,
    reset: () => { order.push('reset'); },
  });
  assert.equal(out.result, 'OK');
  assert.deepEqual(order, ['first:B-01', 'second', 'reset', 'fn']);
});

test('beforeAttempt runs again on every attempt', async (t) => {
  let before = 0, calls = 0;
  withAdapters(t, { a: { beforeAttempt: () => { before++; } } });
  const reg = { row: () => ({ id: 'B-02', retries: 1 }) };
  const out = await runScenario('B-02', () => { calls++; if (calls === 1) throw new Ko('flake'); }, { registry: () => reg });
  assert.equal(out.result, 'OK');
  assert.equal(before, 2);
});

test('a beforeAttempt throw is classified like a reset throw, and fn never runs', async (t) => {
  withAdapters(t, { a: { beforeAttempt: () => { throw new Blocked('adapter not ready'); } } });
  let bodyRan = false;
  const reg = { row: () => ({ id: 'B-03' }) };
  const out = await runScenario('B-03', () => { bodyRan = true; }, { registry: () => reg });
  assert.equal(out.result, 'BLOCKED');
  assert.equal(out.why, 'adapter not ready');
  assert.equal(bodyRan, false);

  const untyped = { a: { beforeAttempt: () => { throw new Error('untyped'); } } };
  const restore = __setForTest({ hooks: {}, adapters: untyped, providers: {} });
  try {
    const ko = await runScenario('B-03b', () => {}, { registry: () => ({ row: () => ({ id: 'B-03b' }) }) });
    assert.equal(ko.result, 'KO');
  } finally {
    restore();
  }
});

test('adapter evidence runs after a failure and its throw is swallowed', async (t) => {
  const calls = [];
  withAdapters(t, {
    bad: { evidence: () => { calls.push('bad'); throw new Error('evidence blew up'); } },
    good: { evidence: async (r, dir) => { calls.push(`good:${dir}`); } },
  });
  const reg = { row: () => ({ id: 'E-01' }) };
  const out = await runScenario('E-01', () => { throw new Ko('diverged'); }, {
    registry: () => reg,
    captureEvidence: () => { calls.push('shot'); return 'shot-dir'; },
    captureServerLogs: () => { calls.push('logs'); },
    today: () => '2026-07-29',
  });
  assert.equal(out.result, 'KO');
  assert.equal(out.why, 'diverged');
  // The existing evidence step first, then the server logs, then each adapter.
  assert.equal(calls[0], 'shot');
  assert.equal(calls[1], 'logs');
  assert.equal(calls[2], 'bad');
  assert.match(calls[3], /^good:.*E-01$/);
});

test('adapter evidence also runs after a BLOCKED attempt', async (t) => {
  let ran = 0;
  withAdapters(t, { a: { evidence: () => { ran++; } } });
  const reg = { row: () => ({ id: 'E-02' }) };
  const out = await runScenario('E-02', () => { throw new Blocked('env down'); }, { registry: () => reg });
  assert.equal(out.result, 'BLOCKED');
  assert.equal(ran, 1);
});

test('adapter evidence does not run on OK, INCONCLUSIVE, STALE or SKIPPED', async (t) => {
  let ran = 0;
  withAdapters(t, { a: { evidence: () => { ran++; } } });
  const plain = { row: () => ({ id: 'E-03' }) };
  assert.equal((await runScenario('E-03', () => {}, { registry: () => plain })).result, 'OK');
  assert.equal((await runScenario('E-03', () => { throw new Inconclusive('no lever'); }, { registry: () => plain })).result, 'INCONCLUSIVE');
  assert.equal((await runScenario('E-03', () => {}, { registry: () => plain, compiledFrom: 'deadbeef' })).result, 'STALE');
  const gated = { row: () => ({ id: 'E-04', requires: ['feature'] }) };
  const restore = __setForTest({ hooks: { requirementGate: () => 'declined' }, adapters: { a: { evidence: () => { ran++; } } }, providers: {} });
  try {
    assert.equal((await runScenario('E-04', () => {}, { registry: () => gated })).result, 'SKIPPED');
  } finally {
    restore();
  }
  assert.equal(ran, 0);
});
