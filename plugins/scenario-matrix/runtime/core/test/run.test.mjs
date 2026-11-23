// Batch runner: selection, lock, signals, results.json, and the lifecycle hooks
// it drives. Every path the runner would share with a live run (lock, scripts
// root, warm marker, runs directory) is a temp path, and the stack is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { selectRows, scriptState, summarize, lastJsonLine, takeLock, main, whyNoResultLine, signalExitCode } from '../run.mjs';
import { compiledFrom } from '../hash.mjs';
import { REPO, LIB } from '../paths.mjs';
import { Blocked } from '../errors.mjs';
import { __setForTest } from '../ext.mjs';

// One temp root per test file process, removed at the end. main() takes the
// lock, the scripts root and the warm marker through its deps bag, and the runs
// directory through config, so nothing here touches a real one.
const TMP = mkdtempSync(join(tmpdir(), 'scn-run-test-'));
const LOCK = join(TMP, '.lock');
const SCRIPTS_ROOT = join(TMP, '_scripts');
const ABSENT_MARKER = join(TMP, '.warm-absent');
const RUNS_REL = relative(REPO, join(TMP, 'runs'));
const TODAY = () => new Date().toISOString().slice(0, 10);

process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const rows = [{ id: 'A-01' }, { id: 'B-06' }, { id: 'B-12a' }, { id: 'C-01' }];

test('selectRows takes all, one id, or a family prefix', () => {
  assert.equal(selectRows(rows, undefined).length, 4);
  assert.deepEqual(selectRows(rows, 'B-06').map(r => r.id), ['B-06']);
  assert.deepEqual(selectRows(rows, 'B').map(r => r.id), ['B-06', 'B-12a']);
});

test('selectRows throws on a selection that matches nothing', () => {
  assert.throws(() => selectRows(rows, 'Z-99'), /matches no scenario/);
});

test('selectRows unions several selections instead of truncating to the first', () => {
  assert.deepEqual(selectRows(rows, ['B', 'C']).map(r => r.id), ['B-06', 'B-12a', 'C-01']);
  assert.deepEqual(selectRows(rows, ['A-01', 'C-01']).map(r => r.id), ['A-01', 'C-01']);
});

test('selectRows returns registry order and dedupes, whatever order the selections arrive in', () => {
  assert.deepEqual(selectRows(rows, ['C', 'A']).map(r => r.id), ['A-01', 'C-01']);
  assert.deepEqual(selectRows(rows, ['B', 'B-06']).map(r => r.id), ['B-06', 'B-12a']);
});

test('selectRows treats an empty selection list as the whole epic', () => {
  assert.equal(selectRows(rows, []).length, 4);
});

test('selectRows still throws when only one of several selections is bad', () => {
  assert.throws(() => selectRows(rows, ['B', 'Z-99']), /selection Z-99 matches no scenario/);
});

test('scriptState classifies fresh, stale and uncompiled', () => {
  assert.equal(scriptState('abc', false, null), 'uncompiled');
  assert.equal(scriptState('abc', true, 'abc'), 'fresh');
  assert.equal(scriptState('abc', true, 'old'), 'stale');
});

test('whyNoResultLine names the per-row timeout instead of reporting exit null', () => {
  const why = whyNoResultLine({ status: null, signal: 'SIGTERM', error: undefined });
  assert.match(why, /timeout/);
  assert.match(why, /15-minute/);
  assert.equal(why.includes('exit null'), false);
});

test('whyNoResultLine distinguishes a spawn failure from a script that just died quietly', () => {
  assert.match(whyNoResultLine({ status: null, signal: null, error: new Error('spawn ENOENT') }),
    /could not run the script: spawn ENOENT/);
  assert.match(whyNoResultLine({ status: 1, signal: null }), /no result line \(exit 1\)/);
  assert.match(whyNoResultLine({ status: null, signal: 'SIGKILL' }), /killed by SIGKILL/);
});

test('lastJsonLine ignores human output before the result line', () => {
  assert.deepEqual(lastJsonLine('driving UI\nrow seeded\n{"id":"B-06","result":"OK","ms":10}\n'),
    { id: 'B-06', result: 'OK', ms: 10 });
});

test('lastJsonLine skips bare JSON scalars and requires an object with a result property', () => {
  assert.equal(lastJsonLine('42\n'), null);
  assert.equal(lastJsonLine('null\n'), null);
  assert.equal(lastJsonLine('"done"\n'), null);
  assert.deepEqual(lastJsonLine('{"id":"B-06","result":"OK","ms":10}\n42\n'), { id: 'B-06', result: 'OK', ms: 10 });
});

test('lastJsonLine rejects a well-formed JSON object that has no result property', () => {
  assert.equal(lastJsonLine('{"id":"B-06","ms":10}\n'), null);
  assert.deepEqual(lastJsonLine('{"note":"no result key here"}\n{"id":"B-07","result":"KO","ms":5}\n'),
    { id: 'B-07', result: 'KO', ms: 5 });
});

test('summarize counts every contract result', () => {
  const s = summarize([
    { result: 'OK' }, { result: 'OK' }, { result: 'KO' },
    { result: 'INCONCLUSIVE' }, { result: 'STALE' }, { result: 'BLOCKED' },
  ]);
  assert.deepEqual(s, { ok: 2, ko: 1, inconclusive: 1, stale: 1, blocked: 1, skipped: 0, total: 6, skipped_ids: [] });
});

test('summarize throws loudly on an unrecognized result instead of corrupting the count', () => {
  assert.throws(() => summarize([{ result: 'OK' }, { id: 'X-01', result: 'PASS' }]), /unrecognized result "PASS"/);
});

test('summarize() counts SKIPPED and lists the skipped ids', () => {
  const s = summarize([
    { id: 'A-01', result: 'OK' },
    { id: 'A-13', result: 'SKIPPED', why: 'variant lacks a capability' },
    { id: 'G-04', result: 'SKIPPED', why: 'variant lacks a capability' },
  ]);
  assert.equal(s.ok, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.total, 3);
  assert.deepEqual(s.skipped_ids, ['A-13', 'G-04']);
});

test('summarize() copies the truthy extras into the summary and drops the rest', () => {
  const s = summarize([{ id: 'A-01', result: 'OK' }], { variant: 'blue', empty: '', none: undefined });
  assert.equal(s.variant, 'blue');
  assert.equal('empty' in s, false);
  assert.equal('none' in s, false);
});

test('summarize() adds no key when there are no extras', () => {
  const s = summarize([{ id: 'A-01', result: 'OK' }]);
  assert.deepEqual(Object.keys(s).sort(), ['blocked', 'inconclusive', 'ko', 'ok', 'skipped', 'skipped_ids', 'stale', 'total']);
});

test('takeLock refuses a second holder and release() frees it for the next run', () => {
  if (existsSync(LOCK)) rmSync(LOCK);
  const release = takeLock('epic-a', LOCK);
  try {
    assert.throws(() => takeLock('epic-b', LOCK), /another run holds the scn stack/);
  } finally {
    release();
  }
  assert.equal(existsSync(LOCK), false, 'release() must remove the lock file');
  takeLock('epic-c', LOCK)();
});

test('takeLock reclaims a lock whose holder pid is dead, but not a live or unparseable one', (t) => {
  if (existsSync(LOCK)) rmSync(LOCK);
  const notices = [];
  t.mock.method(console, 'error', (m) => { notices.push(String(m)); });
  const deadPid = spawnSync('true').pid;
  writeFileSync(LOCK, JSON.stringify({ pid: deadPid, epic: 'crashed' }));
  const release = takeLock('epic-a', LOCK);
  assert.equal(JSON.parse(readFileSync(LOCK, 'utf8')).pid, process.pid, 'reclaimed lock must name the new holder');
  release();
  assert.match(notices[0], /reclaiming stale lock/);

  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, epic: 'live' }));
  assert.throws(() => takeLock('epic-b', LOCK), /another run holds the scn stack/);
  writeFileSync(LOCK, '');
  assert.throws(() => takeLock('epic-c', LOCK), /another run holds the scn stack/);
  rmSync(LOCK);
});

test('signalExitCode follows the shell 128+N convention', () => {
  assert.equal(signalExitCode('SIGINT'), 130);
  assert.equal(signalExitCode('SIGTERM'), 143);
});

test('the unit suite never touches the real run lock or the versioned scripts tree', () => {
  assert.notEqual(LOCK, join(REPO, '.claude/scenarios/_lib/.lock'), 'tests must use a temp lock path');
  assert.notEqual(SCRIPTS_ROOT, join(REPO, '.claude/scenarios/_scripts'), 'tests must use a temp scripts root');
  assert.ok(LOCK.startsWith(tmpdir()), `${LOCK} must live under the OS temp dir`);
  assert.ok(SCRIPTS_ROOT.startsWith(tmpdir()), `${SCRIPTS_ROOT} must live under the OS temp dir`);
  assert.ok(join(REPO, RUNS_REL).startsWith(tmpdir()), 'results must land under the OS temp dir');
});

// --- harness ----------------------------------------------------------------

const okRow = { id: 'OK-01', behaviour: 'fake ok' };
const koRow = { id: 'KO-01', behaviour: 'fake ko' };

function writeScript(epic, row, result, extra = '') {
  const dir = join(SCRIPTS_ROOT, epic);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${row.id}.mjs`),
    `// scenario: ${row.id} compiled_from: ${compiledFrom(row)}\n`
    + `console.log(JSON.stringify({ id: '${row.id}', result: '${result}', ms: 1 }));\n${extra}`);
}

// Runs main() against fakes. `lifecycle` is installed as the project's hooks,
// `cfg` merges over the config defaults, `env` sets process.env for the run.
async function drive(t, name, { lifecycle = {}, hooks = {}, cfg = {}, env = {}, rowDefs = [okRow], deps = {} } = {}) {
  const epic = `__run-${name}__`;
  if (existsSync(LOCK)) rmSync(LOCK);
  const calls = [];
  const fakeBash = (cmd, opts) => { calls.push({ cmd, opts }); return deps.status?.[cmd] ?? 0; };
  t.after(__setForTest({
    hooks: { lifecycle, ...hooks }, adapters: {}, providers: {},
    config: { runsDir: RUNS_REL, ...cfg },
  }));
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  t.after(() => { if (existsSync(LOCK)) rmSync(LOCK); });
  const merged = {
    bash: fakeBash, loadRegistry: (e) => ({ epic: e, rows: rowDefs }),
    lock: LOCK, scriptsRoot: SCRIPTS_ROOT, warmMarker: ABSENT_MARKER, ...deps.main,
  };
  // Console and stdout are captured so a run's own chatter stays out of the
  // test report; `log` and `err` hold what it printed.
  const log = []; const err = [];
  const orig = { log: console.log, error: console.error, write: process.stdout.write };
  console.log = (...a) => { log.push(a.join(' ')); };
  console.error = (...a) => { err.push(a.join(' ')); };
  // Only the rows' own result lines are swallowed: the test reporter shares this stream.
  process.stdout.write = function (c, ...rest) {
    if (typeof c === 'string' && c.startsWith('{"id"')) { log.push(c); return true; }
    return orig.write.call(this, c, ...rest);
  };
  let out; let error;
  try { out = await main(['node', 'run.mjs', epic], merged); } catch (e) { error = e; }
  finally { console.log = orig.log; console.error = orig.error; process.stdout.write = orig.write; }
  const resultsPath = join(REPO, RUNS_REL, epic, TODAY(), 'results.json');
  const written = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : null;
  return { epic, out, error, written, calls, resultsPath, log, err };
}

// --- main(): the lifecycle ---------------------------------------------------

test('main() drives lock, bring-up, per-row execution and teardown through the config commands', async (t) => {
  const epic = '__run-basic__';
  writeScript(epic, okRow, 'OK');
  writeScript(epic, koRow, 'KO', 'process.exit(1);\n');
  const r = await drive(t, 'basic', {
    cfg: { lifecycle: { up: 'stack-up', down: 'stack-down' } }, rowDefs: [okRow, koRow],
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.calls.map(c => c.cmd), ['stack-up', 'stack-down']);
  assert.ok(r.calls.every(c => c.opts?.check === false), 'lifecycle commands run with check: false');
  assert.equal(existsSync(LOCK), false, 'the lock must be released once the run finishes');
  assert.deepEqual(r.written.results.map(x => x.id), ['OK-01', 'KO-01']);
  assert.deepEqual(r.written.summary, { ok: 1, ko: 1, inconclusive: 0, stale: 0, blocked: 0, skipped: 0, total: 2, skipped_ids: [] });
  assert.deepEqual(Object.keys(r.written).slice(0, 3), ['epic', 'date', 'selection']);
  assert.equal(r.written.selection, 'all');
  assert.equal('interrupted' in r.written, false);
  assert.equal('refused' in r.written, false);

  const tm = r.written.timing;
  assert.equal(typeof tm.startedAt, 'string');
  for (const k of ['wallMs', 'bringUpMs', 'rowsMs', 'overheadMs']) assert.equal(typeof tm[k], 'number', `timing.${k}`);
  assert.equal(tm.overheadMs, tm.wallMs - tm.rowsMs, 'overheadMs is exactly the wall clock no row could use');
  // The three durations are rounded independently, so bring-up may exceed overhead by 1ms.
  assert.ok(tm.bringUpMs <= tm.overheadMs + 1, 'bringUpMs may exceed overheadMs by at most 1ms of independent rounding');
});

test('with no lifecycle commands and no hooks, a run brings up and tears down nothing', async (t) => {
  const epic = '__run-noconfig__';
  writeScript(epic, okRow, 'OK');
  const r = await drive(t, 'noconfig');
  assert.equal(r.error, undefined);
  assert.deepEqual(r.calls, []);
  assert.equal(r.written.summary.ok, 1);
});

test('a refused bring-up writes refused and tears nothing down', async (t) => {
  const seen = [];
  const r = await drive(t, 'refused', {
    lifecycle: {
      bringUp: async () => ({ refused: 'not now' }),
      tearDown: async () => { seen.push('tearDown'); },
    },
  });
  assert.ok(r.error instanceof Blocked);
  assert.equal(r.error.message, 'not now');
  assert.deepEqual(seen, []);
  assert.equal(r.written.refused, 'not now');
  assert.deepEqual(r.written.results, []);
  assert.equal(existsSync(LOCK), false);
});

test('the default bring-up treats the refused exit status as a refusal and tears nothing down', async (t) => {
  const r = await drive(t, 'refused-default', {
    cfg: { lifecycle: { up: 'stack-up', down: 'stack-down', refusedExit: 78 } },
    deps: { status: { 'stack-up': 78 } },
  });
  assert.ok(r.error instanceof Blocked);
  assert.equal(r.written.refused,
    'stack-up refused before changing anything (its reason is printed above), so this run tore nothing down');
  assert.deepEqual(r.calls.map(c => c.cmd), ['stack-up'], 'no teardown command may run');
});

test('an up command killed by a signal is a failure, not a refusal, when no refused exit is configured', async (t) => {
  const ran = [];
  const r = await drive(t, 'up-signalled', {
    cfg: { lifecycle: { up: 'stack-up', down: 'stack-down', refusedExit: null } },
    // spawnSync reports a signal-killed child with status null.
    deps: { main: { bash: (cmd) => { ran.push(cmd); return cmd === 'stack-up' ? null : 0; } } },
  });
  assert.match(r.error.message, /command failed \(null\): stack-up/);
  assert.deepEqual(ran, ['stack-up', 'stack-down'], 'a half-started stack is torn down');
  assert.equal('refused' in r.written, false);
});

test('a default bring-up failing after its first state change still gets the full teardown', async (t) => {
  const r = await drive(t, 'up-fails', {
    cfg: { lifecycle: { up: 'stack-up', down: 'stack-down' } },
    deps: { status: { 'stack-up': 1 } },
  });
  assert.match(r.error.message, /command failed \(1\): stack-up/);
  assert.deepEqual(r.calls.map(c => c.cmd), ['stack-up', 'stack-down']);
  assert.equal('refused' in r.written, false);
});

test('a Blocked thrown by bringUp is a refusal', async (t) => {
  const seen = [];
  const r = await drive(t, 'blocked-up', {
    lifecycle: {
      bringUp: async () => { throw new Blocked('no session configured'); },
      tearDown: async () => { seen.push('tearDown'); },
    },
  });
  assert.ok(r.error instanceof Blocked);
  assert.equal(r.written.refused, 'no session configured');
  assert.deepEqual(seen, []);
});

test('a non-Blocked bringUp failure is not a refusal and still tears down', async (t) => {
  const seen = [];
  const r = await drive(t, 'plain-up-fail', {
    lifecycle: {
      bringUp: async () => { throw new Error('boom'); },
      tearDown: async () => { seen.push('tearDown'); },
    },
  });
  assert.equal(r.error.message, 'boom');
  assert.equal('refused' in r.written, false);
  assert.deepEqual(seen, ['tearDown']);
});

test('the warm path calls warmUp, not bringUp', async (t) => {
  const marker = join(TMP, '.warm-present');
  writeFileSync(marker, 'warm\n');
  t.after(() => rmSync(marker, { force: true }));
  writeScript('__run-warm-path__', okRow, 'OK');
  const seen = [];
  const r = await drive(t, 'warm-path', {
    lifecycle: {
      bringUp: async () => { seen.push('bringUp'); return { ok: true }; },
      warmUp: async ({ reg }) => { seen.push(`warmUp:${reg.epic}`); },
      verifyUp: async () => { seen.push('verifyUp'); },
    },
    deps: { main: { warmMarker: marker } },
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(seen, ['warmUp:__run-warm-path__', 'verifyUp']);
  assert.equal(existsSync(marker), false, 'a normal teardown removes the marker');
});

test('a hook isWarm overrides the marker check', async (t) => {
  const seen = [];
  await drive(t, 'is-warm-hook', {
    lifecycle: {
      isWarm: async () => true,
      bringUp: async () => { seen.push('bringUp'); return { ok: true }; },
      warmUp: async () => { seen.push('warmUp'); },
    },
    rowDefs: [],
  });
  assert.deepEqual(seen, ['warmUp']);
});

test('the default warmUp runs the reset.baseline hook', async (t) => {
  const marker = join(TMP, '.warm-present-2');
  writeFileSync(marker, 'warm\n');
  t.after(() => rmSync(marker, { force: true }));
  const seen = [];
  const r = await drive(t, 'warm-baseline', {
    hooks: { reset: { baseline: async ({ reg }) => { seen.push(reg.epic); } } },
    deps: { main: { warmMarker: marker } },
    rowDefs: [],
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(seen, ['__run-warm-baseline__']);
});

test('a failing warm baseline aborts the run before any row', async (t) => {
  const marker = join(TMP, '.warm-present-3');
  writeFileSync(marker, 'warm\n');
  t.after(() => rmSync(marker, { force: true }));
  writeScript('__run-warm-fail__', okRow, 'OK');
  const r = await drive(t, 'warm-fail', {
    hooks: { reset: { baseline: async () => { throw new Error('restore failed'); } } },
    deps: { main: { warmMarker: marker } },
  });
  assert.equal(r.error.message, 'restore failed');
  assert.deepEqual(r.written.results, []);
});

test('a verifyUp failure stops before any row and still tears down', async (t) => {
  writeScript('__run-verify__', okRow, 'OK');
  const seen = [];
  const r = await drive(t, 'verify', {
    lifecycle: {
      verifyUp: async () => { throw new Error('worker not alive'); },
      tearDown: async () => { seen.push('tearDown'); },
    },
  });
  assert.equal(r.error.message, 'worker not alive');
  assert.deepEqual(r.written.results, []);
  assert.deepEqual(seen, ['tearDown']);
  assert.equal(r.written.timing.rowsMs, null, 'no rows window means no overhead figure');
  assert.equal(r.written.timing.overheadMs, null);
});

test('verifyUp runs on the cold path as well as the warm one', async (t) => {
  const seen = [];
  await drive(t, 'verify-cold', { lifecycle: { verifyUp: async ({ reg }) => { seen.push(reg.epic); } }, rowDefs: [] });
  assert.deepEqual(seen, ['__run-verify-cold__']);
});

test('keep-warm leaves the marker and skips tearDown', async (t) => {
  const marker = join(TMP, '.warm-written');
  t.after(() => rmSync(marker, { force: true }));
  writeScript('__run-keep-warm__', okRow, 'OK');
  const seen = [];
  const r = await drive(t, 'keep-warm', {
    lifecycle: { tearDown: async () => { seen.push('tearDown'); } },
    cfg: { lifecycle: { down: 'stack-down' } },
    env: { SCN_KEEP_WARM: '1' },
    deps: { main: { warmMarker: marker } },
  });
  assert.equal(r.error, undefined);
  assert.deepEqual(seen, []);
  assert.equal(existsSync(marker), true);
  assert.ok(r.log.includes('stack left UP (SCN_KEEP_WARM=1)\n  stack-down'), r.log.join('|'));
});

test('keep-warm names no down command when none is configured', async (t) => {
  const r = await drive(t, 'keep-warm-nodown', { env: { SCN_KEEP_WARM: '1' }, deps: { main: { warmMarker: join(TMP, '.warm-w2') } }, rowDefs: [] });
  assert.ok(r.log.includes('stack left UP (SCN_KEEP_WARM=1)'), r.log.join('|'));
});

test('the keep-warm variable name comes from config, and only the exact value 1 enables it', async (t) => {
  const seen = [];
  const lifecycle = { tearDown: async () => { seen.push('tearDown'); } };
  await drive(t, 'kw-named', { lifecycle, cfg: { lifecycle: { keepWarmEnv: 'MY_KEEP' } }, env: { MY_KEEP: '1', SCN_KEEP_WARM: '0' }, rowDefs: [] });
  assert.deepEqual(seen, [], 'MY_KEEP=1 keeps the stack warm');
  await drive(t, 'kw-true', { lifecycle, env: { SCN_KEEP_WARM: 'true' }, rowDefs: [] });
  assert.deepEqual(seen, ['tearDown'], 'only "1" enables keep-warm');
});

test('a refused bring-up under keep-warm writes no warm marker', async (t) => {
  const marker = join(TMP, '.warm-refused');
  await drive(t, 'kw-refused', {
    lifecycle: { bringUp: async () => ({ refused: 'no' }) },
    env: { SCN_KEEP_WARM: '1' },
    deps: { main: { warmMarker: marker } },
  });
  assert.equal(existsSync(marker), false);
});

test('a teardown that throws is logged and does not lose the results', async (t) => {
  writeScript('__run-down-throws__', okRow, 'OK');
  const r = await drive(t, 'down-throws', { lifecycle: { tearDown: async () => { throw new Error('gone'); } } });
  assert.equal(r.error, undefined);
  assert.equal(r.written.summary.ok, 1);
  assert.ok(r.err.some(m => m.includes('gone')));
  assert.equal(existsSync(LOCK), false);
});

test('the summary carries summaryExtras, fed by runFacts captured before teardown', async (t) => {
  writeScript('__run-extras__', okRow, 'OK');
  const order = [];
  const r = await drive(t, 'extras', {
    lifecycle: {
      runFacts: async () => { order.push('runFacts'); return { variant: 'blue' }; },
      tearDown: async () => { order.push('tearDown'); },
    },
    hooks: { summaryExtras: (facts) => { order.push('summaryExtras'); return { variant: facts.variant, unset: null }; } },
  });
  assert.deepEqual(order, ['runFacts', 'tearDown', 'summaryExtras']);
  assert.equal(r.written.summary.variant, 'blue');
  assert.equal('unset' in r.written.summary, false);
});

test('a failing runFacts degrades the report instead of costing the results', async (t) => {
  writeScript('__run-facts-fail__', okRow, 'OK');
  const r = await drive(t, 'facts-fail', {
    lifecycle: {
      runFacts: async () => { throw new Error('state file gone'); },
    },
    hooks: { summaryExtras: (facts) => ({ seen: Object.keys(facts).length === 0 && 'empty' }) },
  });
  assert.equal(r.error, undefined);
  assert.equal(r.written.summary.ok, 1);
  assert.equal(r.written.summary.seen, 'empty');
  assert.ok(r.err.some(m => /runFacts/.test(m) && m.includes('state file gone')), 'the hook failure is logged, not swallowed');
});

test('a failing summaryExtras is logged and the summary is still written', async (t) => {
  writeScript('__run-extras-fail__', okRow, 'OK');
  const r = await drive(t, 'extras-fail', { hooks: { summaryExtras: () => { throw new Error('bad extras'); } } });
  assert.equal(r.error, undefined);
  assert.equal(r.written.summary.ok, 1);
  assert.ok(r.err.some(m => /summaryExtras/.test(m) && m.includes('bad extras')));
});

test('the compile hint comes from config', async (t) => {
  const r = await drive(t, 'hint', {
    cfg: { compileHint: 'make compile EPIC={epic} ROW={id}' }, rowDefs: [{ id: 'NEW-01', behaviour: 'x' }],
  });
  assert.ok(r.log.includes('NEW-01 UNCOMPILED — run: make compile EPIC=__run-hint__ ROW=NEW-01'), r.log.join('|'));
  assert.deepEqual(r.written.results, [{ id: 'NEW-01', result: 'BLOCKED', why: 'uncompiled' }]);
});

test('a SIGTERM mid-run stops before the next row, still tears down and releases the lock', async (t) => {
  const epic = '__run-sigterm__';
  const first = { id: 'S-01', behaviour: 'runs, then the stop arrives' };
  const second = { id: 'S-02', behaviour: 'must never start' };
  for (const row of [first, second]) writeScript(epic, row, 'OK');
  const signals = new EventEmitter();
  const spawned = [];
  const seen = [];
  const r = await drive(t, 'sigterm', {
    rowDefs: [first, second],
    lifecycle: { tearDown: async () => { seen.push('tearDown'); } },
    deps: {
      main: {
        signals,
        spawnSync: (_node, [path]) => {
          spawned.push(path);
          signals.emit('SIGTERM', 'SIGTERM');
          return { status: 0, signal: null, stdout: `${JSON.stringify({ id: 'S-01', result: 'OK', ms: 1 })}\n` };
        },
      },
    },
  });
  assert.deepEqual(r.out, { interrupted: 'SIGTERM' });
  assert.equal(spawned.length, 1, 'the row after the stop must never start');
  assert.deepEqual(seen, ['tearDown']);
  assert.equal(existsSync(LOCK), false);
  for (const s of ['SIGINT', 'SIGTERM']) assert.equal(signals.listenerCount(s), 0, `${s} handler removed`);
  assert.equal(r.written.interrupted, 'SIGTERM');
  assert.deepEqual(r.written.results.map(x => x.id), ['S-01']);
});

test('a completed run reports no interruption and leaves no signal handlers behind', async (t) => {
  const signals = new EventEmitter();
  const r = await drive(t, 'no-sigterm', { rowDefs: [], deps: { main: { signals } } });
  assert.deepEqual(r.out, { interrupted: null });
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal('interrupted' in r.written, false);
});

test('a malformed result cannot cost the run its collected results.json', async (t) => {
  const badRow = { id: 'BAD-01', behaviour: 'off-contract result' };
  writeScript('__run-malformed__', badRow, 'PASS');
  const r = await drive(t, 'malformed', { rowDefs: [badRow] });
  assert.match(r.error.message, /unrecognized result "PASS"/);
  assert.equal(existsSync(LOCK), false, 'the lock must still be released when summarize() throws');
  assert.deepEqual(r.written.results, [{ id: 'BAD-01', result: 'PASS', ms: 1 }]);
  assert.match(r.written.summary.error, /unrecognized result "PASS"/);
});

test('main() still releases the lock when the run directory cannot be created', async (t) => {
  const r = await drive(t, 'mkdir-fail', {
    rowDefs: [],
    deps: { main: { mkdirSync: () => { throw new Error('EACCES: permission denied (fake)'); } } },
  });
  assert.match(r.error.message, /permission denied \(fake\)/);
  assert.equal(existsSync(LOCK), false);
});

test('a row that prints no result line is BLOCKED with the reason', async (t) => {
  const epic = '__run-silent__';
  writeScript(epic, okRow, 'OK');
  const r = await drive(t, 'silent', {
    deps: { main: { spawnSync: () => ({ status: 3, signal: null, stdout: '{"id":"noise"}\n' }) } },
  });
  assert.deepEqual(r.written.results, [{ id: 'OK-01', result: 'BLOCKED', why: 'no result line (exit 3)' }]);
});

test('a lock held by another run refuses before any lifecycle step', async (t) => {
  const seen = [];
  t.after(__setForTest({ hooks: { lifecycle: { bringUp: async () => { seen.push('bringUp'); return { ok: true }; } } }, adapters: {}, providers: {}, config: { runsDir: RUNS_REL } }));
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, epic: 'other' }));
  t.after(() => rmSync(LOCK, { force: true }));
  await assert.rejects(main(['node', 'run.mjs', 'e'], {
    loadRegistry: (e) => ({ epic: e, rows: [] }), lock: LOCK, scriptsRoot: SCRIPTS_ROOT, warmMarker: ABSENT_MARKER,
  }), /another run holds the scn stack/);
  assert.deepEqual(seen, []);
});

// --- plan and CLI -------------------------------------------------------------

test('--plan prints the fresh/stale/uncompiled counts and exits 0 without a lock', async (t) => {
  const epic = '__run-plan__';
  const fresh = { id: 'P-01', behaviour: 'fresh' };
  const stale = { id: 'P-02', behaviour: 'stale' };
  const missing = { id: 'P-03', behaviour: 'missing' };
  writeScript(epic, fresh, 'OK');
  mkdirSync(join(SCRIPTS_ROOT, epic), { recursive: true });
  writeFileSync(join(SCRIPTS_ROOT, epic, 'P-02.mjs'), '// scenario: P-02 compiled_from: old\n');
  const lines = [];
  const origLog = console.log;
  const origExit = process.exit;
  console.log = (...a) => { lines.push(a.join(' ')); };
  process.exit = (code) => { throw Object.assign(new Error('exit'), { code }); };
  t.after(() => { console.log = origLog; process.exit = origExit; });
  let exitCode;
  try {
    await main(['node', 'run.mjs', epic, '--plan'], {
      loadRegistry: (e) => ({ epic: e, rows: [fresh, stale, missing] }), lock: LOCK, scriptsRoot: SCRIPTS_ROOT,
    });
  } catch (e) { exitCode = e.code; }
  console.log = origLog;
  process.exit = origExit;
  assert.equal(exitCode, 0);
  assert.deepEqual(lines, ['fresh 1 · stale 1 · uncompiled 1', 'stale: P-02', 'uncompiled: P-03']);
  assert.equal(existsSync(LOCK), false);
});

// --- the runs root keeps itself out of git ------------------------------------

test('a run writes a .gitignore of * into the runs root', async (t) => {
  const runsDir = `${RUNS_REL}-ignore-new`;
  await drive(t, 'ign-new', { cfg: { runsDir } });
  assert.equal(readFileSync(join(REPO, runsDir, '.gitignore'), 'utf8'), '*\n');
});

test('an existing runs .gitignore is left byte for byte unchanged', async (t) => {
  const runsDir = `${RUNS_REL}-ignore-keep`;
  mkdirSync(join(REPO, runsDir), { recursive: true });
  const custom = '# versioned on purpose\n!results.json\r\n';
  writeFileSync(join(REPO, runsDir, '.gitignore'), custom);
  await drive(t, 'ign-keep', { cfg: { runsDir } });
  assert.equal(readFileSync(join(REPO, runsDir, '.gitignore'), 'utf8'), custom);
});

test('--plan creates nothing under the runs root', async (t) => {
  const runsDir = `${RUNS_REL}-ignore-plan`;
  t.after(__setForTest({ hooks: {}, adapters: {}, providers: {}, config: { runsDir } }));
  const origLog = console.log;
  const origExit = process.exit;
  console.log = () => {};
  process.exit = (code) => { throw Object.assign(new Error('exit'), { code }); };
  t.after(() => { console.log = origLog; process.exit = origExit; });
  await assert.rejects(main(['node', 'run.mjs', '__run-ign-plan__', '--plan'], {
    loadRegistry: (e) => ({ epic: e, rows: [okRow] }), lock: LOCK, scriptsRoot: SCRIPTS_ROOT,
  }), { code: 0 });
  assert.equal(existsSync(join(REPO, runsDir)), false);
});

// Driven as a real child process: the guard is an exit code, and process.exit()
// inside the test runner would take the whole suite with it. The epic does not
// exist, because the guard must fire before the registry is even loaded.
const runMjs = join(LIB, 'run.mjs');

test('an unrecognised flag exits 64 and names both the flag and the known ones', () => {
  const r = spawnSync(process.execPath, [runMjs, '__no-such-epic__', '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown flag\(s\) --list/);
  assert.match(r.stderr, /known: --plan/);
  assert.match(r.stderr, /usage: run\.mjs <epic>/);
});

test('a typo of the one known flag is rejected too, rather than running the whole matrix', () => {
  const r = spawnSync(process.execPath, [runMjs, '__no-such-epic__', '--pln'], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown flag\(s\) --pln/);
});

test('every unknown flag is listed at once, and the guard runs before the registry loads', () => {
  const r = spawnSync(process.execPath, [runMjs, '__no-such-epic__', '--list', 'A-01', '--verbose'], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown flag\(s\) --list --verbose/);
  assert.doesNotMatch(r.stderr, /env_registry|no such file/i);
});

test('no epic is a usage error that exits 64', () => {
  const r = spawnSync(process.execPath, [runMjs], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage: run\.mjs <epic>/);
});
