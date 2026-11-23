// scenario.mjs's classify() defaults an UNRECOGNISED throw to KO, which reports
// a product bug. That default is load-bearing for the whole harness's
// credibility: every lever that reaches the environment, and every lever that
// can be handed something the library cannot honour, has to type what it throws
// or its failure is reported as a defect in the code under test.
//
// This file pins the classification of each core category in one place,
// because the failure mode is silent: an untyped throw does not break any other
// test, it just quietly relabels an environment failure as a product bug.
// Adapter-owned categories are pinned by each adapter's own classification test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ko, Blocked, Inconclusive } from '../errors.mjs';
import { loadRegistryFromPath, resolveTemplate } from '../registry.mjs';
import { stub } from '../observe.mjs';
import { stubFault } from '../fault.mjs';
import { __setForTest } from '../ext.mjs';
import { runScenario } from './support/run-scenario.mjs';

const FIXTURE = `${import.meta.dirname}/fixtures/neutral-registry.yaml`;

function matrixFile(text) {
  const file = join(mkdtempSync(join(tmpdir(), 'scn-class-')), 'probe.yaml');
  writeFileSync(file, text);
  return file;
}

// --- Blocked: the ENVIRONMENT could not honour the call ---------------------

test('every registry lookup miss is Blocked, not KO', () => {
  const reg = loadRegistryFromPath(FIXTURE);
  const misses = [
    () => reg.host('typo-alias'),
    () => reg.logSource('nope-svc'),
  ];
  for (const miss of misses) assert.throws(miss, err => err instanceof Blocked);
});

test('a matrix with no infra.env_registry is Blocked', () => {
  const file = matrixFile('epic: probe\nscenarios: []\n');
  assert.throws(() => loadRegistryFromPath(file), err => err instanceof Blocked);
});

test('an unquoted date in a matrix is Blocked, never hashed as a Date', () => {
  const file = matrixFile([
    'epic: probe',
    'infra:',
    '  env_registry:',
    '    hosts: { app: app.test }',
    'scenarios:',
    '  - id: A-01',
    '    setup: [2026-07-29]',
    '',
  ].join('\n'));
  assert.throws(() => loadRegistryFromPath(file), err => err instanceof Blocked);
});

test('a facade whose driver no installed adapter provides is Blocked', (t) => {
  t.after(__setForTest({ adapters: {}, providers: {} }));
  const reg = loadRegistryFromPath(FIXTURE);
  assert.throws(() => stub(reg, 'any'), err => err instanceof Blocked);
  assert.throws(() => stubFault(reg, 'any'), err => err instanceof Blocked);
});

test('a facade names the adapter to add when the catalog provides the driver', (t) => {
  t.after(__setForTest({ adapters: {}, providers: { stub: ['some-adapter'] } }));
  const reg = loadRegistryFromPath(FIXTURE);
  assert.throws(() => stub(reg, 'any'), err => err instanceof Blocked && /some-adapter/.test(err.message));
});

// --- Inconclusive: the SCENARIO AUTHOR asked for the impossible -------------

test('an unresolved template placeholder is Inconclusive, because it is a caller parameter and not a registry key', () => {
  assert.throws(() => resolveTemplate('{host}/{path}', { host: 'a.b' }), err => err instanceof Inconclusive);
});

test('a row id the matrix does not hold is Inconclusive', () => {
  const reg = loadRegistryFromPath(FIXTURE);
  assert.throws(() => reg.row('Z-99'), err => err instanceof Inconclusive);
});

// --- Skipped: the project's requirement gate declines a row ------------------
//
// These drive the real scenario() export end to end through runScenario, in
// process, so the assertions can read closures (bodyRan, cleaned, shot) that a
// child process could never hand back. A project's requirementGate is injected
// through the ext test seam.

const withGate = (t, requirementGate) => t.after(__setForTest({ hooks: { requirementGate } }));

test('a row the gate declines is SKIPPED, not run', async (t) => {
  withGate(t, () => 'the environment lacks the feature');
  let bodyRan = false;
  const reg = { row: () => ({ id: 'A-13', requires: ['feature'] }) };
  const out = await runScenario('A-13', () => { bodyRan = true; }, { registry: () => reg });
  assert.equal(out.result, 'SKIPPED');
  assert.equal(out.exit, 5);
  // "skipped" with no reason is indistinguishable from a row nobody wrote.
  assert.equal(out.why, 'the environment lacks the feature');
  assert.equal(bodyRan, false);
});

test('SKIPPED runs cleanups and captures no evidence', async (t) => {
  // reset() has not run, so nothing reached the environment worth
  // photographing, but a cleanup registered by a previous phase still must.
  // Each SKIPPED test uses its own id: the stdout filter in runScenario keys on it.
  withGate(t, () => 'declined');
  let cleaned = false, shot = false;
  const reg = { row: () => ({ id: 'A-14', requires: ['feature'] }) };
  const out = await runScenario('A-14', () => {}, {
    registry: () => reg,
    captureEvidence: () => { shot = true; return 'dir'; },
    onCtx: ctx => ctx.cleanups.push(() => { cleaned = true; }),
  });
  assert.equal(out.result, 'SKIPPED');
  assert.equal(shot, false);
  assert.equal(cleaned, true);
});

test('the gate runs AFTER the staleness check', async (t) => {
  // A stale compiled script's requires list is itself stale, so reporting
  // SKIPPED for it would hide the recompile the row actually needs.
  withGate(t, () => 'declined');
  const reg = { row: () => ({ id: 'A-15', requires: ['feature'] }) };
  const out = await runScenario('A-15', () => {}, { registry: () => reg, compiledFrom: 'deadbeef' });
  assert.equal(out.result, 'STALE');
});

// --- Retries: opt-in per row (`retries:`), KO and BLOCKED, never INCONCLUSIVE
//
// A row that never declares `retries` behaves exactly as it did before the
// feature existed; the first test pins that. The rest exercise the opt-in path
// a row gets by adding `retries: N` (and optionally `retry_delay_ms: N`).

test('no retries field: fn runs once even on KO', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-01' }) };
  const out = await runScenario('R-01', () => { calls++; throw new Ko('nope'); }, { registry: () => reg });
  assert.equal(out.result, 'KO');
  assert.equal(calls, 1);
  assert.equal('attempts' in out, false);
});

test('retries: N retries a KO, and the result reports the actual attempt count', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-02', retries: 2 }) };
  const out = await runScenario('R-02', () => {
    calls++;
    if (calls < 3) throw new Ko(`fail ${calls}`);
  }, { registry: () => reg });
  assert.equal(out.result, 'OK');
  assert.equal(calls, 3);
  assert.equal(out.attempts, 3);
});

test('retries exhausted: still KO after the last attempt, and fn ran retries+1 times', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-03', retries: 2 }) };
  const out = await runScenario('R-03', () => { calls++; throw new Ko(`fail ${calls}`); }, { registry: () => reg });
  assert.equal(out.result, 'KO');
  assert.equal(calls, 3);
  assert.equal(out.attempts, 3);
  // The LAST attempt's reason survives, not the first's.
  assert.match(out.why, /fail 3/);
});

test('BLOCKED retries just like KO, since its most common source is a timing race and not an outage', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-04', retries: 2 }) };
  const out = await runScenario('R-04', () => {
    calls++;
    if (calls < 3) throw new Blocked('marker not visible yet');
  }, { registry: () => reg });
  assert.equal(out.result, 'OK');
  assert.equal(calls, 3);
  assert.equal(out.attempts, 3);
});

test('a BLOCKED that never clears still exhausts maxAttempts rather than looping forever', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-04b', retries: 2 }) };
  const out = await runScenario('R-04b', () => { calls++; throw new Blocked('service down'); }, { registry: () => reg });
  assert.equal(out.result, 'BLOCKED');
  assert.equal(calls, 3);
  assert.equal(out.attempts, 3);
});

test('INCONCLUSIVE is never retried, even when the row declares retries', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-05', retries: 3 }) };
  const out = await runScenario('R-05', () => { calls++; throw new Inconclusive('no lever'); }, { registry: () => reg });
  assert.equal(out.result, 'INCONCLUSIVE');
  assert.equal(calls, 1);
});

test('a malformed retries value is INCONCLUSIVE and fn never runs', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-06', retries: 'lots' }) };
  const out = await runScenario('R-06', () => { calls++; }, { registry: () => reg });
  assert.equal(out.result, 'INCONCLUSIVE');
  assert.match(out.why, /retries: "lots"/);
  assert.equal(calls, 0);
});

test('a negative retries value is INCONCLUSIVE', async () => {
  const reg = { row: () => ({ id: 'R-07', retries: -1 }) };
  const out = await runScenario('R-07', () => {}, { registry: () => reg });
  assert.equal(out.result, 'INCONCLUSIVE');
  assert.match(out.why, /retries: -1/);
});

test('a malformed retry_delay_ms value is INCONCLUSIVE and fn never runs', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-08', retries: 1, retry_delay_ms: -5 }) };
  const out = await runScenario('R-08', () => { calls++; }, { registry: () => reg });
  assert.equal(out.result, 'INCONCLUSIVE');
  assert.match(out.why, /retry_delay_ms: -5/);
  assert.equal(calls, 0);
});

test('cleanups from a failed attempt run before the next attempt starts, not deferred to the end', async () => {
  // This ordering lets a retry restore whatever the failed attempt faulted or
  // opened BEFORE the next attempt gets a turn.
  const order = [];
  let calls = 0;
  const reg = { row: () => ({ id: 'R-09', retries: 1 }) };
  const out = await runScenario('R-09', ctx => {
    calls++;
    order.push(`attempt-${calls}-start`);
    ctx.cleanups.push(() => order.push(`cleanup-${calls}`));
    if (calls === 1) throw new Ko('first attempt fails');
  }, { registry: () => reg });
  assert.equal(out.result, 'OK');
  assert.deepEqual(order, ['attempt-1-start', 'cleanup-1', 'attempt-2-start', 'cleanup-2']);
});

test('evidence reflects the LAST failing attempt, and is dropped entirely if a later attempt passes', async () => {
  let calls = 0;
  const shots = [];
  const reg = { row: () => ({ id: 'R-10', retries: 2 }) };
  const out = await runScenario('R-10', () => {
    calls++;
    if (calls < 3) throw new Ko(`fail ${calls}`);
  }, {
    registry: () => reg,
    captureEvidence: () => { const shot = `shot-${calls}`; shots.push(shot); return shot; },
  });
  assert.equal(out.result, 'OK');
  // Attempts 1 and 2 failed and each captured a shot; attempt 3 passed and
  // captured none, so the OK result must carry no evidence field at all.
  assert.deepEqual(shots, ['shot-1', 'shot-2']);
  assert.equal('evidence' in out, false);
});

test('reset runs before every attempt, not just the first', async () => {
  // This is what makes a retry a genuine re-run of the row's own setup, not
  // a second look at stale state left behind by the failed attempt.
  let resets = 0, calls = 0;
  const reg = { row: () => ({ id: 'R-11', retries: 1 }) };
  const out = await runScenario('R-11', () => {
    calls++;
    if (calls === 1) throw new Ko('flake');
  }, { registry: () => reg, reset: () => { resets++; } });
  assert.equal(out.result, 'OK');
  assert.equal(resets, 2);
});

test('retry_delay_ms backs off linearly across attempts', async () => {
  let calls = 0;
  const reg = { row: () => ({ id: 'R-12', retries: 2, retry_delay_ms: 20 }) };
  const started = Date.now();
  const out = await runScenario('R-12', () => {
    calls++;
    if (calls < 3) throw new Ko('flake');
  }, { registry: () => reg });
  const elapsed = Date.now() - started;
  assert.equal(out.result, 'OK');
  // Two delays: 20ms before attempt 2 and 40ms before attempt 3, so at least
  // ~60ms in total, with slack for scheduler jitter.
  assert.ok(elapsed >= 55, `expected at least ~60ms of backoff, got ${elapsed}ms`);
});

test('scenario captures every service log slice on a failing attempt only, into the evidence dir', async () => {
  const dirs = [];
  const reg = { row: () => ({ id: 'L-01', retries: 1 }) };
  let calls = 0;
  const out = await runScenario('L-01', () => {
    calls++;
    if (calls === 1) throw new Ko('first attempt fails');
  }, {
    registry: () => reg,
    captureServerLogs: (r, dir) => { assert.equal(r, reg); dirs.push(dir); },
  });
  assert.equal(out.result, 'OK');
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /L-01/);
});

test('a throwing log capture never changes the verdict', async () => {
  const reg = { row: () => ({ id: 'L-02' }) };
  const out = await runScenario('L-02', () => { throw new Blocked('env down'); }, {
    registry: () => reg,
    captureServerLogs: () => { throw new Error('capture failed'); },
  });
  assert.equal(out.result, 'BLOCKED');
});
