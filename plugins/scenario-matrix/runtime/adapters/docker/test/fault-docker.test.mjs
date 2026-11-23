import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { dbFault, stopFault } from '../fault.mjs';
import { collectProbes } from '../selftest.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import { addReadyProbe, registeredReady, __resetReadyProbesForTest } from '../docker.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';

const { knownContainers } = dockerAdapter;

// Many tests below set SCN_ALLOW_CONTAINER_FAULT to reach the accepted path. Each one gets the
// variable back as it found it, so no test's approval leaks into the next test.
const FAULT_FLAG = 'SCN_ALLOW_CONTAINER_FAULT';
let savedFaultFlag;
let restoreExt;
const install = (config = {}, extra = {}) => {
  restoreExt = __setForTest({ adapters: { docker: dockerAdapter, ...extra }, providers: {}, hooks: {}, config });
};
beforeEach(() => {
  savedFaultFlag = process.env[FAULT_FLAG];
  install();
});
afterEach(() => {
  restoreExt();
  __resetReadyProbesForTest();
  if (savedFaultFlag === undefined) delete process.env[FAULT_FLAG];
  else process.env[FAULT_FLAG] = savedFaultFlag;
});

// A registry stub carrying only what the faults read: the containers named under fault_containers.
const REG = { raw: { fault_containers: { 'app-queue': {}, 'app-cache': { ready_via: 'cache-probe' } } } };

const never = what => async (args) => { throw new Error(`${what} must not reach docker (run(${JSON.stringify(args)}) called)`); };

test('dbFault refuses without the explicit opt-in env var', async () => {
  delete process.env[FAULT_FLAG];
  const unpauseSync = (c) => { throw new Error(`dbFault must not reach docker (unpauseSync(${c}) called)`); };
  await assert.rejects(() => dbFault(REG, 'app-queue', { run: never('dbFault'), unpauseSync }),
    err => err instanceof Blocked && err.message === 'dbFault() needs SCN_ALLOW_CONTAINER_FAULT=1 — container lifecycle requires explicit approval');
});

test('stopFault refuses without the explicit opt-in env var', async () => {
  delete process.env[FAULT_FLAG];
  await assert.rejects(() => stopFault({ cleanups: [] }, REG, 'app-queue', { run: never('stopFault') }),
    /stopFault\(\) needs SCN_ALLOW_CONTAINER_FAULT=1/);
});

test('the opt-in is the exact value 1', async () => {
  process.env[FAULT_FLAG] = 'true';
  await assert.rejects(() => dbFault(REG, 'app-queue', { run: never('dbFault') }), /SCN_ALLOW_CONTAINER_FAULT/);
});

// A crashed scenario script (a thrown error, or process.exit(), between dbFault() and restore())
// must not leave the container paused forever. process.exit() skips try/finally, so the safety net
// is a process 'exit' listener doing a SYNCHRONOUS unpause. These tests never touch the real docker
// binary: both the pause/unpause runner and the synchronous exit-time unpause are injected.
test('dbFault() registers a process exit safety net while paused, and restore() removes it', async () => {
  process.env[FAULT_FLAG] = '1';
  const calls = [];
  const run = async (args) => { calls.push(args); return ''; };
  const unpauseSync = () => {};
  const before = process.listenerCount('exit');
  let restore = null;
  try {
    ({ restore } = await dbFault(REG, 'app-queue', { run, unpauseSync }));
    assert.equal(process.listenerCount('exit'), before + 1, 'pausing must register exactly one exit listener');
    assert.deepEqual(calls, [['pause', 'app-queue']]);

    await restore();
    restore = null;
    assert.equal(process.listenerCount('exit'), before, 'restore() must remove the exit listener');
    assert.deepEqual(calls, [['pause', 'app-queue'], ['unpause', 'app-queue']]);
  } finally {
    if (restore) await restore();
  }
});

// If the unpause call rejects (flaky daemon, container removed out-of-band), restore() must NOT
// already have disarmed the exit safety net: it is the one thing left that can still recover the
// container. Order matters: unpause first, remove the listener second.
test("dbFault()'s restore() keeps the exit safety net armed when the unpause call itself rejects", async () => {
  process.env[FAULT_FLAG] = '1';
  const unpauseSync = () => {};
  const beforeListeners = new Set(process.listeners('exit'));
  const registeredByThisTest = () => process.listeners('exit').filter(l => !beforeListeners.has(l));
  try {
    const run = async (args) => {
      if (args[0] === 'pause') return '';
      throw new Error('docker unpause exited 1: cannot unpause a running container');
    };
    const { restore } = await dbFault(REG, 'app-queue', { run, unpauseSync });
    assert.equal(registeredByThisTest().length, 1, 'pausing must register exactly one exit listener');
    await assert.rejects(() => restore(), /cannot unpause a running container/);
    assert.equal(registeredByThisTest().length, 1, 'a failed unpause must leave the exit listener armed');
  } finally {
    for (const l of registeredByThisTest()) process.removeListener('exit', l);
  }
});

test("dbFault()'s exit safety net unpauses synchronously if the process exits before restore() runs", async () => {
  process.env[FAULT_FLAG] = '1';
  const unpauseSyncCalls = [];
  const unpauseSync = (container) => { unpauseSyncCalls.push(container); };
  const before = new Set(process.listeners('exit'));
  await dbFault(REG, 'app-queue', { run: async () => '', unpauseSync });
  const registered = process.listeners('exit').filter(l => !before.has(l));
  try {
    assert.equal(registered.length, 1, 'exactly one new exit listener from this dbFault() call');
    // An 'exit' handler cannot await, which is why this path is synchronous rather than routed through `run`.
    registered[0]();
    assert.deepEqual(unpauseSyncCalls, ['app-queue']);
  } finally {
    for (const l of registered) process.removeListener('exit', l);
  }
});

// Both signals whose DEFAULT disposition ends the process without running 'exit' handlers, which is
// what made the 'exit' net alone insufficient: SIGTERM is how a per-row timeout kills a hung child,
// and SIGINT is an operator's Ctrl-C. The same assertions run against each.
for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`dbFault() arms a ${signal} handler alongside the exit net, and restore() removes both`, async () => {
    process.env[FAULT_FLAG] = '1';
    const unpauseSyncCalls = [];
    const unpauseSync = (container) => { unpauseSyncCalls.push(container); };
    const reraised = [];
    // The re-raise is injected: process.kill(pid, signal) would take down the test runner's own subprocess.
    const reraiseSignal = (sig) => { reraised.push(sig); };
    const beforeExit = new Set(process.listeners('exit'));
    const beforeSignal = new Set(process.listeners(signal));
    let restore = null;
    try {
      ({ restore } = await dbFault(REG, 'app-queue', { run: async () => '', unpauseSync, reraiseSignal }));
      const armed = process.listeners(signal).filter(l => !beforeSignal.has(l));
      assert.equal(armed.length, 1, `pausing must register exactly one ${signal} listener`);

      // The handler must unpause synchronously, disarm itself (so the re-raise is not intercepted
      // by this same listener), and re-raise so the process still dies the way its killer asked.
      armed[0]();
      assert.deepEqual(unpauseSyncCalls, ['app-queue'], `the ${signal} handler must unpause synchronously`);
      assert.deepEqual(reraised, [signal], 'the handler must re-raise its OWN signal after unpausing');
      assert.equal(process.listeners(signal).includes(armed[0]), false, 'the handler must disarm itself before re-raising');
      process.on(signal, armed[0]); // re-arm, so restore() has both to remove

      await restore();
      restore = null;
      assert.equal(process.listeners(signal).filter(l => !beforeSignal.has(l)).length, 0, `restore() must remove the ${signal} listener`);
      assert.equal(process.listeners('exit').filter(l => !beforeExit.has(l)).length, 0, 'restore() must remove the exit listener');
    } finally {
      if (restore) await restore();
      for (const l of process.listeners(signal)) if (!beforeSignal.has(l)) process.removeListener(signal, l);
      for (const l of process.listeners('exit')) if (!beforeExit.has(l)) process.removeListener('exit', l);
    }
  });
}

// --- the perimeter: which containers a fault may touch ---

test('knownContainers is the union of every installed adapter\'s registry containers', () => {
  assert.deepEqual([...knownContainers(REG)].sort(), ['app-cache', 'app-queue']);
  assert.deepEqual([...knownContainers({ raw: {} })], []);
  assert.deepEqual([...knownContainers({})], []);
  restoreExt();
  install({}, {
    other: { registry: { containers: raw => Object.values(raw.stores ?? {}).map(s => s.container) } },
    bare: { registry: { keys: {} } },
  });
  const reg = { raw: { fault_containers: { 'app-queue': {} }, stores: { a: { container: 'app-store' } } } };
  assert.deepEqual([...knownContainers(reg)].sort(), ['app-queue', 'app-store']);
});

test('the docker registry contribution reports the keys of fault_containers', () => {
  assert.deepEqual(dockerAdapter.registry.containers({ fault_containers: { a: {}, b: {} } }), ['a', 'b']);
  assert.deepEqual(dockerAdapter.registry.containers({}), []);
});

test('fault_containers validation accepts a well-formed value and names the first problem', () => {
  const { validate } = dockerAdapter.registry.keys.fault_containers;
  assert.equal(validate({ 'app-queue': {}, 'app-cache': { ready_via: 'cache-probe' } }), null);
  assert.match(validate([]), /mapping/);
  assert.match(validate({ 'app-queue': 'x' }), /app-queue/);
  assert.match(validate({ 'app-queue': null }), /app-queue/);
  assert.match(validate({ 'app-queue': { ready_via: '' } }), /app-queue.*ready_via.*container name/);
  assert.match(validate({ 'app-queue': { ready_via: 7 } }), /app-queue.*ready_via/);
});

test('dbFault refuses a container the registry does not name, without reaching docker', async () => {
  process.env[FAULT_FLAG] = '1';
  const unpauseSync = (c) => { throw new Error(`dbFault must not reach docker (unpauseSync(${c}) called)`); };
  await assert.rejects(
    () => dbFault(REG, 'unlisted-box', { run: never('dbFault'), unpauseSync }),
    err => err instanceof Blocked && /refuses unlisted-box/.test(err.message) && /known: app-cache, app-queue/.test(err.message),
  );
  await assert.rejects(() => dbFault({ raw: {} }, 'unlisted-box', { run: never('dbFault') }), /known: none/);
});

// --- Containers shared by every service ---

test('the shared containers are read per call from the adapter config, and default to none', async () => {
  process.env[FAULT_FLAG] = '1';
  const calls = [];
  const run = async (args) => { calls.push(args); return ''; };
  const reg = { raw: { fault_containers: { 'app-web': {}, 'app-db': {}, 'app-queue': {} } } };
  // No sharedContainers configured: the registry is the only gate, so app-web is paused.
  const { restore } = await dbFault(reg, 'app-web', { run, unpauseSync() {} });
  await restore();
  assert.deepEqual(calls[0], ['pause', 'app-web']);

  restoreExt();
  install({ adapters: { docker: { sharedContainers: ['app-web', 'app-db'] } } });
  for (const c of ['app-web', 'app-db']) {
    await assert.rejects(() => dbFault(reg, c, { run: never('dbFault'), unpauseSync() {} }),
      e => e instanceof Blocked && /every service/.test(e.message));
    await assert.rejects(() => stopFault({ cleanups: [] }, reg, c, { run: never('stopFault'), startSync() {} }),
      e => e instanceof Blocked && /every service/.test(e.message));
  }
  // A container outside the shared list is unaffected.
  const again = await dbFault(reg, 'app-queue', { run, unpauseSync() {} });
  await again.restore();
});

test('the shared-container refusal is the original message and names schemaFreeze() and fault_containers', async () => {
  process.env[FAULT_FLAG] = '1';
  restoreExt();
  install({ adapters: { docker: { sharedContainers: ['app-web'] } } });
  await assert.rejects(() => dbFault({ raw: {} }, 'app-web', { run: never('dbFault') }), err => err instanceof Blocked
    && err.message === 'dbFault() refuses app-web: it is shared by every service, so pausing or stopping it would '
    + 'freeze or stop every service and every worker. Fault one service instead: schemaFreeze() locks a '
    + 'single schema, and infra.env_registry.fault_containers names a container that fronts one service only');
});

// --- stopFault ---

test('stopFault stops the container, registers the restore on ctx.cleanups, and restore() starts it and waits for a ready probe', async () => {
  process.env[FAULT_FLAG] = '1';
  const calls = [];
  const run = async (args) => { calls.push(args); return ''; };
  const probes = [];
  const readyProbe = async (container, runner, readyVia) => { probes.push({ container, readyVia, runner }); return true; };
  const ctx = { cleanups: [] };
  const before = process.listenerCount('exit');
  const { restore } = await stopFault(ctx, REG, 'app-cache', { run, startSync() {}, readyProbe });
  assert.deepEqual(calls, [['stop', 'app-cache']]);
  assert.equal(ctx.cleanups.length, 1);
  assert.equal(process.listenerCount('exit'), before + 1, 'the exit net is armed while the container is stopped');
  await restore();
  assert.deepEqual(calls, [['stop', 'app-cache'], ['start', 'app-cache']]);
  assert.deepEqual(probes.map(p => [p.container, p.readyVia]), [['app-cache', 'cache-probe']]);
  assert.equal(probes[0].runner, run, 'the probe runs through the same runner');
  assert.equal(process.listenerCount('exit'), before, 'a ready container disarms the net');
  await restore(); // idempotent: the second call is a no-op
  assert.equal(calls.length, 2);
});

const INSPECT = ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'];

test('a registered probe that claims the container decides readiness and receives ready_via', async () => {
  process.env[FAULT_FLAG] = '1';
  const calls = [];
  const run = async (args) => { calls.push(args); return ''; };
  const seen = [];
  addReadyProbe(async (container, runner, readyVia, reg) => { seen.push({ container, runner, readyVia, reg }); return true; });
  const { restore } = await stopFault({ cleanups: [] }, REG, 'app-cache', { run, startSync() {} });
  await restore();
  assert.deepEqual(seen.map(s => [s.container, s.readyVia]), [['app-cache', 'cache-probe']]);
  assert.equal(seen[0].runner, run);
  assert.equal(seen[0].reg, REG);
  assert.equal(calls.length, 2, 'the inspect check never runs when a probe claims the container');
});

test('a probe returning null falls through to the next one, then to the inspect check', async () => {
  process.env[FAULT_FLAG] = '1';
  const order = [];
  addReadyProbe(() => { order.push('first'); return null; });
  addReadyProbe(async () => { order.push('second'); return undefined; });
  const calls = [];
  const run = async (args) => { calls.push(args); return 'running\n'; };
  const { restore } = await stopFault({ cleanups: [] }, REG, 'app-cache', { run, startSync() {} });
  await restore();
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(calls[2], [...INSPECT, 'app-cache']);
});

test('the first non-null answer wins, in registration order, even when it is false', async () => {
  const order = [];
  addReadyProbe(() => { order.push('first'); return false; });
  addReadyProbe(() => { order.push('second'); return true; });
  assert.equal(await registeredReady('app-cache', async () => '', 'x', REG), false);
  assert.deepEqual(order, ['first']);
});

test('with no registered probe the inspect check runs even when ready_via is set', async () => {
  process.env[FAULT_FLAG] = '1';
  const calls = [];
  const run = async (args) => { calls.push(args); return args[0] === 'inspect' ? 'healthy' : ''; };
  const { restore } = await stopFault({ cleanups: [] }, REG, 'app-cache', { run, startSync() {} });
  await restore();
  assert.deepEqual(calls[2], [...INSPECT, 'app-cache']);
  assert.equal(calls.some(c => c[0] === 'exec'), false, 'ready_via is not run as a command');
});

test('without ready_via the default ready probe asks docker for the health, or the running state', async () => {
  process.env[FAULT_FLAG] = '1';
  const calls = [];
  const run = async (args) => { calls.push(args); return 'healthy\n'; };
  const { restore } = await stopFault({ cleanups: [] }, REG, 'app-queue', { run, startSync() {} });
  await restore();
  assert.deepEqual(calls[2], ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', 'app-queue']);
  assert.equal(calls.length, 3, 'a healthy answer ends the wait');
});

test('stopFault is Blocked when the container never answers, and keeps the exit net armed', async () => {
  process.env[FAULT_FLAG] = '1';
  const startCalls = [];
  const before = new Set(process.listeners('exit'));
  const { restore } = await stopFault({ cleanups: [] }, REG, 'app-queue', {
    run: async () => '', startSync: c => startCalls.push(c), readyProbe: async () => false, readyTimeoutMs: 20,
  });
  const armed = () => process.listeners('exit').filter(l => !before.has(l));
  try {
    await assert.rejects(() => restore(), err => err instanceof Blocked
      && /app-queue was restarted after this scenario's fault but never accepted a connection within 20ms/.test(err.message));
    assert.equal(armed().length, 1, 'the net stays armed, it is the only recovery left');
    armed()[0]();
    assert.deepEqual(startCalls, ['app-queue']);
  } finally {
    for (const l of armed()) process.removeListener('exit', l);
  }
});

test('a rejecting probe is not ready, and its last error is reported', async () => {
  process.env[FAULT_FLAG] = '1';
  const before = new Set(process.listeners('exit'));
  const { restore } = await stopFault({ cleanups: [] }, REG, 'app-queue', {
    run: async () => '', startSync() {}, readyProbe: async () => { throw new Error('probe exploded'); }, readyTimeoutMs: 20,
  });
  try {
    await assert.rejects(() => restore(), /last probe: probe exploded/);
  } finally {
    for (const l of process.listeners('exit')) if (!before.has(l)) process.removeListener('exit', l);
  }
});

test('stopFault arms a re-raising signal handler before the stop is issued', async () => {
  process.env[FAULT_FLAG] = '1';
  const reraised = [];
  const startCalls = [];
  const beforeSignal = new Set(process.listeners('SIGTERM'));
  const beforeExit = new Set(process.listeners('exit'));
  let armedDuringStop = 0;
  const run = async (args) => {
    if (args[0] === 'stop') armedDuringStop = process.listeners('SIGTERM').filter(l => !beforeSignal.has(l)).length;
    return '';
  };
  const { restore } = await stopFault({ cleanups: [] }, REG, 'app-queue', {
    run, startSync: c => startCalls.push(c), reraiseSignal: s => reraised.push(s), readyProbe: async () => true,
  });
  try {
    assert.equal(armedDuringStop, 1);
    process.listeners('SIGTERM').filter(l => !beforeSignal.has(l))[0]();
    assert.deepEqual(startCalls, ['app-queue']);
    assert.deepEqual(reraised, ['SIGTERM']);
  } finally {
    await restore();
    for (const l of process.listeners('SIGTERM')) if (!beforeSignal.has(l)) process.removeListener('SIGTERM', l);
    for (const l of process.listeners('exit')) if (!beforeExit.has(l)) process.removeListener('exit', l);
  }
});

// --- the dbFault selftest probes ---

const probe = (cfg, name) => collectProbes({}, cfg).find(p => p.name === name);
const OPT_IN_PROBE = 'dbFault: refuses without the explicit opt-in env var';
const PERIMETER_PROBE = 'dbFault: refuses a container the registry does not name';

test('the dbFault probes need no configuration', () => {
  for (const name of [OPT_IN_PROBE, PERIMETER_PROBE]) {
    const p = probe({}, name);
    assert.equal(p.owner, 'docker');
    assert.equal(p.missing, undefined);
  }
});

test('the opt-in probe passes with the flag unset and restores whatever the flag was', async () => {
  for (const before of [undefined, '1', 'no']) {
    if (before === undefined) delete process.env[FAULT_FLAG]; else process.env[FAULT_FLAG] = before;
    assert.equal(await probe({}, OPT_IN_PROBE).run(REG, {}), true);
    assert.equal(process.env[FAULT_FLAG], before);
  }
});

test('the registry probe passes without reaching docker and restores the flag', async () => {
  for (const before of [undefined, '1']) {
    if (before === undefined) delete process.env[FAULT_FLAG]; else process.env[FAULT_FLAG] = before;
    assert.equal(await probe({}, PERIMETER_PROBE).run(REG, {}), true);
    assert.equal(process.env[FAULT_FLAG], before);
  }
});

test('the dbFault probes fail when the refusal they check for is gone', async () => {
  restoreExt();
  restoreExt = __setForTest({
    adapters: { docker: { ...dockerAdapter, drivers: { ...dockerAdapter.drivers, dbFault: async () => ({ restore: async () => {} }) } } },
    providers: {}, hooks: {}, config: {},
  });
  assert.equal(await probe({}, OPT_IN_PROBE).run(REG, {}), false);
  assert.equal(await probe({}, PERIMETER_PROBE).run(REG, {}), false);
});
