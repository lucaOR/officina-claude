// Every lever types what it throws: an untyped throw is reported as a product bug. This file pins
// the browser adapter's side of that classification.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { login, expandRecipe } from '../login.mjs';
import { routeFault } from '../fault.mjs';
import * as browserAdapter from '../adapter-browser.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked, Inconclusive } from '../errors.mjs';

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: { browser: browserAdapter }, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

const page = { goto: async () => {}, url: () => 'about:blank' };
const regOf = lines => ({ recipe: () => lines, host: () => 'app.example.test' });

test('a missing login parameter is Inconclusive', async () => {
  await assert.rejects(
    () => login(regOf(['type {id} into email']), page, 'r', {}),
    err => err instanceof Inconclusive && /login param missing: id/.test(err.message),
  );
});

test('a login op no lever implements is Inconclusive', async () => {
  await assert.rejects(
    () => login(regOf(['solve the captcha']), page, 'r', {}),
    err => err instanceof Inconclusive && /unimplemented login op/.test(err.message),
  );
});

test('an include cycle is Inconclusive', () => {
  assert.throws(
    () => expandRecipe(regOf(['include r']), 'r'),
    err => err instanceof Inconclusive,
  );
  assert.throws(
    () => expandRecipe(regOf([]), 'r', { seen: new Set(['r']) }),
    err => err instanceof Inconclusive,
  );
});

test('an unknown host alias in navigate is Blocked, a registry fact and not a product one', async () => {
  const reg = {
    recipe: () => ['navigate {nope}'],
    host: alias => { throw new Blocked(`unknown host alias: ${alias}`); },
  };
  await assert.rejects(() => login(reg, page, 'r', {}), err => err instanceof Blocked);
});

test('routeFault refuses a non-predicate matcher with Blocked', async () => {
  await assert.rejects(() => routeFault({}, '/x'), err => err instanceof Blocked);
});
