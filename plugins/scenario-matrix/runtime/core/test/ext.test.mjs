import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hook, hookValue, adapters, contributions, driver, hasDriver, tenantOf, __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';

test('hook returns the project function when defined, else the fallback', (t) => {
  const isWarm = () => true;
  t.after(__setForTest({ hooks: { lifecycle: { isWarm, up: 'not a function' }, summaryExtras: isWarm } }));
  const fallback = () => false;
  assert.equal(hook('lifecycle.isWarm', fallback), isWarm);
  assert.equal(hook('summaryExtras', fallback), isWarm);
  assert.equal(hook('lifecycle.warmUp', fallback), fallback);
  assert.equal(hook('lifecycle.up', fallback), fallback);
  assert.equal(hook('nope.deeper.still', fallback), fallback);
  assert.equal(hook('nope'), undefined);
});

test('hookValue returns any defined value, else the fallback', (t) => {
  const ops = { go: {} };
  t.after(__setForTest({ hooks: { login: { ops }, check: { keys: 0 } } }));
  assert.equal(hookValue('login.ops', null), ops);
  assert.equal(hookValue('check.keys', 'x'), 0);
  assert.equal(hookValue('check.rowFields', 'dflt'), 'dflt');
});

test('driver throws Blocked naming the providing adapters when none is installed', (t) => {
  t.after(__setForTest({
    adapters: {},
    providers: { shell: ['alpha'], web: ['alpha', 'beta', 'gamma'] },
  }));
  assert.throws(() => driver('shell'),
    err => err instanceof Blocked && err.message === 'shell needs the alpha adapter: run /scenario-matrix:setup --add alpha');
  assert.throws(() => driver('web'),
    err => err instanceof Blocked && err.message === 'web needs the alpha adapter (or beta, gamma): run /scenario-matrix:setup --add alpha');
  assert.throws(() => driver('mystery'),
    err => err instanceof Blocked && err.message === 'no catalog adapter provides mystery');
  assert.equal(hasDriver('shell'), false);
  assert.equal(hasDriver('mystery'), false);
});

test('driver returns the first installed provider in ADAPTERS order', (t) => {
  const one = () => 1;
  const two = () => 2;
  t.after(__setForTest({
    adapters: { a: { drivers: { shell: one } }, b: { drivers: { shell: two, web: two } } },
    providers: { shell: ['a', 'b'], web: ['b'] },
  }));
  assert.equal(driver('shell'), one);
  assert.equal(driver('web'), two);
  assert.equal(hasDriver('web'), true);
  assert.deepEqual(adapters().map(a => a.name), ['a', 'b']);
});

test('tenantOf reads the option named by tenantKey and is null when tenantKey is null', () => {
  let restore = __setForTest({ config: { tenantKey: null } });
  try {
    assert.equal(tenantOf({ site: 'north' }), null);
  } finally {
    restore();
  }
  restore = __setForTest({ config: { tenantKey: 'site' } });
  try {
    assert.equal(tenantOf({ site: 'north' }), 'north');
    assert.equal(tenantOf({ other: 1 }), null);
    assert.equal(tenantOf(undefined), null);
  } finally {
    restore();
  }
});

test('contributions tags each item with its owner adapter', (t) => {
  const before = () => {};
  const shoot = () => {};
  t.after(__setForTest({
    adapters: {
      a: { beforeAttempt: before, fatalLogPatterns: ['FATAL', 'PANIC'], lint: [{ id: 'r1' }] },
      b: { evidence: shoot, lint: [{ id: 'r2' }], artifactKinds: ['dump'] },
      c: {},
    },
  }));
  assert.deepEqual(contributions('beforeAttempt'), [{ owner: 'a', fn: before }]);
  assert.deepEqual(contributions('evidence'), [{ owner: 'b', fn: shoot }]);
  assert.deepEqual(contributions('fatalLogPatterns'), [
    { owner: 'a', pattern: 'FATAL' },
    { owner: 'a', pattern: 'PANIC' },
  ]);
  assert.deepEqual(contributions('lint'), [{ id: 'r1', owner: 'a' }, { id: 'r2', owner: 'b' }]);
  assert.deepEqual(contributions('httpClient'), []);
});

test('__setForTest restores what it replaced', () => {
  const sentinel = () => 'x';
  const restore = __setForTest({ hooks: { only: sentinel }, adapters: { z: {} }, providers: {} });
  assert.equal(hook('only'), sentinel);
  restore();
  assert.equal(hook('only'), undefined);
  assert.equal(adapters().some(a => a.name === 'z'), false);
});
