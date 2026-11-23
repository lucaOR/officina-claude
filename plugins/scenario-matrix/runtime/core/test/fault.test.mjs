import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFault, stubFault, dbFault, stopFault, schemaFreeze, race } from '../fault.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';

test('race runs n calls concurrently and reports each outcome', async () => {
  let peak = 0, live = 0;
  const out = await race(4, async i => {
    live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 20));
    live--;
    if (i === 2) throw new Error('boom');
    return i;
  });
  assert.equal(out.length, 4);
  assert.equal(peak, 4, 'all four must overlap');
  assert.deepEqual(out.map(r => r.ok), [true, true, false, true]);
  assert.equal(out[2].error, 'boom');
});

test('race reports a non-Error rejection as its string form', async () => {
  const out = await race(1, async () => { throw 'plain'; });
  assert.deepEqual(out, [{ ok: false, error: 'plain' }]);
});

const FACADES = { routeFault, stubFault, dbFault, stopFault, schemaFreeze };

test('each fault facade forwards every argument unchanged to its driver and returns the result', async (t) => {
  const calls = [];
  const drivers = Object.fromEntries(Object.keys(FACADES).map(n => [n, (...args) => { calls.push([n, args]); return `${n}-result`; }]));
  t.after(__setForTest({ adapters: { fake: { drivers } }, providers: {} }));
  const seam = () => {};
  const args = [{ page: 1 }, 'two', { run: seam, extra: true }];
  for (const [name, fn] of Object.entries(FACADES)) {
    assert.equal(await fn(...args), `${name}-result`);
  }
  assert.deepEqual(calls.map(c => c[0]), Object.keys(FACADES));
  for (const [, got] of calls) {
    assert.equal(got.length, 3);
    assert.equal(got[0], args[0]);
    assert.equal(got[2].run, seam);
  }
});

test('a fault facade with no driver throws Blocked naming the adapter to add', async (t) => {
  t.after(__setForTest({ adapters: {}, providers: { stubFault: ['stubby'], dbFault: ['boxer', 'other'] } }));
  await assert.rejects(async () => stubFault({}, 'x'), err => err instanceof Blocked && /stubFault needs the stubby adapter/.test(err.message));
  await assert.rejects(async () => dbFault({}, 'c'), err => err instanceof Blocked && /needs the boxer adapter \(or other\)/.test(err.message));
  await assert.rejects(async () => routeFault({}, () => true), err => err instanceof Blocked && /no catalog adapter provides routeFault/.test(err.message));
});
