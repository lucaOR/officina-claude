import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logs, noLog, captureLogs } from '../observe.mjs';
import { loadRegistryFromPath } from '../registry.mjs';
import { knownContainers } from '../adapter-docker.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as laravelAdapter from '../adapter-laravel.mjs';
import { logPathCommand } from '../adapter-laravel.mjs';
import { __setForTest } from '../ext.mjs';
import { Ko, Blocked } from '../errors.mjs';

let restoreExt;
const install = laravel => {
  restoreExt = __setForTest({
    adapters: { docker: dockerAdapter, laravel: laravelAdapter }, providers: {}, hooks: {},
    config: { adapters: { laravel } },
  });
};
beforeEach(() => install({ defaultWorkdir: '/var/www/html' }));
afterEach(() => restoreExt());

const SRC = { kind: 'laravel', container: 'app-web', workdir: '/srv/api' };
const reg = { logSource: () => SRC };

test('logPathCommand reads every daily log file, not one resolved from a clock', () => {
  const cmd = logPathCommand('/srv/api');
  assert.match(cmd, /laravel-\*\.log/);
  assert.match(cmd, /\/srv\/api\/storage\/logs/);
});

// Pinned to the exact command string on purpose: this is the one place the precise text IS the
// contract. It was wrong twice with a clock (the container shell's local date, then UTC), each
// right for some services and wrong for others, because services do not agree on the framework's
// own timezone. The glob has no clock to be wrong about.
test('logPathCommand does not consult any clock -- the exact command string', () => {
  assert.equal(logPathCommand('/srv/api'), 'cat /srv/api/storage/logs/laravel-*.log');
});

// reset truncates storage/logs/*.log to zero bytes, which is what makes an empty result from logs()
// a legitimate post-reset state. A masked read (`2>/dev/null || true`) could not tell that apart
// from a wrong workdir, which would make noLog() a guess instead of a real negative assert.
test('logPathCommand does not mask a missing file', () => {
  const cmd = logPathCommand('/srv/api');
  assert.equal(cmd.includes('2>/dev/null'), false);
  assert.equal(cmd.includes('|| true'), false);
});

test('the driver reads through `docker exec -i <container> sh -c <cat>` on the source container', async () => {
  let seen;
  const run = async args => { seen = args; return 'INFO a\n'; };
  assert.deepEqual(await logs(reg, 'api', { run }), ['INFO a']);
  assert.deepEqual(seen, ['exec', '-i', 'app-web', 'sh', '-c', 'cat /srv/api/storage/logs/laravel-*.log']);
});

// The container shell is POSIX sh with no nullglob: a glob that matches nothing is passed through
// literally, so `cat` fails "No such file or directory" exactly like a single missing file.
test('a glob that matches nothing is Blocked, through logs() and noLog() alike', async () => {
  const run = async () => {
    throw new Error("docker exec -i c sh -c cat ... exited 1: cat: '/srv/api/storage/logs/laravel-*.log': No such file or directory");
  };
  await assert.rejects(() => logs(reg, 'api', { run }), err => err instanceof Blocked && /no log file to read for api/.test(err.message));
  await assert.rejects(() => noLog(reg, 'api', /ERROR/, { run }), err => err instanceof Blocked);
});

test('a genuinely empty but PRESENT log file reads as no lines, the normal post-reset state', async () => {
  assert.deepEqual(await logs(reg, 'api', { run: async () => '' }), []);
});

test('a missing log file keeps its message and is typed Blocked, not a product KO', async () => {
  const run = async () => { throw new Error('exited 1: cat: /srv/api/storage/logs/laravel-2026-07-30.log: No such file or directory'); };
  await assert.rejects(() => logs(reg, 'api', { run }), /No such file or directory/);
  await assert.rejects(() => logs(reg, 'api', { run }), err => err instanceof Blocked);
});

test('a log line that MATCHES is still a Ko -- the missing-file typing did not widen', async () => {
  const dirty = async () => 'INFO fine\njob prune failed\n';
  await assert.rejects(() => noLog(reg, 'api', 'job prune failed', { run: dirty }), err => err instanceof Ko);
});

test('a log read that fails for another reason keeps its class', async () => {
  const run = async () => { throw new Error('exited 2: cat: /srv/api/storage/logs: Is a directory'); };
  await assert.rejects(() => logs(reg, 'api', { run }), err => !(err instanceof Blocked));
});

test('an already typed failure passes through untouched', async () => {
  const typed = new Blocked('docker is down: No such file or directory');
  const run = async () => { throw typed; };
  await assert.rejects(() => logs(reg, 'api', { run }), err => err === typed);
});

test('logs() filters lines by a grep pattern, string or RegExp', async () => {
  const run = async () => 'INFO all fine\nERROR something broke\nINFO still fine\n';
  assert.deepEqual(await logs(reg, 'api', { grep: 'ERROR', run }), ['ERROR something broke']);
  assert.deepEqual(await logs(reg, 'api', { grep: /error/i, run }), ['ERROR something broke']);
});

test('noLog() throws Ko on a match and resolves silently when none is found', async () => {
  await assert.rejects(() => noLog(reg, 'api', /ERROR/, { run: async () => 'a\nERROR boom\n' }), /expected no log line matching/);
  await assert.doesNotReject(() => noLog(reg, 'api', /ERROR/, { run: async () => 'a\nb\n' }));
});

test('captureLogs() writes <service>.log through the driver and skips an unreadable source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-caplogs-laravel-'));
  try {
    const multi = {
      logSourceNames: () => ['api', 'worker'],
      logSource: s => ({ ...SRC, container: s === 'api' ? 'app-web' : 'app-gone' }),
    };
    const run = async args => {
      if (args[2] === 'app-gone') throw new Error('exited 1: cat: x: No such file or directory');
      return 'php line\n';
    };
    const target = await captureLogs(multi, dir, { run });
    assert.equal(readFileSync(join(target, 'api.log'), 'utf8'), 'php line\n');
    assert.equal(existsSync(join(target, 'worker.log')), false);
    assert.match(readFileSync(join(target, '_sources.txt'), 'utf8'), /^worker\tskipped: .*no log file to read for worker/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the registry contribution ---

const registry = laravelAdapter.registry;

test('the exec key validates a mapping of service to a container with an optional workdir', () => {
  const { validate } = registry.keys.exec;
  assert.equal(validate({ api: { container: 'app-web' }, admin: { container: 'app-web', workdir: '/srv/admin' } }), null);
  assert.match(validate([]), /mapping/);
  assert.match(validate({ api: 'app-web' }), /api.*container/);
  assert.match(validate({ api: {} }), /api.*container/);
  assert.match(validate({ api: { container: '' } }), /api.*container/);
  assert.match(validate({ api: { container: 'app-web', workdir: 7 } }), /api\.workdir/);
});

test('execTarget defaults the workdir from the adapter config, filling {service}', () => {
  restoreExt();
  install({ defaultWorkdir: '/workspace/{service}' });
  const { execTarget } = registry.accessors({ exec: { api: { container: 'app-web' }, admin: { container: 'app-web', workdir: '/srv/admin' } } });
  assert.deepEqual(execTarget('api'), { container: 'app-web', workdir: '/workspace/api', service: 'api' });
  assert.deepEqual(execTarget('admin'), { container: 'app-web', workdir: '/srv/admin', service: 'admin' });
  assert.throws(() => execTarget('nope'), err => err instanceof Blocked && /unknown exec target: nope/.test(err.message));
});

test('logSources maps every exec entry to a laravel source and tolerates a registry without them', () => {
  assert.deepEqual(registry.logSources({ exec: { api: { container: 'app-web', workdir: '/srv/api' } } }),
    { api: { kind: 'laravel', container: 'app-web', workdir: '/srv/api', service: 'api' } });
  assert.deepEqual(registry.logSources({}), {});
});

test('containers names the exec containers, so the docker fault perimeter covers them', () => {
  assert.deepEqual(registry.containers({ exec: { api: { container: 'app-web' }, admin: { container: 'app-web' }, other: { container: 'app-x' } } }),
    ['app-web', 'app-web', 'app-x']);
  assert.deepEqual(registry.containers({}), []);
  assert.deepEqual([...knownContainers({ raw: { exec: { api: { container: 'app-web' } } } })], ['app-web']);
});

test('loadRegistryFromPath resolves the exec target and the log source through the registry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-laravel-reg-'));
  try {
    const path = join(dir, 'neutral.yaml');
    writeFileSync(path, 'epic: neutral\ninfra:\n  env_registry:\n    exec:\n      api: { container: app-web, workdir: /srv/api }\nscenarios: []\n');
    const reg = loadRegistryFromPath(path, 'neutral');
    assert.deepEqual(reg.execTarget('api'), { container: 'app-web', workdir: '/srv/api', service: 'api' });
    assert.equal(reg.logSource('api').kind, 'laravel');
    assert.deepEqual(reg.logSourceNames(), ['api']);
    assert.throws(() => reg.logSource('nope'), err => err instanceof Blocked && /unknown log source: nope .*exec maps a service/.test(err.message));
    writeFileSync(path, 'epic: neutral\ninfra:\n  env_registry:\n    exec:\n      api: app-web\nscenarios: []\n');
    assert.throws(() => loadRegistryFromPath(path, 'neutral'), err => err instanceof Blocked && /infra\.env_registry\.exec/.test(err.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the adapter declares fatal log patterns and a verify command', () => {
  assert.deepEqual(laravelAdapter.fatalLogPatterns, ['Allowed memory size', 'PHP Fatal']);
  assert.equal(laravelAdapter.verify.command,
    "docker exec -w {workdir} {container} php artisan list --raw | grep -q '^{command} '");
});

test('the drivers export names exactly what adapter.json declares', () => {
  assert.deepEqual(Object.keys(laravelAdapter.drivers), ['logSource.laravel']);
});
