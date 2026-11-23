// browser.mjs is the one lever a compiled script cannot reach around, so its
// contract with scenario.mjs — populate ctx.page/ctx.browser, register the
// close as a ctx cleanup, and hand captureEvidence a real file — is asserted
// here against a fake playwright rather than a live Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowser, screenshot, snap, SNAP_SETTLE_CAP_MS, recordDiagnostics } from '../browser.mjs';
import { LAUNCH_OPTIONS, CONTEXT_OPTIONS } from '../login.mjs';
import { REPO } from '../paths.mjs';

function fakePlaywright() {
  const calls = { launch: null, newContext: null, closed: 0, pages: 0 };
  const page = { screenshot: async () => {} };
  const context = {
    newPage: async () => { calls.pages++; return page; },
  };
  const browser = {
    newContext: async opts => { calls.newContext = opts; return context; },
    close: async () => { calls.closed++; },
  };
  const chromium = { launch: async opts => { calls.launch = opts; return browser; } };
  return { calls, page, context, browser, playwright: async () => ({ chromium }) };
}

function newCtx() {
  return { epic: 'demo-epic', id: 'X-01', page: null, browser: null, cleanups: [] };
}

test('openBrowser fills the ctx fields scenario.mjs reads', async () => {
  const fake = fakePlaywright();
  const ctx = newCtx();
  const out = await openBrowser(ctx, { playwright: fake.playwright });

  assert.equal(ctx.page, fake.page);
  assert.equal(ctx.browser, fake.browser);
  assert.equal(out.page, fake.page);
  assert.equal(out.context, fake.context);
  assert.equal(fake.calls.pages, 1);
});

test('openBrowser registers the close as a ctx cleanup, not a local finally', async () => {
  // scenario() ends in process.exit(), which never unwinds a script-local
  // finally — so the browser is only ever closed if it went onto ctx.cleanups.
  const fake = fakePlaywright();
  const ctx = newCtx();
  await openBrowser(ctx, { playwright: fake.playwright });

  assert.equal(ctx.cleanups.length, 1);
  assert.equal(fake.calls.closed, 0);
  await ctx.cleanups[0]();
  assert.equal(fake.calls.closed, 1);
});

test('openBrowser starts from the library launch/context options and lets a caller add to them', async () => {
  const fake = fakePlaywright();
  await openBrowser(newCtx(), {
    playwright: fake.playwright,
    launchOptions: { slowMo: 250 },
    contextOptions: { locale: 'it-IT' },
  });

  assert.deepEqual(fake.calls.launch, { ...LAUNCH_OPTIONS, slowMo: 250 });
  assert.deepEqual(fake.calls.newContext, { ...CONTEXT_OPTIONS, locale: 'it-IT' });
});

test('screenshot writes page.png under an absolute evidence dir', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'scn-shot-')), 'B-06');
  const ctx = newCtx();
  // Playwright writes the file itself; the fake stands in for that so the
  // directory-creation half stays observable.
  ctx.page = { screenshot: async ({ path }) => { writeFileSync(path, 'png'); } };

  const out = await screenshot(ctx, dir);

  assert.equal(out, join(dir, 'page.png'));
  assert.equal(existsSync(out), true, 'the evidence directory must be created before the shot');
});

test('screenshot resolves a repo-relative evidence dir, the shape result.mjs produces', async () => {
  // evidenceDir() returns 'docs/scenario-runs/<epic>/<date>/<id>' — relative,
  // and a compiled script may be spawned from any cwd, so it has to be
  // resolved against the repo root rather than the process's.
  const seen = [];
  const ctx = newCtx();
  ctx.page = { screenshot: async ({ path }) => { seen.push(path); } };

  const out = await screenshot(ctx, 'docs/scenario-runs/demo-epic/2026-01-01/B-06', { mkdir: () => {}, write: () => {} });

  assert.equal(out, join(REPO, 'docs/scenario-runs/demo-epic/2026-01-01/B-06/page.png'));
  assert.deepEqual(seen, [out]);
});

test('screenshot returns null when there is no page, instead of throwing', async () => {
  // scenario() routes captureEvidence through safe(), so a throw would be
  // swallowed and indistinguishable from "nothing to record" — a be-only KO
  // must return the honest null.
  assert.equal(await screenshot(newCtx(), '/tmp/scn-never-written'), null);
});

// A page that records its listeners so a test can fire them.
function listenerPage() {
  const handlers = {};
  return { handlers, on: (name, fn) => { handlers[name] = fn; }, url: () => 'https://x/app/server-error', screenshot: async () => {} };
}

test('recordDiagnostics keeps console, page errors, failed requests and 4xx/5xx bodies', async () => {
  const page = listenerPage();
  const log = recordDiagnostics(page);

  page.handlers.console({ type: () => 'error', text: () => 'boom' });
  page.handlers.pageerror(new Error('uncaught'));
  page.handlers.requestfailed({ method: () => 'GET', url: () => 'https://x/a', failure: () => ({ errorText: 'net::ERR' }) });
  await page.handlers.response({ status: () => 200, url: () => 'https://x/ok', request: () => ({ method: () => 'GET' }), text: async () => 'fine' });
  await page.handlers.response({ status: () => 500, url: () => 'https://x/api', request: () => ({ method: () => 'POST' }), text: async () => 'SERVER_ERROR '.repeat(100) });

  assert.equal(log.console[0].text, 'boom');
  assert.equal(log.pageErrors[0].message, 'uncaught');
  assert.equal(log.failedRequests[0].error, 'net::ERR');
  assert.equal(log.badResponses.length, 1, 'a 200 is not recorded');
  assert.equal(log.badResponses[0].status, 500);
  assert.equal(log.badResponses[0].body.length, 500, 'the body is truncated');
});

test('recordDiagnostics keeps the status line when the body is gone', async () => {
  const page = listenerPage();
  const log = recordDiagnostics(page);
  await page.handlers.response({ status: () => 302, url: () => 'u', request: () => ({ method: () => 'GET' }), text: async () => { throw new Error('gone'); } });
  await page.handlers.response({ status: () => 502, url: () => 'u', request: () => ({ method: () => 'GET' }), text: async () => { throw new Error('gone'); } });
  assert.equal(log.badResponses.length, 1);
  assert.equal(log.badResponses[0].body, null);
});

test('recordDiagnostics tolerates a page without an event API', () => {
  assert.deepEqual(recordDiagnostics({}).console, []);
});

test('screenshot writes browser.json beside page.png', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'scn-diag-')), 'B-03');
  const ctx = newCtx();
  ctx.page = listenerPage();
  ctx.browserLog = recordDiagnostics(ctx.page);
  ctx.page.handlers.console({ type: () => 'error', text: () => 'boom' });

  await screenshot(ctx, dir);

  const diag = JSON.parse(readFileSync(join(dir, 'browser.json'), 'utf8'));
  assert.equal(diag.url, 'https://x/app/server-error');
  assert.equal(diag.console[0].text, 'boom');
});

test('snap numbers step shots in call order under the evidence steps dir, wiping it on the first shot', async () => {
  const seen = [];
  const removed = [];
  const ctx = newCtx();
  ctx.page = { evaluate: async () => {}, screenshot: async ({ path }) => { seen.push(path); } };
  const opts = { today: () => '2026-01-01', mkdir: () => {}, rm: (p) => removed.push(p) };

  const first = await snap(ctx, 'Confirm popup', opts);
  const second = await snap(ctx, 'running banner!', opts);

  const dir = join(REPO, 'docs/scenario-runs/demo-epic/2026-01-01/X-01/steps');
  assert.equal(first, join(dir, '01-confirm-popup.png'));
  assert.equal(second, join(dir, '02-running-banner.png'));
  assert.deepEqual(seen, [first, second]);
  assert.deepEqual(removed, [dir], 'only the first snap of a run clears the steps dir');
});

test('snap returns null instead of throwing when there is no page or the shot fails', async () => {
  assert.equal(await snap(newCtx(), 'x'), null);
  const ctx = newCtx();
  ctx.page = { evaluate: async () => {}, screenshot: async () => { throw new Error('page closed'); } };
  assert.equal(await snap(ctx, 'x', { mkdir: () => {}, rm: () => {} }), null);
});

test('snap lets running animations settle in the page, capped, before it shoots', async () => {
  const order = [];
  const ctx = newCtx();
  ctx.page = {
    evaluate: async (fn, cap) => { order.push(['settle', typeof fn, cap]); },
    screenshot: async () => { order.push(['shot']); },
  };
  await snap(ctx, 'x', { mkdir: () => {}, rm: () => {} });
  assert.deepEqual(order, [['settle', 'function', SNAP_SETTLE_CAP_MS], ['shot']]);
  assert.ok(SNAP_SETTLE_CAP_MS > 0 && SNAP_SETTLE_CAP_MS <= 2000, 'the cap must bound an endless spinner');
});

test('snap still shoots when the settle evaluate fails', async () => {
  const shots = [];
  const ctx = newCtx();
  ctx.page = {
    evaluate: async () => { throw new Error('execution context was destroyed'); },
    screenshot: async ({ path }) => { shots.push(path); },
  };
  const path = await snap(ctx, 'x', { mkdir: () => {}, rm: () => {} });
  assert.ok(path, 'a failed settle must not cost the picture');
  assert.deepEqual(shots, [path]);
});
