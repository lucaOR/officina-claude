// Core reset: phase ordering, error classification and the default baseline.
// Technology-specific reset steps are tested with their adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ko, Blocked, Inconclusive } from '../errors.mjs';
import { __setForTest } from '../ext.mjs';
import { reset, defaultBaseline } from '../reset.mjs';

const noBaseline = async () => {};
const withConfig = (t, config, hooks = {}) => t.after(__setForTest({ hooks, adapters: {}, providers: {}, config }));

test('steps run in prepare, restore, probe, normalize order regardless of adapter order', async () => {
  const seen = [];
  const mk = (phase) => ({ phase, name: phase, owner: 'x', run: () => { seen.push(phase); } });
  const steps = [mk('normalize'), mk('probe'), mk('restore'), mk('prepare')];
  await reset({}, { steps, baseline: async () => { seen.push('baseline'); } });
  assert.deepEqual(seen, ['prepare', 'baseline', 'restore', 'probe', 'normalize']);
});

test('adapter order is kept within a phase', async () => {
  const seen = [];
  const mk = (name) => ({ phase: 'restore', name, owner: 'x', run: () => { seen.push(name); } });
  await reset({}, { steps: [mk('a'), mk('b'), mk('c')], baseline: noBaseline });
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('steps share one ctx and receive the registry', async () => {
  const reg = { id: 'reg' };
  const steps = [
    { phase: 'probe', name: 'b', owner: 'x', run: (r, ctx) => { assert.equal(r, reg); assert.equal(ctx.v, 1); } },
    { phase: 'prepare', name: 'a', owner: 'x', run: (_r, ctx) => { ctx.v = 1; } },
  ];
  await reset(reg, { steps, baseline: noBaseline });
});

test('an unknown phase is BLOCKED before any step runs', async () => {
  let ran = false;
  const steps = [
    { phase: 'prepare', name: 'ok', owner: 'x', run: () => { ran = true; } },
    { phase: 'bogus', name: 'bad', owner: 'y', run: () => {} },
  ];
  await assert.rejects(reset({}, { steps, baseline: noBaseline }),
    (e) => e instanceof Blocked && e.message === 'reset step y/bad has unknown phase bogus');
  assert.equal(ran, false);
});

test('an untyped failure becomes Blocked "reset failed"', async () => {
  const steps = [{ phase: 'prepare', name: 's', owner: 'x', run: () => { throw new Error('boom'); } }];
  await assert.rejects(reset({}, { steps, baseline: noBaseline }),
    (e) => e instanceof Blocked && e.message === 'reset failed: boom');
});

test('a typed failure passes through', async () => {
  for (const Err of [Blocked, Ko, Inconclusive]) {
    const steps = [{ phase: 'probe', name: 's', owner: 'x', run: () => { throw new Err('typed'); } }];
    await assert.rejects(reset({}, { steps, baseline: noBaseline }),
      (e) => e instanceof Err && e.message === 'typed');
  }
});

test('the default baseline runs config reset.baseline', async (t) => {
  const marker = join(mkdtempSync(join(tmpdir(), 'reset-')), 'marker.txt');
  withConfig(t, { reset: { baseline: `echo hi > '${marker}'` } });
  await reset({});
  assert.equal(readFileSync(marker, 'utf8').trim(), 'hi');
});

test('a failing default baseline is Blocked with the exit code and stderr', async (t) => {
  withConfig(t, { reset: { baseline: 'echo nope >&2; exit 3' } });
  await assert.rejects(defaultBaseline({ reg: {} }),
    (e) => e instanceof Blocked && e.message === 'reset exited 3: nope');
});

test('no baseline configured and no hook is a no-op', async (t) => {
  withConfig(t, { reset: { baseline: null } });
  await reset({});
  await defaultBaseline({ reg: {} });
});

test('a baseline hook replaces the default', async (t) => {
  let got;
  withConfig(t, { reset: { baseline: 'exit 9' } }, { reset: { baseline: async (a) => { got = a; } } });
  const reg = { id: 1 };
  await reset(reg);
  assert.equal(got.reg, reg);
});
