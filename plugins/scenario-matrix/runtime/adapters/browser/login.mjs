// Replays infra.env_registry.login recipes. The grammar half is pure and unit tested; the drive
// half needs a live Playwright page, which selftest.mjs deliberately does not launch.
//
// The engine knows six built-in ops: navigate, type, click, expect-screen, include and raw. A
// project adds its own through the `login.ops` hook, and rewrites a recipe's lines through
// `login.transformRecipe`, so nothing about one product's login flow lives here.
import { Blocked, Inconclusive } from './errors.mjs';
import { hook, hookValue, tenantOf } from './ext.mjs';

export const TIMEOUTS = Object.freeze({ nav: 30000, networkIdle: 10000, marker: 15000 });

// Headless is the default because a sweep opens and closes a window per row, which steals focus
// from whoever is at the keyboard. `SCN_HEADFUL=1` flips it for a watch-it-happen debug run: it is
// read here, once, so no compiled script needs to know about it and no row's staleness hash is
// affected. Exactly '1' enables it: an unset, empty, or any-other-value variable stays headless,
// so a stray `SCN_HEADFUL=0` in a shell profile cannot silently un-headless a sweep. Headful
// needs a working display; with none, chromium.launch() fails outright rather than falling back,
// turning every browser row BLOCKED.
export const LAUNCH_OPTIONS = Object.freeze({
  args: ['--ignore-certificate-errors'],
  headless: process.env.SCN_HEADFUL !== '1',
});
export const CONTEXT_OPTIONS = Object.freeze({ ignoreHTTPSErrors: true });

const BUILT_IN_OPS = ['navigate', 'type', 'click', 'expect-screen', 'include', 'raw'];
// The built-ins that take their argument from a plain `<op> <arg>` line.
const WORD_OPS = new Set(['navigate', 'expect-screen', 'include']);

export function parseMarker(entry) {
  const m = /^(dom|url):([\s\S]+)$/.exec(String(entry));
  if (!m) throw new Blocked(`marker must start with dom: or url: — got ${entry}`);
  return { kind: m[1], value: m[2] };
}

// `opNames` are the project's `login.ops` names. A line parses as `type {x} into <field>`, then
// `click "<label>"`, then `<op> <arg>` when its first word is a built-in word op or a project op
// (no argument gives `arg: null`), else raw.
export function parseStep(line, opNames = []) {
  const s = String(line).trim();
  const names = new Set(opNames);
  let m;
  if ((m = /^type (\{[^}]+\}) into (\S+)$/.exec(s))) return { op: 'type', arg: m[1], field: m[2] };
  if ((m = /^click "(.+)"$/.exec(s))) return { op: 'click', arg: m[1] };
  if ((m = /^(\S+)(?: (.+))?$/.exec(s)) && (WORD_OPS.has(m[1]) || names.has(m[1]))) {
    return { op: m[1], arg: m[2] ?? null };
  }
  return { op: 'raw', arg: s };
}

// The project's ops, refused when one takes a built-in's name: a shadowed built-in would make the
// same recipe line mean different things in different projects.
function projectOps() {
  const ops = hookValue('login.ops', {}) ?? {};
  for (const name of Object.keys(ops)) {
    if (BUILT_IN_OPS.includes(name)) {
      throw new Inconclusive(`login.ops cannot redefine the built-in op '${name}' -- pick another name`);
    }
  }
  return ops;
}

// `seen` holds the recipes on the include path down to this one, so a recipe that includes itself,
// however deep, is a cycle. Each include gets its own copy of the path: two siblings that include the
// same recipe (a diamond) are not a cycle.
export function expandRecipe(reg, name, { tenant = null, stopAt = null, seen = new Set() } = {}) {
  if (seen.has(name)) throw new Inconclusive(`include cycle at recipe ${name}`);
  const path = new Set(seen).add(name);
  const ops = projectOps();
  const opNames = Object.keys(ops);
  const recipe = reg.recipe(name);
  if (!recipe) throw new Inconclusive(`unknown login recipe: ${name}`);
  const lines = hook('login.transformRecipe', l => l)(recipe, { name, tenant, reg });

  let steps = [];
  for (const line of lines) {
    const step = parseStep(line, opNames);
    if (step.op === 'include') {
      steps = steps.concat(expandRecipe(reg, step.arg, { tenant, stopAt: null, seen: path }));
      continue;
    }
    steps.push(step);
  }

  if (stopAt) {
    const idx = steps.findIndex(s => s.op === 'expect-screen' && s.arg === stopAt);
    if (idx === -1) throw new Inconclusive(`stop_at marker not in recipe ${name}: ${stopAt}`);
    steps = steps.slice(0, idx + 1);
  }
  return steps;
}

// One alias becomes one host through the project's `resolveHost` hook, with the default being the
// registry's own value. `navigate` needs a URL, so a value with no scheme gets `https://`; a
// marker substitutes a bare hostname into a regex, so it keeps the value as it is.
export function resolveHostFor(reg, alias, { tenant = null, use, params } = {}) {
  const fallback = (kind) => {
    const value = reg.host(kind);
    return use === 'navigate' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? `https://${value}` : value;
  };
  const ctx = params === undefined ? { tenant, reg, use } : { tenant, reg, use, params };
  return hook('resolveHost', fallback)(alias, ctx);
}

async function assertMarkerFor(reg, page, name, tenant) {
  const marker = reg.marker(name, { tenant });
  if (marker.kind === 'url') {
    const re = new RegExp(marker.value);
    await page.waitForURL(re, { timeout: TIMEOUTS.marker })
      .catch(() => { throw new Blocked(`marker ${name}: url ${page.url()} !~ ${marker.value}`); });
    return;
  }
  const loc = page.locator(marker.value).first();
  const visible = await loc.waitFor({ state: 'visible', timeout: TIMEOUTS.marker }).then(() => true, () => false);
  if (!visible) throw new Blocked(`marker ${name}: no visible element for ${marker.value}`);
}

export const assertMarker = (reg, page, name, opts = {}) => assertMarkerFor(reg, page, name, tenantOf(opts));

const braced = arg => String(arg).replace(/[{}]/g, '');

export async function login(reg, page, recipe, params = {}) {
  const tenant = tenantOf(params);
  const ops = projectOps();
  const steps = expandRecipe(reg, recipe, { tenant, stopAt: params.stop_at ?? null });
  // Shared by every project op of this call, so a later op can read what an earlier one set.
  const state = { out: {} };
  const ran = new Set();

  for (const step of steps) {
    if (!page && !ops[step.op]?.browserFree) {
      throw new Inconclusive(`login(${recipe}) step '${step.op}' needs a Playwright page and none was given `
        + '-- pass one, or use a browser-free recipe');
    }
    ran.add(step.op);
    if (step.op === 'navigate') {
      if (step.arg == null) throw new Inconclusive(`login(${recipe}) step 'navigate' needs a host alias`);
      const url = resolveHostFor(reg, braced(step.arg), { tenant, use: 'navigate', params });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.nav });
    } else if (step.op === 'type') {
      const key = braced(step.arg);
      if (!(key in params)) throw new Inconclusive(`login param missing: ${key}`);
      await page.locator(`input[name="${step.field}"], input[type="${step.field}"], #${step.field}`)
        .first().fill(String(params[key]));
    } else if (step.op === 'click') {
      await page.getByRole('button', { name: step.arg }).first().click()
        .catch(() => page.locator(`:text("${step.arg}")`).first().click());
    } else if (step.op === 'expect-screen') {
      await assertMarkerFor(reg, page, step.arg, tenant);
    } else if (ops[step.op]) {
      await ops[step.op].run(step, { page, reg, recipe, params, tenant, state });
    } else {
      throw new Inconclusive(`unimplemented login op: ${step.op} ${step.arg ?? ''}`);
    }
  }

  // A param that only one op applies, passed to a recipe that never reached that op, would leave
  // the flow untouched, and a fail-closed assert downstream would then test nothing.
  for (const [op, { consumes = [] }] of Object.entries(ops)) {
    if (ran.has(op)) continue;
    const unapplied = consumes.filter(k => params[k] != null);
    if (unapplied.length) {
      throw new Inconclusive(`${unapplied.join(' and ')} passed to login(${recipe}) but the recipe never reached `
        + `${op}${params.stop_at ? ` (stop_at: ${params.stop_at})` : ''} -- the flow ran untouched, so `
        + 'any fail-closed assert downstream would be testing nothing');
    }
  }
  return { url: page ? page.url() : null, tokenResponse: null, client: null, ...state.out };
}
