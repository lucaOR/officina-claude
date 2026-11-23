// The write-target guard is the only thing standing between a compiled scenario and an artisan
// command writing to the developer's real database, so its decision is asserted here without a
// container. Nothing in this file runs docker or php.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  artisan, assertPrefixedTargets, extraQueueWorker, laravelExec, odsFromCsv, parseWriteTargets,
  queueWorkerFault, tinker, tinkerScript, workbook, workbookScript, SCN_GUARD_MARKER,
} from '../php.mjs';
import { Blocked } from '../errors.mjs';
import { __setForTest } from '../ext.mjs';

const T = { container: 'app-web', workdir: '/srv/api', service: 'api' };
const WRAPPER = ['/opt/svc-env.sh', '{service}'];

function fakeRegistry() {
  return { execTarget: () => T };
}

let restoreExt;
function install({ hooks = {}, laravel = {}, config = {} } = {}) {
  restoreExt?.();
  restoreExt = __setForTest({
    adapters: {}, providers: {}, hooks,
    config: { ...config, adapters: { laravel: { execWrapper: [], workerUser: null, ...laravel } } },
  });
}
beforeEach(() => install());
afterEach(() => restoreExt());

// Records both sides of an artisan() call so a test can compare what the guard was asked about
// against what actually reached the container. The probe answers the way the container does:
// from `target`, whatever the script asked.
function recorder({ target = 'scn_app' } = {}) {
  const seen = { probedScript: null, executed: null, probes: 0 };
  return {
    seen,
    opts: {
      probe: async (_reg, _service, script) => {
        seen.probes += 1;
        seen.probedScript = script;
        return `SCN_WRITE_TARGETS=${JSON.stringify(target === null ? [] : [target])}`;
      },
      run: async args => { seen.executed = args; return 'ok'; },
    },
  };
}

const executedCommand = seen => seen.executed?.at(-1) ?? '';

// --- laravelExec ------------------------------------------------------------

test('laravelExec builds the docker exec argv with no wrapper by default', () => {
  assert.deepEqual(laravelExec(T, 'echo hi'), ['exec', '-w', '/srv/api', 'app-web', 'sh', '-c', 'echo hi']);
});

test('laravelExec puts every flag in its place and fills {service} in the wrapper', () => {
  install({ laravel: { execWrapper: WRAPPER } });
  assert.deepEqual(
    laravelExec(T, 'run', { detach: true, stdin: true, user: 'worker', xdebugOff: true }),
    ['exec', '-d', '-i', '-u', 'worker', '-e', 'XDEBUG_MODE=off', '-w', '/srv/api', 'app-web',
      '/opt/svc-env.sh', 'api', 'sh', '-c', 'run'],
  );
});

// --- the connection guard ---------------------------------------------------

test('tinkerScript wraps the body and prepends nothing else by default', () => {
  const plain = tinkerScript('echo 1;');
  assert.match(plain, /^<\?php/);
  assert.match(plain, /echo 1;/);
  assert.equal(plain.includes('__scnPreamble'), false);
});

test('every tinker body is wrapped in the connection guard', () => {
  const plain = tinkerScript('echo 1;');
  assert.match(plain, /beforeExecuting\(\$__scnGuard\)/);
  assert.match(plain, /ConnectionEstablished/);
  assert.match(plain, /strpos\(\$__scnDb, 'scn_'\) !== 0/);
  assert.match(plain, /foreach \(app\('db'\)->getConnections\(\) as \$__scnExisting\)/);
  assert.match(plain, /Event::listen/);
});

test('the guard asserts the configured prefix, not a fixed one', () => {
  install({ config: { dbPrefix: "it's_" } });
  assert.match(tinkerScript('echo 1;'), /strpos\(\$__scnDb, 'it\\'s_'\) !== 0/);
});

test('the guard FAILS CLOSED if the framework has no hook to arm it with', () => {
  const plain = tinkerScript('echo 1;');
  assert.match(plain, /class_exists\(\\Illuminate\\Database\\Events\\ConnectionEstablished::class\)/);
  assert.match(plain, /method_exists\(\\Illuminate\\Database\\Connection::class, 'beforeExecuting'\)/);
  assert.match(plain, new RegExp(`${SCN_GUARD_MARKER}: this framework build has no beforeExecuting`));
  const refusal = plain.slice(plain.indexOf('class_exists'), plain.indexOf("foreach (app('db')"));
  assert.match(refusal, /exit\(1\);/);
});

test('the guard refuses with the marker tinker() classifies on', () => {
  assert.match(tinkerScript('echo 1;'), new RegExp(SCN_GUARD_MARKER));
});

test('the preamble hook is prepended to tinker, after the guard and before the body', () => {
  let received;
  install({ hooks: { laravel: { preamble: args => { received = args; return '// PREAMBLE-MARK\n'; } } } });
  const reg = fakeRegistry();
  const script = tinkerScript('echo 1;', { service: 'api', tenant: 'acme', reg });
  assert.deepEqual(received, { service: 'api', tenant: 'acme', reg, opts: {} });
  const guardAt = script.indexOf('beforeExecuting($__scnGuard)');
  const preambleAt = script.indexOf('// PREAMBLE-MARK');
  const bodyAt = script.indexOf('echo 1;');
  assert.ok(guardAt > 0 && guardAt < preambleAt, 'the guard must be armed before the preamble runs');
  assert.ok(preambleAt < bodyAt, 'the preamble must precede the body');
});

test('tinker hands the preamble hook its service, its tenant and the registry', async () => {
  let received;
  install({
    hooks: { laravel: { preamble: args => { received = args; return ''; } } },
    config: { tenantKey: 'tenant' },
  });
  const reg = fakeRegistry();
  await tinker(reg, 'api', 'echo 1;', { tenant: 'acme', run: async () => '' });
  assert.deepEqual(received, { service: 'api', tenant: 'acme', reg, opts: { tenant: 'acme' } });
});

test('tinker hands the preamble hook its other options, without the run seam', async () => {
  let received;
  install({ hooks: { laravel: { preamble: args => { received = args; return ''; } } } });
  const run = async () => '';
  await tinker(fakeRegistry(), 'api', 'echo 1;', { selectBy: 'host.test', run });
  assert.deepEqual(received.opts, { selectBy: 'host.test' });
});

test('workbook and odsFromCsv pass their options through to the preamble hook', async () => {
  const seen = [];
  install({ hooks: { laravel: { preamble: ({ opts }) => { seen.push(opts.selectBy); return ''; } } } });
  const zip = Buffer.from('PK\x03\x04rest').toString('base64');
  const run = async args => (args.at(-1).includes('artisan tinker') ? `---scn-ods-begin---${zip}---scn-ods-end---` : '');
  await workbook(fakeRegistry(), 'api', [{ name: 'S', rows: [['a']] }], { selectBy: 'wb.test', run });
  await odsFromCsv(fakeRegistry(), 'api', 'a,b', { selectBy: 'ods.test', run });
  assert.deepEqual(seen, ['wb.test', 'ods.test']);
});

// --- assertPrefixedTargets --------------------------------------------------

test('assertPrefixedTargets refuses a target outside the prefix', () => {
  assert.throws(
    () => assertPrefixedTargets('api', ['local_main']),
    err => err instanceof Blocked && /refusing artisan on api/.test(err.message) && /local_main/.test(err.message),
  );
});

test('assertPrefixedTargets refuses when ANY target is outside, not only the first', () => {
  assert.throws(
    () => assertPrefixedTargets('api', ['scn_app', 'local_other']),
    err => err instanceof Blocked && /local_other/.test(err.message) && !/scn_app,/.test(err.message),
  );
});

test('assertPrefixedTargets passes an all-prefixed list and an empty one', () => {
  assert.deepEqual(assertPrefixedTargets('api', ['scn_app', 'scn_other']), ['scn_app', 'scn_other']);
  assert.deepEqual(assertPrefixedTargets('api', []), []);
});

test('assertPrefixedTargets follows the configured prefix', () => {
  install({ config: { dbPrefix: 'rehearsal_' } });
  assert.deepEqual(assertPrefixedTargets('api', ['rehearsal_a']), ['rehearsal_a']);
  assert.throws(() => assertPrefixedTargets('api', ['scn_a']), err => err instanceof Blocked);
});

test('parseWriteTargets reads the marker and rejects output that carries none', () => {
  assert.deepEqual(parseWriteTargets('noise\nSCN_WRITE_TARGETS=["scn_app"]\n'), ['scn_app']);
  assert.deepEqual(parseWriteTargets('SCN_WRITE_TARGETS=[]'), []);
  assert.throws(() => parseWriteTargets('PHP Fatal error'), err => err instanceof Blocked);
});

// --- artisan ----------------------------------------------------------------

test('artisan refuses when the targets cannot be determined, before running anything', async () => {
  const rec = recorder({ target: null });
  await assert.rejects(
    () => artisan(fakeRegistry(), 'api', ['app:prune'], rec.opts),
    err => err instanceof Blocked && /could not be determined/.test(err.message),
  );
  assert.equal(rec.seen.probes, 1, 'the probe ran');
  assert.equal(rec.seen.executed, null, 'the command must NOT have reached the container');
});

test('artisan refuses a default connection outside the prefix, before running anything', async () => {
  const rec = recorder({ target: 'local_main' });
  await assert.rejects(
    () => artisan(fakeRegistry(), 'api', ['app:prune'], rec.opts),
    err => err instanceof Blocked && /local_main/.test(err.message),
  );
  assert.equal(rec.seen.executed, null);
});

test('without a hook the default probe reads the connection default database through tinker', async () => {
  const rec = recorder();
  await artisan(fakeRegistry(), 'api', ['app:prune'], rec.opts);
  assert.match(rec.seen.probedScript, /getDatabaseName\(\)/);
  assert.match(rec.seen.probedScript, /SCN_WRITE_TARGETS=/);
});

test('a write target without the prefix is refused even when the hook names it', async () => {
  let asked;
  install({ hooks: { laravel: { writeTargets: async args => { asked = args; return ['local_main']; } } } });
  const rec = recorder();
  await assert.rejects(
    () => artisan(fakeRegistry(), 'api', ['app:prune', 'x'], rec.opts),
    err => err instanceof Blocked && /local_main/.test(err.message),
  );
  assert.equal(rec.seen.executed, null, 'the command must NOT have reached the container');
  assert.equal(rec.seen.probes, 0, 'the hook replaces the default probe');
  assert.deepEqual(asked.args, ['app:prune', 'x']);
  assert.equal(asked.service, 'api');
});

test('a hook that names only prefixed targets lets the command through', async () => {
  install({ hooks: { laravel: { writeTargets: async () => ['scn_a', 'scn_b'] } } });
  const rec = recorder();
  assert.equal(await artisan(fakeRegistry(), 'api', ['app:prune'], rec.opts), 'ok');
  assert.ok(rec.seen.executed);
});

test('a hook that names no target is refused: an empty list is never "touches nothing"', async () => {
  install({ hooks: { laravel: { writeTargets: async () => [] } } });
  const rec = recorder();
  await assert.rejects(
    () => artisan(fakeRegistry(), 'api', ['app:prune'], rec.opts),
    err => err instanceof Blocked && /could not be determined/.test(err.message),
  );
  assert.equal(rec.seen.executed, null);
});

test('a hook that returns something that is not a list of names is refused', async () => {
  install({ hooks: { laravel: { writeTargets: async () => 'scn_a' } } });
  const rec = recorder();
  await assert.rejects(() => artisan(fakeRegistry(), 'api', ['x'], rec.opts), err => err instanceof Blocked && /laravel\.writeTargets/.test(err.message));
});

test('the hook receives the tenant, and the tenant is not interpreted', async () => {
  let asked;
  install({
    hooks: { laravel: { writeTargets: async args => { asked = args; return ['scn_a']; } } },
    config: { tenantKey: 'tenant' },
  });
  await artisan(fakeRegistry(), 'api', ['x'], { ...recorder().opts, tenant: 'acme' });
  assert.equal(asked.tenant, 'acme');
  assert.equal(asked.reg !== undefined, true);
});

test('the executed command line is the one that was verified', async () => {
  install({ laravel: { execWrapper: WRAPPER } });
  const rec = recorder();
  await artisan(fakeRegistry(), 'api', ['app:prune', 'acme'], rec.opts);
  assert.equal(rec.seen.executed.at(-5), '/opt/svc-env.sh', 'the PHP exec goes through the wrapper');
  assert.equal(executedCommand(rec.seen), "umask 002 && cd /srv/api && 'php' 'artisan' 'app:prune' 'acme'");
});

test('artisan has no option that could name a target the command line does not carry', async () => {
  const rec = recorder({ target: null });
  await assert.rejects(
    () => artisan(fakeRegistry(), 'api', ['app:prune'], { ...rec.opts, target: 'scn_app', targets: ['scn_app'] }),
    err => err instanceof Blocked && /could not be determined/.test(err.message),
  );
  assert.equal(rec.seen.executed, null);
});

test('touchesNoDatabase is the only way past the probe, and it skips it entirely', async () => {
  const rec = recorder();
  const out = await artisan(fakeRegistry(), 'api', ['--version'], { ...rec.opts, touchesNoDatabase: true });
  assert.equal(out, 'ok');
  assert.equal(rec.seen.probes, 0);
  assert.equal(executedCommand(rec.seen), "umask 002 && cd /srv/api && 'php' 'artisan' '--version'");
});

test('the writeTargets hook receives the call options and a probe that runs through tinker', async () => {
  let asked;
  install({
    hooks: {
      laravel: {
        writeTargets: async args => {
          asked = args;
          const out = await args.probe('echo "SCN_HOOK_PROBE";');
          return [out.includes('probed') ? 'scn_a' : 'none'];
        },
      },
    },
  });
  const seen = [];
  const opts = {
    probe: async (_reg, service, script, probeOpts) => { seen.push({ service, script, probeOpts }); return 'probed'; },
    run: async () => 'ok',
    selectBy: 'host.test',
  };
  assert.equal(await artisan(fakeRegistry(), 'api', ['app:prune'], opts), 'ok');
  assert.deepEqual(asked.opts, { selectBy: 'host.test' });
  assert.deepEqual(seen, [{ service: 'api', script: 'echo "SCN_HOOK_PROBE";', probeOpts: { selectBy: 'host.test' } }]);
});

test('a hook that throws Blocked refuses with its own reason, before running anything', async () => {
  install({ hooks: { laravel: { writeTargets: async () => { throw new Blocked('project refusal'); } } } });
  const rec = recorder();
  await assert.rejects(() => artisan(fakeRegistry(), 'api', ['app:prune'], rec.opts), err => err instanceof Blocked && /project refusal/.test(err.message));
  assert.equal(rec.seen.executed, null);
});

test('an option named in noDatabaseOptions makes the same claim as touchesNoDatabase', async () => {
  let called = false;
  install({
    hooks: { laravel: { writeTargets: async () => { called = true; return []; } } },
    laravel: { noDatabaseOptions: ['bindsNothing'] },
  });
  const rec = recorder();
  assert.equal(await artisan(fakeRegistry(), 'api', ['--version'], { ...rec.opts, bindsNothing: true }), 'ok');
  assert.equal(called, false);
  assert.equal(rec.seen.probes, 0);
});

test('an option is no claim unless noDatabaseOptions names it and its value is true', async () => {
  install({ laravel: { noDatabaseOptions: ['bindsNothing'] } });
  for (const opts of [{ otherName: true }, { bindsNothing: 'yes' }, { bindsNothing: 1 }]) {
    const rec = recorder({ target: null });
    await assert.rejects(
      () => artisan(fakeRegistry(), 'api', ['app:prune'], { ...rec.opts, ...opts }),
      err => err instanceof Blocked && /could not be determined/.test(err.message),
      JSON.stringify(opts),
    );
    assert.equal(rec.seen.executed, null);
  }
});

test('a no-database claim with a conflicting option is refused, naming the spelling the call used', async () => {
  install({ laravel: { noDatabaseOptions: ['bindsNothing'], noDatabaseConflicts: ['bindsEverything'] } });
  for (const claim of ['touchesNoDatabase', 'bindsNothing']) {
    const rec = recorder();
    await assert.rejects(
      () => artisan(fakeRegistry(), 'api', ['schedule:run'], { ...rec.opts, [claim]: true, bindsEverything: true }),
      err => err instanceof Blocked && err.message === `refusing artisan on api: [schedule:run] declares both ${claim} and bindsEverything, `
        + 'which contradict each other. Read the command and pick one.',
      claim,
    );
    assert.equal(rec.seen.probes, 0, `${claim}: nothing may be probed`);
    assert.equal(rec.seen.executed, null, `${claim}: nothing may run`);
  }
});

test('a conflicting option set to false, or absent, leaves the no-database claim alone', async () => {
  install({ laravel: { noDatabaseConflicts: ['bindsEverything'] } });
  for (const extra of [{ bindsEverything: false }, {}]) {
    const rec = recorder();
    assert.equal(await artisan(fakeRegistry(), 'api', ['--version'], { ...rec.opts, touchesNoDatabase: true, ...extra }), 'ok');
    assert.equal(rec.seen.probes, 0);
  }
});

test('a conflicting option without a no-database claim goes through the write-target check', async () => {
  let asked;
  install({
    hooks: { laravel: { writeTargets: async args => { asked = args; return ['scn_a']; } } },
    laravel: { noDatabaseConflicts: ['bindsEverything'] },
  });
  const rec = recorder();
  assert.equal(await artisan(fakeRegistry(), 'api', ['schedule:run'], { ...rec.opts, bindsEverything: true }), 'ok');
  assert.equal(asked.opts.bindsEverything, true);
});

test('touchesNoDatabase does not consult the hook either', async () => {
  let called = false;
  install({ hooks: { laravel: { writeTargets: async () => { called = true; return []; } } } });
  await artisan(fakeRegistry(), 'api', ['--version'], { ...recorder().opts, touchesNoDatabase: true });
  assert.equal(called, false);
});

test('artisan escapes a single quote in an argument', async () => {
  const rec = recorder();
  await artisan(fakeRegistry(), 'api', ["it's"], { ...rec.opts, touchesNoDatabase: true });
  assert.ok(executedCommand(rec.seen).endsWith(`'it'\\''s'`));
});

// --- workbook and odsFromCsv ------------------------------------------------

test('workbookScript carries every sheet name and cell through its base64 spec', () => {
  const sheets = [
    { name: 'First', rows: [['id', 'pin'], ['31001', '007123']] },
    { name: 'Second', rows: [['id', 'floor'], ['31002', null]] },
  ];
  const script = workbookScript(sheets, 'xlsx');
  const spec = JSON.parse(Buffer.from(/base64_decode\('([^']+)'\)/.exec(script)[1], 'base64').toString('utf8'));
  assert.deepEqual(spec, sheets);
  assert.match(script, /Writer\\Xlsx\(/);
  assert.match(script, /TYPE_STRING/);
  assert.match(workbookScript(sheets, 'ods'), /Writer\\Ods\(/);
});

test('workbookScript refuses an unknown format and an empty sheet list', () => {
  assert.throws(() => workbookScript([{ name: 'a', rows: [] }], 'csv'), /unsupported format/);
  assert.throws(() => workbookScript([], 'xlsx'), /at least one sheet/);
});

test('workbook returns the fenced ZIP bytes and blocks on anything that is not a ZIP', async () => {
  const zip = Buffer.from('PK\x03\x04rest');
  const fenced = payload => async args => (String(args.at(-1)).includes('artisan tinker')
    ? `noise---scn-ods-begin---${payload}---scn-ods-end---noise` : '');
  const sheets = [{ name: 'Sheet1', rows: [['id']] }];
  const bytes = await workbook(fakeRegistry(), 'api', sheets, { run: fenced(zip.toString('base64')) });
  assert.deepEqual(bytes, zip);
  await assert.rejects(
    workbook(fakeRegistry(), 'api', sheets, { run: fenced(Buffer.from('nope').toString('base64')) }),
    err => err instanceof Blocked && /not a ZIP container/.test(err.message),
  );
  await assert.rejects(
    workbook(fakeRegistry(), 'api', sheets, { run: async () => 'nothing' }),
    err => err instanceof Blocked && /produced no \.xlsx fixture/.test(err.message),
  );
});

test('odsFromCsv sends the csv through tinker and returns the fenced bytes', async () => {
  const zip = Buffer.from('PK\x03\x04ods');
  let script = '';
  const run = async (args, stdin) => {
    if (stdin !== undefined) script = stdin;
    return String(args.at(-1)).includes('artisan tinker')
      ? `---scn-ods-begin---${zip.toString('base64')}---scn-ods-end---` : '';
  };
  assert.deepEqual(await odsFromCsv(fakeRegistry(), 'api', 'a,b\n1,2\n', { run }), zip);
  assert.ok(script.includes(Buffer.from('a,b\n1,2\n').toString('base64')));
});

// --- extraQueueWorker -------------------------------------------------------
//
// A second worker for the length of one scenario. The two things that can go wrong are both
// silent: a second worker that is never stopped makes every LATER row run against two workers, and
// a stop that kills the wrong process leaves the stack with none. So the tests pin that exactly the
// added process is killed, that the stack is checked to hold exactly the one worker before and
// after, and that nothing runs without the approval flag.

const WORKER_FLAG = 'SCN_ALLOW_CONTAINER_FAULT';

async function withContainerFaultFlag(value, fn) {
  const before = process.env[WORKER_FLAG];
  if (value === undefined) delete process.env[WORKER_FLAG]; else process.env[WORKER_FLAG] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[WORKER_FLAG]; else process.env[WORKER_FLAG] = before;
  }
}

// A fake container that answers the three shapes of command the lever sends: the pgrep listing,
// the detached start, and kill / kill -9.
function fakeWorkerContainer({ standing = [101], spawns = [202], survivesTerm = false, immortal = false } = {}) {
  const state = { pids: [...standing], calls: [], killed: [], cleanupsAtStart: null };
  const run = async args => {
    state.calls.push(args);
    const cmd = String(args.at(-1));
    if (cmd.includes('pgrep')) return `SCN_WORKER_PIDS=${state.pids.join(' ')} \n`;
    if (args.includes('-d')) {
      state.cleanupsAtStart = state.ctx.cleanups.length;
      state.pids.push(...spawns);
      return '';
    }
    const hard = /^kill -9 ([0-9 ]+?) 2>/.exec(cmd);
    const soft = /^kill ([0-9 ]+?) 2>/.exec(cmd);
    const targets = (hard ?? soft)?.[1].split(' ').map(Number) ?? [];
    state.killed.push(...targets);
    if (immortal || (soft && !hard && survivesTerm)) return '';
    state.pids = state.pids.filter(p => !targets.includes(p));
    return '';
  };
  return { state, run };
}

const WORKER_OPTS = { readyTimeoutMs: 80, stopTimeoutMs: 80, pollMs: 5, killSync: () => {} };

test('extraQueueWorker refuses to run without the container-fault approval, touching nothing', async () => {
  await withContainerFaultFlag(undefined, async () => {
    const { state, run } = fakeWorkerContainer();
    state.ctx = { cleanups: [] };
    await assert.rejects(
      extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run }),
      err => err instanceof Blocked && /SCN_ALLOW_CONTAINER_FAULT=1/.test(err.message),
    );
    assert.equal(state.calls.length, 0, 'no command may reach the container without the approval');
    assert.equal(state.ctx.cleanups.length, 0);
  });
});

test('extraQueueWorker refuses unless the container holds exactly the one standing worker', async () => {
  await withContainerFaultFlag('1', async () => {
    for (const standing of [[], [101, 102]]) {
      const { state, run } = fakeWorkerContainer({ standing });
      state.ctx = { cleanups: [] };
      await assert.rejects(
        extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run }),
        err => err instanceof Blocked && /exactly one/.test(err.message),
        `with ${standing.length} worker(s) running`,
      );
      assert.equal(state.calls.some(c => c.includes('-d')), false, 'no worker may be started on a stack that is not in its known state');
    }
  });
});

test('extraQueueWorker starts a second detached worker with its own log, and registers the stop first', async () => {
  install({ laravel: { execWrapper: WRAPPER, workerUser: 'worker' } });
  await withContainerFaultFlag('1', async () => {
    const { state, run } = fakeWorkerContainer();
    state.ctx = { cleanups: [] };
    const worker = await extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run });
    const start = state.calls.find(c => c.includes('-d'));
    assert.deepEqual(start, ['exec', '-d', '-u', 'worker', '-w', '/srv/api', 'app-web', '/opt/svc-env.sh', 'api', 'sh', '-c',
      'php artisan queue:work >> storage/logs/queue-worker-2.log 2>&1']);
    assert.equal(state.cleanupsAtStart, 1, 'the stop must be registered BEFORE the start, so a failed start still stops');
    assert.equal(await worker.count(), 2);
    const listings = state.calls.filter(c => String(c.at(-1)).includes('pgrep'));
    assert.ok(listings.length > 0, 'the worker listing must have run');
    for (const c of listings) assert.ok(String(c.at(-1)).includes('^(/[^ ]*/)?php [^ ]*[a]rtisan queue:work'), c.at(-1));
    await worker.stop();
  });
});

test('extraQueueWorker passes the tenant to the worker hook and uses what it returns', async () => {
  let asked;
  install({
    hooks: {
      laravel: {
        worker: (service, args) => {
          asked = { service, ...args };
          return { pattern: '[w]orker', processRegex: '^[w]orker', start: log => `run-worker > ${log}` };
        },
      },
    },
  });
  await withContainerFaultFlag('1', async () => {
    const { state, run } = fakeWorkerContainer();
    state.ctx = { cleanups: [] };
    const reg = fakeRegistry();
    const worker = await extraQueueWorker(state.ctx, reg, 'api', 'acme', { ...WORKER_OPTS, run });
    assert.deepEqual(asked, { service: 'api', tenant: 'acme', reg });
    assert.equal(state.calls.find(c => c.includes('-d')).at(-1), 'run-worker > queue-worker-2.log');
    assert.ok(state.calls.some(c => String(c.at(-1)).includes("pgrep -f '^[w]orker'")));
    await worker.stop();
  });
});

test('extraQueueWorker.stop kills only the process it added and leaves the standing worker alone', async () => {
  await withContainerFaultFlag('1', async () => {
    const { state, run } = fakeWorkerContainer({ standing: [101], spawns: [202] });
    state.ctx = { cleanups: [] };
    const worker = await extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run });
    await worker.stop();
    assert.deepEqual(state.killed, [202], 'only the added process may be signalled');
    assert.deepEqual(state.pids, [101], 'exactly the standing worker must remain');
    await worker.stop();
    assert.deepEqual(state.killed, [202], 'a second stop() must do nothing');
  });
});

test('extraQueueWorker.stop escalates to kill -9 when the worker survives the first signal', async () => {
  await withContainerFaultFlag('1', async () => {
    const { state, run } = fakeWorkerContainer({ survivesTerm: true });
    state.ctx = { cleanups: [] };
    const worker = await extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run });
    await worker.stop();
    assert.ok(state.calls.some(c => /^kill -9 202 /.test(String(c.at(-1)))), 'kill -9 must follow a lingering worker');
    assert.deepEqual(state.pids, [101]);
  });
});

test('extraQueueWorker.stop blocks when it cannot get back to exactly one worker', async () => {
  await withContainerFaultFlag('1', async () => {
    const { state, run } = fakeWorkerContainer({ immortal: true });
    state.ctx = { cleanups: [] };
    const worker = await extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run });
    await assert.rejects(worker.stop(), err => err instanceof Blocked && /exactly the one/.test(err.message));
  });
});

test('extraQueueWorker blocks when the second worker never appears, and its registered stop then leaves the stack as found', async () => {
  await withContainerFaultFlag('1', async () => {
    const { state, run } = fakeWorkerContainer({ spawns: [] });
    state.ctx = { cleanups: [] };
    await assert.rejects(
      extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run }),
      err => err instanceof Blocked && /did not appear/.test(err.message),
    );
    assert.equal(state.ctx.cleanups.length, 1);
    await state.ctx.cleanups[0]();
    assert.deepEqual(state.pids, [101]);
  });
});

test('extraQueueWorker.stop removes the process listeners it armed', async () => {
  await withContainerFaultFlag('1', async () => {
    const counts = () => ['exit', 'SIGTERM', 'SIGINT'].map(e => process.listenerCount(e));
    const before = counts();
    const { state, run } = fakeWorkerContainer();
    state.ctx = { cleanups: [] };
    const worker = await extraQueueWorker(state.ctx, fakeRegistry(), 'api', null, { ...WORKER_OPTS, run });
    assert.ok(counts().every((n, i) => n === before[i] + 1), 'an exit and two signal listeners are the safety net');
    await worker.stop();
    assert.deepEqual(counts(), before);
  });
});

// --- queueWorkerFault -------------------------------------------------------

test('queueWorkerFault refuses without the container-fault approval, touching nothing', async () => {
  await withContainerFaultFlag(undefined, async () => {
    const calls = [];
    await assert.rejects(
      queueWorkerFault({ cleanups: [] }, fakeRegistry(), 'api', null, { run: async a => { calls.push(a); return ''; } }),
      err => err instanceof Blocked && /SCN_ALLOW_CONTAINER_FAULT=1/.test(err.message),
    );
    assert.equal(calls.length, 0);
  });
});

// A container whose worker is up until pkill and comes back on the detached start.
function killableWorker() {
  const calls = [];
  let up = true;
  const run = async args => {
    calls.push(args);
    const cmd = String(args.at(-1));
    if (cmd.includes('pkill')) up = false;
    if (args.includes('-d')) up = true;
    return cmd.includes('SCN_WORKER_UP') ? (up ? 'SCN_WORKER_UP' : 'SCN_WORKER_DOWN') : '';
  };
  return { calls, run };
}

test("queueWorkerFault kills only the pattern the worker hook names", async () => {
  await withContainerFaultFlag('1', async () => {
    const { calls, run } = killableWorker();
    await queueWorkerFault({ cleanups: [] }, fakeRegistry(), 'api', null, { run, readyTimeoutMs: 200 });
    const cmds = calls.map(a => String(a.at(-1)));
    assert.ok(cmds.find(c => c.includes("pkill -9 -f '[a]rtisan queue:work'")), 'the default worker pattern is bracketed');
    assert.ok(cmds.every(c => !c.includes("pgrep -f 'artisan")), 'no command may use an unbracketed pattern');
  });
});

test('queueWorkerFault passes the tenant to the worker hook', async () => {
  let asked;
  install({
    hooks: {
      laravel: {
        worker: (service, args) => {
          asked = { service, ...args };
          return { pattern: '[q]ueue-x', processRegex: '^[q]ueue-x', start: log => `queue-x ${log}` };
        },
      },
    },
  });
  await withContainerFaultFlag('1', async () => {
    const { calls, run } = killableWorker();
    const ctx = { cleanups: [] };
    const reg = fakeRegistry();
    await queueWorkerFault(ctx, reg, 'api', 'acme', { run, readyTimeoutMs: 200 });
    assert.deepEqual(asked, { service: 'api', tenant: 'acme', reg });
    assert.ok(calls.some(a => String(a.at(-1)).includes("pkill -9 -f '[q]ueue-x'")));
    for (const cleanup of ctx.cleanups) await cleanup();
    assert.equal(calls.find(a => a.includes('-d')).at(-1), 'queue-x queue-worker.log', 'the restore starts the hook\'s command');
  });
});

test('queueWorkerFault restore is registered before the kill and brings the worker back', async () => {
  await withContainerFaultFlag('1', async () => {
    const { calls, run } = killableWorker();
    const ctx = { cleanups: [] };
    const fault = await queueWorkerFault(ctx, fakeRegistry(), 'api', null, { run, readyTimeoutMs: 200 });
    assert.equal(ctx.cleanups.length, 1);
    assert.equal(await fault.isRunning(), false);
    await fault.restart();
    assert.equal(await fault.isRunning(), true);
    assert.equal(calls.filter(a => a.includes('-d')).length, 1);
  });
});

test('queueWorkerFault blocks when no worker was running before it tried to kill one', async () => {
  await withContainerFaultFlag('1', async () => {
    const run = async args => (String(args.at(-1)).includes('SCN_WORKER_UP') ? 'SCN_WORKER_DOWN' : '');
    await assert.rejects(
      queueWorkerFault({ cleanups: [] }, fakeRegistry(), 'api', null, { run, readyTimeoutMs: 50 }),
      err => err instanceof Blocked && /not running BEFORE/.test(err.message),
    );
  });
});

// --- every php-running exec goes through the wrapper -------------------------

// A command word `php`, bare or single-quoted, once the pattern argument of a pgrep/pkill -f is
// removed (that argument is text, not an execution).
function runsPhp(argv) {
  const cmd = String(argv.at(-1)).replace(/\b(pgrep|pkill)\b[^|;&)]*?-f\s+'[^']*'/g, '$1');
  return /(^|[\s;&|(])'?php'?\s/.test(cmd);
}

test('every PHP-running exec goes through the configured wrapper', async () => {
  install({ laravel: { execWrapper: WRAPPER } });
  await withContainerFaultFlag('1', async () => {
    const levers = { artisan: [], tinker: [], queueWorkerFault: [], extraQueueWorker: [] };
    const recordInto = (name, impl = async () => '') => async (args, stdin) => {
      levers[name].push(args);
      return impl(args, stdin);
    };

    await artisan(fakeRegistry(), 'api', ['--version'], { touchesNoDatabase: true, run: recordInto('artisan') });
    await tinker(fakeRegistry(), 'api', 'echo 1;', { run: recordInto('tinker') });

    let killed = false;
    const ctx1 = { cleanups: [] };
    await queueWorkerFault(ctx1, fakeRegistry(), 'api', null, {
      readyTimeoutMs: 200,
      run: recordInto('queueWorkerFault', async args => {
        const cmd = String(args.at(-1));
        if (cmd.includes('pkill')) killed = true;
        if (args.includes('-d')) killed = false;
        return cmd.includes('SCN_WORKER_UP') ? (killed ? 'SCN_WORKER_DOWN' : 'SCN_WORKER_UP') : '';
      }),
    });
    for (const cleanup of ctx1.cleanups) await cleanup();

    let pids = [101];
    const ctx2 = { cleanups: [] };
    const worker = await extraQueueWorker(ctx2, fakeRegistry(), 'api', null, {
      ...WORKER_OPTS,
      run: recordInto('extraQueueWorker', async args => {
        if (args.includes('-d')) { pids = [101, 202]; return ''; }
        if (String(args.at(-1)).startsWith('kill')) { pids = [101]; return ''; }
        return `SCN_WORKER_PIDS=${pids.join(' ')} \n`;
      }),
    });
    await worker.stop();

    for (const [name, argvs] of Object.entries(levers)) {
      const php = argvs.filter(runsPhp);
      assert.ok(php.length > 0, `${name}: the test saw no PHP-running argv, so the pin would be vacuous`);
      for (const argv of php) {
        assert.ok(argv.includes('/opt/svc-env.sh'), `${name}: PHP exec bypasses the wrapper: ${JSON.stringify(argv)}`);
      }
    }
  });
});
