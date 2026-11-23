// Every lever that reaches the container runtime has to type what it throws: an untyped throw is
// reported as a product bug. This file pins the docker adapter's side of that classification.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Ko, Blocked, Inconclusive } from '../errors.mjs';
import { dockerFailure } from '../docker.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import { logs, noLog, markLogSlice } from '../observe.mjs';
import { dbFault, stopFault } from '../fault.mjs';
import { __setForTest } from '../ext.mjs';

const FLAG = 'SCN_ALLOW_CONTAINER_FAULT';
let savedFlag;
let restoreExt;
const install = config => { restoreExt = __setForTest({ adapters: { docker: dockerAdapter }, providers: {}, config }); };
beforeEach(() => {
  savedFlag = process.env[FLAG];
  install({});
});
afterEach(() => {
  restoreExt();
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

const reg = {
  raw: { fault_containers: { 'app-queue': {} } },
  logSource: () => ({ kind: 'docker', container: 'app-web' }),
};

test('dockerFailure types a container that is gone as Blocked', () => {
  const err = dockerFailure(['exec', '-i', 'app-db', 'client'], 1, 'Error response from daemon: No such container: app-db\n');
  assert.ok(err instanceof Blocked);
  assert.match(err.message, /No such container/);
});

test('dockerFailure types a container that is stopped as Blocked', () => {
  assert.ok(dockerFailure(['exec', '-i', 'app-db', 'client'], 1, 'Error response from daemon: container 47e06c2096f2 is not running\n') instanceof Blocked);
});

test('dockerFailure types an unreachable daemon as Blocked', () => {
  assert.ok(dockerFailure(['exec', '-i', 'app-web', 'sh'], 1,
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?') instanceof Blocked);
});

test('dockerFailure leaves an error about the data untyped, so it still reaches KO', () => {
  const err = dockerFailure(['exec', '-i', 'app-db', 'client'], 1, "ERROR 1054 (42S22): Unknown column 'source' in 'field list'");
  assert.equal(err instanceof Blocked, false);
  assert.equal(err instanceof Inconclusive, false);
  assert.ok(err instanceof Error);
});

test('dockerFailure leaves an unrecognised non-zero exit untyped, so the KO default is not weakened', () => {
  const err = dockerFailure(['exec', '-i', 'app-web', 'sh', '-c', 'run-task'], 1, 'The upstream could not be reached');
  assert.equal(err instanceof Blocked, false);
});

test('a docker log read that fails is Blocked, never a product KO', async () => {
  markLogSlice();
  const runDocker = async () => { throw new Blocked('docker logs exited 1: No such container: app-web'); };
  await assert.rejects(() => logs(reg, 'web', { runDocker }), Blocked);
});

test('a log line that matches stays a Ko, so the Blocked typing did not widen', async () => {
  markLogSlice();
  const runDocker = async () => '2026-10-07T10:00:01Z ERROR boom\n';
  await assert.rejects(() => noLog(reg, 'web', /ERROR/, { runDocker }), err => err instanceof Ko);
});

test('every container fault refusal is Blocked: no opt-in, a container outside the registry, a shared container', async () => {
  const run = async () => { throw new Error('docker reached'); };
  delete process.env[FLAG];
  await assert.rejects(() => dbFault(reg, 'app-queue', { run }), Blocked);
  await assert.rejects(() => stopFault({ cleanups: [] }, reg, 'app-queue', { run }), Blocked);
  process.env[FLAG] = '1';
  await assert.rejects(() => dbFault(reg, 'unlisted-box', { run }), Blocked);
  await assert.rejects(() => stopFault({ cleanups: [] }, reg, 'unlisted-box', { run }), Blocked);
  restoreExt();
  install({ adapters: { docker: { sharedContainers: ['app-queue'] } } });
  await assert.rejects(() => dbFault(reg, 'app-queue', { run }), Blocked);
  await assert.rejects(() => stopFault({ cleanups: [] }, reg, 'app-queue', { run }), Blocked);
});

test('a container that is down when the fault is applied reaches Blocked through the runner', async () => {
  process.env[FLAG] = '1';
  const run = async (args) => { throw dockerFailure(args, 1, 'Error response from daemon: No such container: app-queue'); };
  await assert.rejects(() => dbFault(reg, 'app-queue', { run, unpauseSync() {} }), Blocked);
});
