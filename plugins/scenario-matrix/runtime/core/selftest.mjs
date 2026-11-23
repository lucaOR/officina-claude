#!/usr/bin/env node
// Both-direction verification of the levers, run after any lib edit and before
// a suite run. Core contributes the probes that need no technology; installed
// adapters add theirs through contributions('selftest') and the project through
// the selftest.probes hook.
//
// Each probe is self-sufficient: it does not depend on state another probe left
// behind, so any single probe also passes alone via --only=<name prefix>. The
// filter is a PREFIX match, so `--only=mail` runs `mail` and `mailCount`; pass
// a full name to isolate exactly one. That matters because --only= exists to
// isolate a lever while debugging it, and a probe that only passed as a side
// effect of an earlier one would report a broken lever as healthy.
//
// The terminal line reports how many probes ran, not that every lever has been
// verified.
import { loadRegistry } from './registry.mjs';
import { reset } from './reset.mjs';
import { race } from './fault.mjs';
import { hook, contributions } from './ext.mjs';
import { config } from './config.mjs';
import { isMain } from './paths.mjs';

const CORE_PROBES = [
  {
    // reset() proves its own sentinel internally; this only asserts it did not throw.
    name: 'reset: completes without throwing (reset() proves its own sentinel internally)',
    owner: 'core',
    run: async reg => {
      await reset(reg);
      return true;
    },
  },
  {
    name: 'race: one call per item, and a thrower does not affect its siblings',
    owner: 'core',
    run: async () => {
      const calls = [];
      const results = await race(4, async i => {
        calls.push(i);
        if (i === 2) throw new Error('scn-selftest-race-boom');
        return i;
      });
      if (calls.length !== 4 || new Set(calls).size !== 4) return false;
      if (results.length !== 4) return false;
      return results.every((r, i) => i === 2
        ? r.ok === false && typeof r.error === 'string'
        : r.ok === true && r.value === i);
    },
  },
];

// A flag set to false meets no need, like a value left unset: `enabled: false`
// in an adapter's default config means the probe is off.
const unset = v => v === undefined || v === null || v === '' || v === false;
const lookup = (obj, path) => String(path).split('.').reduce((n, k) => (n == null ? undefined : n[k]), obj);

// Core probes, then adapter probes in adapter order, then the project's. A
// probe whose needs are unset carries `missing`, the first unset config path.
export function collectProbes(reg, cfg) {
  const groups = [
    CORE_PROBES,
    contributions('selftest'),
    hook('selftest.probes', () => [])(reg, { config: cfg }).map(p => ({ ...p, owner: 'project' })),
  ];
  const seen = new Map();
  const out = [];
  for (const p of groups.flat()) {
    if (seen.has(p.name)) {
      throw new Error(`selftest probe ${p.name} is defined by ${seen.get(p.name)} and ${p.owner}`);
    }
    seen.set(p.name, p.owner);
    const missing = (p.needs ?? []).find(path => unset(lookup(cfg, path)));
    out.push({ name: p.name, owner: p.owner, run: p.run, ...(missing === undefined ? {} : { missing }) });
  }
  return out;
}

// `run` is already bound to (reg, cfg) by the caller. One failure never stops
// the remaining probes. Only a `false` result or a throw is a failure.
export async function runChecks(checks, { only } = {}) {
  let ran = 0, failed = 0, skipped = 0;
  for (const c of checks) {
    if (only && !c.name.startsWith(only)) continue;
    if (c.missing !== undefined) {
      skipped++;
      console.log(`skip ${c.name}: needs ${c.missing}`);
      continue;
    }
    ran++;
    try {
      if ((await c.run()) === false) throw new Error('check returned false');
      console.log(`ok ${c.name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${c.name}: ${e.message}`);
    }
  }
  return { ran, failed, skipped };
}

// The epic and the --only prefix the CLI was given. The epic falls back to the
// config's selftest.defaultEpic, so in a project that sets one, a bare
// `selftest.mjs` runs the live probes.
export function cliArgs(args, cfg) {
  const only = args.find(a => a.startsWith('--only='))?.slice('--only='.length);
  const epic = args.find(a => !a.startsWith('--')) ?? cfg.selftest?.defaultEpic ?? undefined;
  return { epic, only };
}

if (isMain(import.meta.url)) {
  const cfg = config();
  const { epic, only } = cliArgs(process.argv.slice(2), cfg);
  if (!epic) {
    console.error('usage: selftest.mjs [epic] [--only=<prefix>]');
    process.exit(64);
  }
  let reg;
  let probes;
  try {
    // Inside the try, so an unknown epic is one line of message, not a stack trace.
    reg = loadRegistry(epic);
    probes = collectProbes(reg, cfg).map(p => ({ ...p, run: () => p.run(reg, cfg) }));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const { ran, failed } = await runChecks(probes, { only });
  console.log(`selftest: ${ran} check(s) ran, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
