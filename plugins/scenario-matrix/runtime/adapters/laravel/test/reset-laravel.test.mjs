import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as laravelAdapter from '../adapter-laravel.mjs';
import { storagePermsCommand, truncateLogsCommand } from '../adapter-laravel.mjs';
import { contributions, __setForTest } from '../ext.mjs';
import { reset } from '../reset.mjs';
import { Blocked } from '../errors.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

const WD = '/srv/api';
const LOGS = `${WD}/storage/logs`;
const CACHE = `${WD}/storage/framework/cache/data`;

const RAW = { exec: { api: { container: 'app-web', workdir: WD }, admin: { container: 'app-admin', workdir: '/srv/admin' } } };
const reg = { raw: RAW, ...laravelAdapter.registry.accessors(RAW) };

let restoreExt;
const install = laravel => {
  restoreExt = __setForTest({
    adapters: { docker: dockerAdapter, laravel: laravelAdapter }, providers: {}, hooks: {},
    config: { adapters: { laravel } },
  });
};
beforeEach(() => install({ truncateLogsOnReset: true }));
afterEach(() => restoreExt());

const stepsOf = () => contributions('reset').filter(s => s.owner === 'laravel');

// A docker that records every call, one line per call.
function fakeDocker(t, body = '') {
  const dir = mkdtempSync(join(tmpdir(), 'scn-reset-laravel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log');
  installFakeDocker(t, `printf 'CALL %s\\n' "$*" >> ${JSON.stringify(log)}\n${body}`);
  return log;
}

test('storagePermsCommand creates both paths before touching either, in exact order', () => {
  // `chmod -R` on a missing directory exits non-zero, so the mkdir has to cover storage/logs too
  // and not just the cache path.
  assert.deepEqual(storagePermsCommand(WD).split(' && '), [
    `mkdir -p ${LOGS} ${CACHE}`,
    `chmod -R a+rwX ${LOGS} ${CACHE}`,
    `chgrp -R www-data ${LOGS} ${CACHE} 2>/dev/null || true`,
    `find ${LOGS} ${CACHE} -type d -exec chmod g+s {} + 2>/dev/null || true`,
  ]);
});

test('storagePermsCommand widens, and never deletes: the workdir may be a real working tree', () => {
  const cmd = storagePermsCommand(WD);
  assert.equal(/\brm\b|\bfind\b[^|]*-delete/.test(cmd), false);
  assert.equal(cmd.includes('a+rwX'), true, 'a+rwX, not a numeric mode that could strip a bit');
});

test('storagePermsCommand suppresses only the ownership half, so a real chmod failure still surfaces', () => {
  const steps = storagePermsCommand(WD).split(' && ');
  assert.equal(steps[1].includes('|| true'), false, 'the chmod must not be suppressed');
  assert.equal(steps[2].includes('|| true'), true);
  assert.equal(steps[3].includes('|| true'), true);
});

test('truncateLogsCommand empties every log file in place and removes none', () => {
  const cmd = truncateLogsCommand(WD);
  assert.equal(cmd, `find ${LOGS} -name '*.log' -exec truncate -s 0 {} +`);
  assert.equal(/\brm\b|-delete/.test(cmd), false);
});

test('both steps run in the normalize phase, permissions first', () => {
  assert.deepEqual(stepsOf().map(s => [s.phase, s.name]), [['normalize', 'storage-perms'], ['normalize', 'truncate-logs']]);
});

test('storage-perms runs once per exec target, as root', async (t) => {
  const log = fakeDocker(t);
  install({ truncateLogsOnReset: false });
  await reset(reg, { baseline: async () => {} });
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    `CALL exec -u root app-web sh -c ${storagePermsCommand(WD)}`,
    `CALL exec -u root app-admin sh -c ${storagePermsCommand('/srv/admin')}`,
  ]);
});

test('truncate-logs runs per exec target when truncateLogsOnReset is set, after the permissions', async (t) => {
  const log = fakeDocker(t);
  await reset(reg, { baseline: async () => {} });
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(2), [
    `CALL exec -u root app-web sh -c ${truncateLogsCommand(WD)}`,
    `CALL exec -u root app-admin sh -c ${truncateLogsCommand('/srv/admin')}`,
  ]);
});

test('truncate-logs is skipped when truncateLogsOnReset is false', async (t) => {
  const log = fakeDocker(t);
  install({ truncateLogsOnReset: false });
  await reset(reg, { baseline: async () => {} });
  assert.equal(readFileSync(log, 'utf8').includes('truncate'), false);
});

test('truncate-logs defaults to on when the adapter has no config at all', async (t) => {
  restoreExt();
  restoreExt = __setForTest({ adapters: { docker: dockerAdapter, laravel: laravelAdapter }, providers: {}, hooks: {}, config: {} });
  const log = fakeDocker(t);
  await reset(reg, { baseline: async () => {} });
  assert.equal(readFileSync(log, 'utf8').includes('truncate'), true);
});

test('a registry without exec entries never reaches docker', async (t) => {
  const log = fakeDocker(t);
  await reset({ raw: {}, ...laravelAdapter.registry.accessors({}) }, { baseline: async () => {} });
  assert.equal(existsSync(log), false);
});

test('a container that cannot have its storage re-opened is Blocked, never a product KO', async (t) => {
  installFakeDocker(t, "echo 'Error response from daemon: No such container: app-web' >&2; exit 1");
  await assert.rejects(() => reset(reg, { baseline: async () => {} }),
    err => err instanceof Blocked && /storage perms normalization failed for api/.test(err.message));
});

test('a failing truncate is Blocked and names the service', async (t) => {
  installFakeDocker(t, 'case "$*" in *truncate*) echo boom >&2; exit 1;; esac');
  await assert.rejects(() => reset(reg, { baseline: async () => {} }),
    err => err instanceof Blocked && /log truncation failed for api/.test(err.message));
});
