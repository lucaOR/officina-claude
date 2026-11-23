import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logs, noLog, captureLogs, markLogSlice } from '../observe.mjs';
import { loadRegistryFromPath } from '../registry.mjs';
import { collectProbes } from '../selftest.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import { __setForTest } from '../ext.mjs';
import { Ko, Blocked, Inconclusive } from '../errors.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: { docker: dockerAdapter }, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

const dockerReg = { logSource: () => ({ kind: 'docker', container: 'app-web' }) };

// Node runs the tests of one file in order, and the slice mark is process state that nothing resets:
// this must stay the first test, before any markLogSlice() call in this file.
test('a docker log source with no slice mark is Inconclusive, never a whole-history read', async () => {
  let called = false;
  const runDocker = async () => { called = true; return 'line'; };
  await assert.rejects(() => logs(dockerReg, 'web', { runDocker }), err => err instanceof Inconclusive);
  await assert.rejects(() => noLog(dockerReg, 'web', /x/, { runDocker }), err => err instanceof Inconclusive);
  assert.match(
    await logs(dockerReg, 'web', { runDocker }).catch(e => e.message),
    /logs\(web\) has no slice start: a stdout log source is sliced by time, and only scenario\(\) marks when the current attempt began/,
  );
  assert.equal(called, false);
});

test('a docker log source reads `docker logs -t --since <mark>` on the named container', async () => {
  const mark = markLogSlice(Date.parse('2026-10-07T10:00:05.000Z'));
  // The 1s margin pulls the mark back, so the daemon clock never drops the
  // attempt's first lines (which would make noLog() pass vacuously).
  assert.equal(mark, '2026-10-07T10:00:04.000Z');
  let seen;
  const runDocker = async args => { seen = args; return ''; };
  await logs(dockerReg, 'web', { runDocker });
  assert.deepEqual(seen, ['logs', '-t', '--since', mark, 'app-web']);
});

test('a docker log source strips ANSI colour and merges stdout and stderr in timestamp order', async () => {
  markLogSlice();
  const runDocker = async () => '2026-10-07T10:00:02Z \x1b[36mWARN\x1b[m late\n\n2026-10-07T10:00:01Z ERROR early\n';
  const lines = await logs(dockerReg, 'web', { runDocker });
  assert.deepEqual(lines, ['2026-10-07T10:00:01Z ERROR early', '2026-10-07T10:00:02Z WARN late']);
  await assert.rejects(() => noLog(dockerReg, 'web', /WARN late/, { runDocker }), err => err instanceof Ko);
  await assert.doesNotReject(() => noLog(dockerReg, 'web', /absent/, { runDocker }));
});

test('the driver ignores opts.grep, the core filters', async () => {
  markLogSlice();
  const runDocker = async () => '2026-10-07T10:00:01Z alpha\n2026-10-07T10:00:02Z beta\n';
  const read = await dockerAdapter.drivers['logSource.docker'].read(dockerReg, dockerReg.logSource(), { runDocker, grep: 'alpha' });
  assert.equal(read.split('\n').length, 2);
  assert.deepEqual(await logs(dockerReg, 'web', { runDocker, grep: 'alpha' }), ['2026-10-07T10:00:01Z alpha']);
});

test('the default reader merges what `docker logs` writes to stdout and to stderr', async (t) => {
  markLogSlice();
  installFakeDocker(t, 'echo "2026-10-07T10:00:03Z from stdout"; echo "2026-10-07T10:00:01Z from stderr" >&2');
  assert.deepEqual(await logs(dockerReg, 'web'), ['2026-10-07T10:00:01Z from stderr', '2026-10-07T10:00:03Z from stdout']);
});

test('the default reader is Blocked when docker logs fails or cannot start', async (t) => {
  markLogSlice();
  installFakeDocker(t, 'echo "Error: No such container: app-web" >&2; exit 1');
  await assert.rejects(() => logs(dockerReg, 'web'), err => err instanceof Blocked && /exited 1: Error: No such container/.test(err.message));
});

test('captureLogs() writes one file per source plus _sources.txt, skipping an unreadable source', async () => {
  markLogSlice();
  const reg = {
    logSourceNames: () => ['web', 'worker', 'worker-2'],
    logSource: s => ({ kind: 'docker', container: { web: 'app-web', worker: 'app-worker', 'worker-2': 'app-worker-2' }[s] }),
  };
  const runDocker = async args => {
    if (args.at(-1) === 'app-worker-2') throw new Blocked('docker logs exited 1: No such container: app-worker-2');
    return args.at(-1) === 'app-web' ? '2026-10-07T10:00:01Z web line\n' : '';
  };
  const dir = mkdtempSync(join(tmpdir(), 'scn-caplogs-'));
  try {
    const target = await captureLogs(reg, dir, { runDocker });
    assert.equal(target, join(dir, 'logs'));
    assert.equal(readFileSync(join(target, 'web.log'), 'utf8'), '2026-10-07T10:00:01Z web line\n');
    assert.equal(readFileSync(join(target, 'worker.log'), 'utf8'), '');
    assert.equal(existsSync(join(target, 'worker-2.log')), false);
    const index = readFileSync(join(target, '_sources.txt'), 'utf8');
    assert.match(index, /^web\t1 line/m);
    assert.match(index, /^worker\t0 line/m);
    assert.match(index, /^worker-2\tskipped: .*No such container/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the registry contribution ---

const registry = dockerAdapter.registry;

test('logSources maps log_sources to docker sources and tolerates a registry without them', () => {
  assert.deepEqual(registry.logSources({ log_sources: { web: { container: 'app-web' }, worker: { container: 'app-worker' } } }),
    { web: { kind: 'docker', container: 'app-web' }, worker: { kind: 'docker', container: 'app-worker' } });
  assert.deepEqual(registry.logSources({}), {});
});

test('log_sources validation names the first problem and accepts a well-formed value', () => {
  const { validate } = registry.keys.log_sources;
  assert.equal(validate({ web: { container: 'app-web' } }), null);
  assert.match(validate([]), /mapping/);
  assert.match(validate('app-web'), /mapping/);
  assert.match(validate({ web: 'app-web' }), /web.*container/);
  assert.match(validate({ web: { container: '' } }), /web.*container/);
  assert.match(validate({ web: {} }), /web.*container/);
});

test('loadRegistryFromPath resolves a docker log source and lists it through the registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-docker-reg-'));
  try {
    const path = join(dir, 'neutral.yaml');
    writeFileSync(path, 'epic: neutral\ninfra:\n  env_registry:\n    log_sources:\n      web: { container: app-web }\nscenarios: []\n');
    const reg = loadRegistryFromPath(path, 'neutral');
    assert.deepEqual(reg.logSource('web'), { kind: 'docker', container: 'app-web' });
    assert.deepEqual(reg.logSourceNames(), ['web']);
    assert.throws(() => reg.logSource('nope'), err => err instanceof Blocked && /unknown log source: nope \(log_sources maps a service to a docker container/.test(err.message));
    writeFileSync(path, 'epic: neutral\ninfra:\n  env_registry:\n    log_sources:\n      web: app-web\nscenarios: []\n');
    assert.throws(() => loadRegistryFromPath(path, 'neutral'), err => err instanceof Blocked && /infra\.env_registry\.log_sources/.test(err.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the log selftest probe ---

const LOG_PROBE = 'docker logs: reads the configured source as lines';

test('the log probe needs a configured source and is skipped without one', () => {
  const probe = collectProbes({}, { adapters: { docker: { selftest: { logSource: null } } } }).find(p => p.name === LOG_PROBE);
  assert.equal(probe.owner, 'docker');
  assert.equal(probe.missing, 'adapters.docker.selftest.logSource');
  const configured = collectProbes({}, { adapters: { docker: { selftest: { logSource: 'web' } } } }).find(p => p.name === LOG_PROBE);
  assert.equal(configured.missing, undefined);
});

test('the log probe marks the slice, reads the configured source and passes on an array', async (t) => {
  installFakeDocker(t, 'echo "2026-10-07T10:00:01Z hello"');
  const cfg = { adapters: { docker: { selftest: { logSource: 'web' } } } };
  const probe = collectProbes({}, cfg).find(p => p.name === LOG_PROBE);
  assert.equal(await probe.run(dockerReg, cfg), true);
});

test('the log probe fails when the source cannot be read', async (t) => {
  installFakeDocker(t, 'echo "Error: No such container" >&2; exit 1');
  const cfg = { adapters: { docker: { selftest: { logSource: 'web' } } } };
  const probe = collectProbes({}, cfg).find(p => p.name === LOG_PROBE);
  await assert.rejects(() => probe.run(dockerReg, cfg), Blocked);
});
