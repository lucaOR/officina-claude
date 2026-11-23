import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { routeFault } from '../fault.mjs';
import * as browserAdapter from '../adapter-browser.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: { browser: browserAdapter }, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

// routeFault exists because a database-level fault is too coarse for "the write fails but the
// screen keeps working": breaking the table also breaks the read that renders the screen. So a
// non-matching request must pass through UNTOUCHED (via fallback, not fulfil), and the matcher
// must be able to discriminate by method.
function fakePage() {
  const routes = [];
  return {
    routes,
    route: async (_pattern, handler) => { routes.push(handler); },
    unroute: async (_pattern, handler) => {
      const i = routes.indexOf(handler);
      if (i >= 0) routes.splice(i, 1);
    },
  };
}

const fakeRoute = (method, url) => {
  const calls = { fulfilled: null, fellBack: false };
  return {
    calls,
    request: () => ({ method: () => method, url: () => url }),
    fulfill: async opts => { calls.fulfilled = opts; },
    fallback: async () => { calls.fellBack = true; },
  };
};

test('routeFault() fulfils only what the matcher accepts and falls back otherwise', async () => {
  const page = fakePage();
  const fault = await routeFault(page, r => r.method() === 'DELETE' && r.url().includes('/widgets/'));

  const del = fakeRoute('DELETE', 'https://x/api/v1/widgets/abc');
  await page.routes[0](del);
  assert.equal(del.calls.fulfilled.status, 500);
  assert.equal(del.calls.fellBack, false);

  // same collection path, different verb: the read that renders the list must survive untouched
  const get = fakeRoute('GET', 'https://x/api/v1/widgets/abc');
  await page.routes[0](get);
  assert.equal(get.calls.fulfilled, null);
  assert.equal(get.calls.fellBack, true);

  assert.equal(fault.count, 1);
});

test('routeFault() answers with the given status and body', async () => {
  const page = fakePage();
  await routeFault(page, () => true, { status: 503, body: '{"message":"down"}' });
  const route = fakeRoute('GET', 'https://x/a');
  await page.routes[0](route);
  assert.equal(route.calls.fulfilled.status, 503);
  assert.equal(route.calls.fulfilled.body, '{"message":"down"}');
  assert.equal(route.calls.fulfilled.contentType, 'application/json');
});

test('routeFault() clear() removes the interception', async () => {
  const page = fakePage();
  const fault = await routeFault(page, () => true);
  assert.equal(page.routes.length, 1);
  await fault.clear();
  assert.equal(page.routes.length, 0);
});

test('routeFault() refuses a non-predicate matcher rather than over-matching', async () => {
  await assert.rejects(
    () => routeFault(fakePage(), '/widgets/'),
    err => err instanceof Blocked && /METHOD is pinned/.test(err.message),
  );
});
