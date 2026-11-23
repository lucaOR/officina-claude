// The recipe engine's grammar and drive, asserted against fake registries and fake pages. No
// Chromium is launched: the decisions under test (what a line parses to, which ops run, what is
// refused) are all reachable without a browser.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseStep, expandRecipe, assertMarker, login, parseMarker, TIMEOUTS,
} from '../login.mjs';
import * as browserAdapter from '../adapter-browser.mjs';
import { __setForTest } from '../ext.mjs';
import { loadRegistryFromPath } from '../registry.mjs';
import { Blocked, Inconclusive } from '../errors.mjs';

let restoreExt;
const install = ({ hooks = {}, config = {} } = {}) => {
  restoreExt?.();
  restoreExt = __setForTest({ adapters: { browser: browserAdapter }, providers: {}, hooks, config });
};
beforeEach(() => install());
afterEach(() => restoreExt());

const RECIPES = {
  'sign-in': [
    'navigate {app}',
    'type {id} into email',
    'click "Next"',
    'expect-screen passwordForm',
    'type {password} into password',
    'click "Login"',
    'expect-screen authed',
  ],
  dashboard: ['include sign-in', 'navigate {admin}', 'expect-screen dashboard'],
};

const REG = {
  recipe: name => RECIPES[name],
  host: alias => ({ app: 'app.example.test', admin: 'http://admin.example.test:8080' })[alias],
};

test('parseStep classifies each built-in op', () => {
  assert.deepEqual(parseStep('navigate {app}', []), { op: 'navigate', arg: '{app}' });
  assert.deepEqual(parseStep('type {id} into email', []), { op: 'type', arg: '{id}', field: 'email' });
  assert.deepEqual(parseStep('click "Next"', []), { op: 'click', arg: 'Next' });
  assert.deepEqual(parseStep('expect-screen passwordForm', []), { op: 'expect-screen', arg: 'passwordForm' });
  assert.deepEqual(parseStep('include sign-in', []), { op: 'include', arg: 'sign-in' });
});

test('parseStep recognises a project op by name, with or without an argument', () => {
  const ops = ['pick-workspace', 'accept-terms'];
  assert.deepEqual(parseStep('pick-workspace {ws}', ops), { op: 'pick-workspace', arg: '{ws}' });
  assert.deepEqual(parseStep('accept-terms', ops), { op: 'accept-terms', arg: null });
  assert.deepEqual(parseStep('accept-terms', new Set(ops)), { op: 'accept-terms', arg: null });
});

test('parseStep keeps an unrecognised line as raw', () => {
  assert.deepEqual(parseStep('solve the puzzle', ['accept-terms']), { op: 'raw', arg: 'solve the puzzle' });
  assert.deepEqual(parseStep('accept-terms', []), { op: 'raw', arg: 'accept-terms' });
});

test('expandRecipe inlines include in place', () => {
  const steps = expandRecipe(REG, 'dashboard');
  assert.equal(steps[0].op, 'navigate');
  assert.equal(steps.length, 7 + 2);
  assert.equal(steps.at(-1).arg, 'dashboard');
});

test('stopAt truncates after the named marker', () => {
  const steps = expandRecipe(REG, 'sign-in', { stopAt: 'passwordForm' });
  assert.equal(steps.at(-1).op, 'expect-screen');
  assert.equal(steps.at(-1).arg, 'passwordForm');
});

test('a stopAt marker the recipe lacks is Inconclusive', () => {
  assert.throws(() => expandRecipe(REG, 'sign-in', { stopAt: 'nowhere' }),
    err => err instanceof Inconclusive && /stop_at marker not in recipe sign-in: nowhere/.test(err.message));
});

test('expandRecipe rejects an infinite include cycle', () => {
  const cyclic = { recipe: n => (n === 'a' ? ['include b'] : ['include a']) };
  assert.throws(() => expandRecipe(cyclic, 'a'), /include cycle/);
});

test('expandRecipe allows a diamond include and the same include twice, which are not cycles', () => {
  const recipes = {
    top: ['include left', 'include right'],
    left: ['include shared', 'click "Left"'],
    right: ['include shared', 'click "Right"'],
    shared: ['navigate {app}'],
    twice: ['include shared', 'include shared'],
  };
  const diamond = { recipe: n => recipes[n] };
  assert.deepEqual(expandRecipe(diamond, 'top').map(s => [s.op, s.arg]), [
    ['navigate', '{app}'], ['click', 'Left'], ['navigate', '{app}'], ['click', 'Right'],
  ]);
  assert.equal(expandRecipe(diamond, 'twice').length, 2);
});

test('expandRecipe still rejects a cycle reached through a diamond branch', () => {
  const recipes = { top: ['include left', 'include right'], left: ['navigate {app}'], right: ['include deep'], deep: ['include right'] };
  assert.throws(() => expandRecipe({ recipe: n => recipes[n] }, 'top'), err => err instanceof Inconclusive && /include cycle at recipe right/.test(err.message));
});

test('expandRecipe refuses a login.ops name that shadows a built-in op', () => {
  install({ hooks: { login: { ops: { navigate: { run: async () => {} } } } } });
  assert.throws(() => expandRecipe(REG, 'sign-in'),
    err => err instanceof Inconclusive && /navigate/.test(err.message) && /built-in/.test(err.message));
});

test('transformRecipe rewrites included recipes too', () => {
  const seen = [];
  install({
    hooks: {
      login: {
        transformRecipe: (lines, { name, tenant }) => {
          seen.push([name, tenant]);
          return lines.filter(l => l !== 'click "Next"');
        },
      },
    },
  });
  const steps = expandRecipe(REG, 'dashboard', { tenant: 'north' });
  assert.equal(steps.some(s => s.op === 'click' && s.arg === 'Next'), false, 'the included recipe was transformed');
  assert.deepEqual(seen, [['dashboard', 'north'], ['sign-in', 'north']]);
  assert.equal(steps.length, 6 + 2);
});

// --- login() --------------------------------------------------------------

function recordingPage() {
  const calls = [];
  return {
    calls,
    goto: async (url, opts) => { calls.push(['goto', url, opts.waitUntil]); },
    url: () => 'https://app.example.test/home',
    locator: sel => ({ first: () => ({ fill: async v => { calls.push(['fill', sel, v]); } }) }),
  };
}

test('navigate resolves with use navigate and the tenant', async () => {
  const seen = [];
  install({
    hooks: {
      resolveHost: (alias, ctx) => {
        seen.push([alias, ctx.use, ctx.tenant, typeof ctx.reg.host]);
        return `https://${alias}.hooked.test`;
      },
    },
    config: { tenantKey: 'tenant' },
  });
  const page = recordingPage();
  await login({ ...REG, recipe: () => ['navigate {app}'] }, page, 'r', { tenant: 'north' });
  assert.deepEqual(seen, [['app', 'navigate', 'north', 'function']]);
  assert.deepEqual(page.calls, [['goto', 'https://app.hooked.test', 'domcontentloaded']]);
});

test('navigate defaults to reg.host, adding https only when there is no scheme', async () => {
  const page = recordingPage();
  await login({ ...REG, recipe: () => ['navigate {app}', 'navigate {admin}'] }, page, 'r', {});
  assert.deepEqual(page.calls.map(c => c[1]), ['https://app.example.test', 'http://admin.example.test:8080']);
});

test('navigate passes the tenant as null when none is given', async () => {
  let tenant = 'unset';
  install({
    hooks: { resolveHost: (a, c) => { tenant = c.tenant; return 'https://x.test'; } },
    config: { tenantKey: 'tenant' },
  });
  await login({ ...REG, recipe: () => ['navigate {app}'] }, recordingPage(), 'r', {});
  assert.equal(tenant, null);
});

test('a project hook can refuse a navigation by throwing', async () => {
  install({
    hooks: {
      resolveHost: (a, { use, params }) => {
        if (use === 'navigate' && params.needs_flags) throw new Inconclusive('needs launch flags');
        return 'x.test';
      },
    },
  });
  await assert.rejects(
    () => login({ ...REG, recipe: () => ['navigate {app}'] }, recordingPage(), 'r', { needs_flags: true }),
    /needs launch flags/,
  );
});

test('type fills the matching field from the params', async () => {
  const page = recordingPage();
  await login({ ...REG, recipe: () => ['type {id} into email'] }, page, 'r', { id: 'alice' });
  assert.deepEqual(page.calls[0].slice(2), ['alice']);
});

test('a missing login parameter is Inconclusive', async () => {
  await assert.rejects(
    () => login({ ...REG, recipe: () => ['type {id} into email'] }, recordingPage(), 'r', {}),
    err => err instanceof Inconclusive && /login param missing: id/.test(err.message),
  );
});

test('a login op no lever implements is Inconclusive', async () => {
  await assert.rejects(
    () => login({ ...REG, recipe: () => ['solve the captcha'] }, recordingPage(), 'r', {}),
    err => err instanceof Inconclusive && /unimplemented login op: raw solve the captcha/.test(err.message),
  );
});

test('a project op runs with the shared state and its out merges into the result', async () => {
  const envs = [];
  install({
    hooks: {
      login: {
        ops: {
          'pick-workspace': {
            run: async (step, env) => {
              envs.push({ step, env });
              env.state.picked = step.arg;
              env.state.out.workspace = step.arg;
            },
          },
          'confirm-workspace': {
            run: async (step, env) => { env.state.out.confirmed = env.state.picked; },
          },
        },
      },
    },
    config: { tenantKey: 'tenant' },
  });
  const page = recordingPage();
  const reg = { ...REG, recipe: () => ['pick-workspace {ws}', 'confirm-workspace'] };
  const out = await login(reg, page, 'pick', { tenant: 'north' });

  assert.deepEqual(out, {
    url: 'https://app.example.test/home', tokenResponse: null, client: null, workspace: '{ws}', confirmed: '{ws}',
  });
  assert.equal(envs[0].env.page, page);
  assert.equal(envs[0].env.reg, reg);
  assert.equal(envs[0].env.recipe, 'pick');
  assert.equal(envs[0].env.tenant, 'north');
  assert.deepEqual(envs[0].env.params, { tenant: 'north' });
  assert.deepEqual(envs[0].step, { op: 'pick-workspace', arg: '{ws}' });
});

test('state is fresh for every login() call', async () => {
  install({
    hooks: {
      login: {
        ops: {
          mark: { run: async (s, env) => { env.state.n = (env.state.n ?? 0) + 1; env.state.out.n = env.state.n; } },
        },
      },
    },
  });
  const reg = { ...REG, recipe: () => ['mark'] };
  assert.equal((await login(reg, recordingPage(), 'r', {})).n, 1);
  assert.equal((await login(reg, recordingPage(), 'r', {})).n, 1);
});

test('a browser-free op runs without a page, any other op needs one', async () => {
  const ran = [];
  install({
    hooks: {
      login: {
        ops: {
          free: { browserFree: true, run: async () => { ran.push('free'); } },
          paged: { run: async () => { ran.push('paged'); } },
        },
      },
    },
  });
  const out = await login({ ...REG, recipe: () => ['free'] }, null, 'r', {});
  assert.deepEqual(out, { url: null, tokenResponse: null, client: null });
  assert.deepEqual(ran, ['free']);

  await assert.rejects(
    () => login({ ...REG, recipe: () => ['paged'] }, null, 'r', {}),
    err => err instanceof Inconclusive
      && err.message === "login(r) step 'paged' needs a Playwright page and none was given "
        + '-- pass one, or use a browser-free recipe',
  );
  await assert.rejects(() => login({ ...REG, recipe: () => ['navigate {app}'] }, null, 'r', {}), /needs a Playwright page/);
});

test('a consumed param without its op throws Inconclusive', async () => {
  install({
    hooks: { login: { ops: { 'accept-terms': { consumes: ['accept_as', 'midflow'], run: async () => {} } } } },
  });
  const reg = {
    ...REG,
    recipe: () => ['navigate {app}', 'expect-screen done', 'accept-terms'],
    marker: () => ({ kind: 'url', value: '.' }),
  };
  const reached = { ...recordingPage(), waitForURL: async () => {} };
  await assert.rejects(
    () => login(reg, reached, 'plain', { accept_as: 'bob', midflow: 'x', stop_at: 'done' }),
    err => err instanceof Inconclusive
      && /accept_as and midflow passed to login\(plain\) but the recipe never reached accept-terms \(stop_at: done\)/
        .test(err.message)
      && /testing nothing/.test(err.message),
  );
  const plain = { ...REG, recipe: () => ['navigate {app}'] };
  await assert.rejects(
    () => login(plain, recordingPage(), 'plain', { accept_as: 'bob' }),
    err => /accept_as passed to login\(plain\) but the recipe never reached accept-terms --/.test(err.message),
  );
});

test('a consumed param is fine when its op ran, or when the param was not passed', async () => {
  install({ hooks: { login: { ops: { 'accept-terms': { consumes: ['accept_as'], run: async () => {} } } } } });
  await login({ ...REG, recipe: () => ['accept-terms'] }, recordingPage(), 'r', { accept_as: 'bob' });
  await login({ ...REG, recipe: () => ['navigate {app}'] }, recordingPage(), 'r', {});
  await login({ ...REG, recipe: () => ['navigate {app}'] }, recordingPage(), 'r', { accept_as: null });
});

// --- markers --------------------------------------------------------------

test('parseMarker rejects an unprefixed marker', () => {
  assert.throws(() => parseMarker('passwordForm'),
    err => err instanceof Blocked && /marker must start with dom: or url:/.test(err.message));
  assert.deepEqual(parseMarker('dom:input[type=x]'), { kind: 'dom', value: 'input[type=x]' });
});

function markerReg(markers, hosts = { app: 'app.example.test' }) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-login-'));
  const file = join(dir, 'epic.yaml');
  writeFileSync(file, JSON.stringify({
    infra: { env_registry: { hosts, login: { 'sign-in': ['navigate {app}'], markers } } },
    scenarios: [],
  }));
  return loadRegistryFromPath(file, 'epic');
}

test('marker() resolves {host:<kind>} through resolveHost with use marker, escaping dots', () => {
  const seen = [];
  install({
    hooks: { resolveHost: (alias, ctx) => { seen.push([alias, ctx.use, ctx.tenant, 'params' in ctx]); return 'a.b.test'; } },
    config: { tenantKey: 'tenant' },
  });
  const reg = markerReg({ authed: 'url:^https://{host:app}/home' });
  assert.deepEqual(reg.marker('authed', { tenant: 'north' }), { kind: 'url', value: '^https://a\\.b\\.test/home' });
  assert.deepEqual(seen, [['app', 'marker', 'north', false]]);
});

test('marker() defaults to reg.host and leaves regex quantifiers alone', () => {
  const reg = markerReg({ authed: 'url:^https://{host:app}/', uuid: 'dom:[0-9a-f]{8}-x' });
  assert.equal(reg.marker('authed').value, '^https://app\\.example\\.test/');
  assert.equal(reg.marker('uuid').value, '[0-9a-f]{8}-x');
});

test('marker() throws Blocked on an unknown marker and an unknown host kind', () => {
  const reg = markerReg({ bad: 'dom:{host:nope}' });
  assert.throws(() => reg.marker('nope'), err => err instanceof Blocked && /unknown marker: nope/.test(err.message));
  assert.throws(() => reg.marker('bad'), err => err instanceof Blocked && /unknown host alias: nope/.test(err.message));
});

test('recipe() returns the lines and throws Blocked on an unknown recipe', () => {
  const reg = markerReg({});
  assert.deepEqual(reg.recipe('sign-in'), ['navigate {app}']);
  assert.throws(() => reg.recipe('nope'), err => err instanceof Blocked && /unknown login recipe: nope/.test(err.message));
});

function markerPage({ url = 'https://app.example.test/home', visible = true } = {}) {
  const waits = [];
  return {
    waits,
    url: () => url,
    waitForURL: async (re, opts) => { waits.push(['url', re, opts.timeout]); if (!re.test(url)) throw new Error('timeout'); },
    locator: sel => ({
      first: () => ({
        waitFor: async opts => { waits.push(['dom', sel, opts.state]); if (!visible) throw new Error('timeout'); },
      }),
    }),
  };
}

test('assertMarker passes a matching url marker and a visible dom marker', async () => {
  const reg = markerReg({ home: 'url:/home$', box: 'dom:#box' });
  const page = markerPage();
  await assertMarker(reg, page, 'home');
  await assertMarker(reg, page, 'box');
  assert.equal(page.waits[0][2], TIMEOUTS.marker);
  assert.deepEqual(page.waits[1], ['dom', '#box', 'visible']);
});

test('assertMarker is Blocked when the marker is not reached', async () => {
  const reg = markerReg({ other: 'url:/other$', box: 'dom:#box' });
  await assert.rejects(() => assertMarker(reg, markerPage(), 'other'),
    err => err instanceof Blocked
      && /marker other: url https:\/\/app\.example\.test\/home !~ \/other\$/.test(err.message));
  await assert.rejects(() => assertMarker(reg, markerPage({ visible: false }), 'box'),
    err => err instanceof Blocked && /marker box: no visible element for #box/.test(err.message));
});

test('assertMarker resolves the marker for the tenant in opts', async () => {
  const tenants = [];
  install({ hooks: {}, config: { tenantKey: 'tenant' } });
  const reg = { marker: (name, opts) => { tenants.push(opts.tenant); return { kind: 'url', value: '.' }; } };
  await assertMarker(reg, markerPage(), 'x', { tenant: 'north' });
  await assertMarker(reg, markerPage(), 'x');
  assert.deepEqual(tenants, ['north', null]);
});

test('the login key validator accepts recipes with markers and rejects malformed ones', () => {
  const { validate } = browserAdapter.registry.keys.login;
  assert.equal(validate({ a: ['navigate {app}'], markers: { m: 'dom:x', u: 'url:y' } }), null);
  assert.match(validate([]), /mapping/);
  assert.match(validate({ a: 'navigate {app}' }), /a must be a list of lines/);
  assert.match(validate({ markers: { m: 'plain' } }), /markers\.m must start with dom: or url:/);
  assert.match(validate({ markers: 'x' }), /markers must be a mapping/);
});

// --- LAUNCH_OPTIONS -------------------------------------------------------
//
// LAUNCH_OPTIONS.headless is read from the environment at module load, so each case re-imports
// login.mjs under a cache-busting query to get a fresh evaluation, then restores the variable.
async function launchOptionsWith(value) {
  const had = Object.hasOwn(process.env, 'SCN_HEADFUL');
  const previous = process.env.SCN_HEADFUL;
  if (value === undefined) delete process.env.SCN_HEADFUL;
  else process.env.SCN_HEADFUL = value;
  try {
    const mod = await import(`../login.mjs?headful=${encodeURIComponent(String(value))}`);
    return mod.LAUNCH_OPTIONS;
  } finally {
    if (had) process.env.SCN_HEADFUL = previous;
    else delete process.env.SCN_HEADFUL;
  }
}

test('LAUNCH_OPTIONS defaults to headless when SCN_HEADFUL is unset', async () => {
  const opts = await launchOptionsWith(undefined);
  assert.equal(opts.headless, true);
  // a sweep against local self-signed certificates fails at navigation without the flag
  assert.deepEqual(opts.args, ['--ignore-certificate-errors']);
});

test('SCN_HEADFUL=1 launches headful', async () => {
  assert.equal((await launchOptionsWith('1')).headless, false);
});

test('only the exact value 1 enables headful', async () => {
  // a stray SCN_HEADFUL=0 or =false in a shell profile must not un-headless an unattended sweep
  for (const value of ['0', 'false', 'true', 'yes', '']) {
    assert.equal((await launchOptionsWith(value)).headless, true, `SCN_HEADFUL=${value}`);
  }
});
