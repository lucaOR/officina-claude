import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as laravelAdapter from '../adapter-laravel.mjs';
import { collectProbes } from '../selftest.mjs';
import { __setForTest } from '../ext.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

const RAW = { exec: { api: { container: 'app-web', workdir: '/srv/api' } } };
const reg = { raw: RAW, ...laravelAdapter.registry.accessors(RAW) };
const CFG = { adapters: { laravel: { selftest: { service: 'api' } } } };

let restoreExt;
beforeEach(() => {
  restoreExt = __setForTest({ adapters: { docker: dockerAdapter, laravel: laravelAdapter }, providers: {}, hooks: {}, config: {} });
});
afterEach(() => restoreExt());

const probes = cfg => collectProbes(reg, cfg).filter(p => p.owner === 'laravel');
const byName = (cfg, prefix) => probes(cfg).find(p => p.name.startsWith(prefix));

test('the adapter contributes the artisan and tinker probes under their established names', () => {
  assert.deepEqual(probes(CFG).map(p => p.name), [
    'artisan: runs in the container',
    'artisan: a failing command surfaces as an error',
    'artisan: refuses a write target outside the database prefix',
    'tinker: multi-line file executes',
    'tinker: dirs a root tinker creates are group-writable (worker gid can write them)',
    'tinker: a failing script surfaces as an error',
  ]);
});

test('every probe needs the selftest service and is skipped without one', () => {
  for (const p of probes({ adapters: { laravel: { selftest: { service: null } } } })) {
    assert.equal(p.missing, 'adapters.laravel.selftest.service', p.name);
  }
  for (const p of probes(CFG)) assert.equal(p.missing, undefined, p.name);
});

test('artisan: runs in the container passes on a version line and fails on anything else', async (t) => {
  installFakeDocker(t, 'cat >/dev/null; echo "Laravel Framework 11.0.0"');
  assert.equal(await byName(CFG, 'artisan: runs').run(reg, CFG), true);
  installFakeDocker(t, 'cat >/dev/null; echo "something else"');
  assert.equal(await byName(CFG, 'artisan: runs').run(reg, CFG), false);
});

test('artisan: a failing command passes when docker exits non-zero', async (t) => {
  installFakeDocker(t, 'cat >/dev/null; echo "Command not defined" >&2; exit 1');
  assert.equal(await byName(CFG, 'artisan: a failing').run(reg, CFG), true);
});

test('the write-target probe passes because the guard refuses, and never reaches docker', async (t) => {
  installFakeDocker(t, 'echo reached >&2; exit 99');
  assert.equal(await byName(CFG, 'artisan: refuses').run(reg, CFG), true);
});

test('tinker: multi-line file executes when the marker comes back', async (t) => {
  installFakeDocker(t, 'cat >/dev/null; echo SCN_OK');
  assert.equal(await byName(CFG, 'tinker: multi-line').run(reg, CFG), true);
});

test('tinker: group-writable passes when the dir mode has the group write bit', async (t) => {
  installFakeDocker(t, 'cat >/dev/null; echo SCN_MODE=2775');
  assert.equal(await byName(CFG, 'tinker: dirs').run(reg, CFG), true);
  installFakeDocker(t, 'cat >/dev/null; echo SCN_MODE=2755');
  assert.equal(await byName(CFG, 'tinker: dirs').run(reg, CFG), false);
});

test('tinker: a failing script passes when docker exits non-zero', async (t) => {
  installFakeDocker(t, 'cat >/dev/null; echo boom >&2; exit 1');
  assert.equal(await byName(CFG, 'tinker: a failing').run(reg, CFG), true);
});
