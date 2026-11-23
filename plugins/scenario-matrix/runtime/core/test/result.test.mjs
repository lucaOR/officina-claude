import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT, buildResult, exitCodeFor, evidenceDir, ndjson } from '../result.mjs';
import { __setConfigForTest } from '../config.mjs';
import { Ko, Blocked, Inconclusive, fail, blocked, inconclusive } from '../scenario.mjs';

// Where a probe's evidence lands depends on the project's runsDir, so the
// expectation is derived from the same function the wrapper uses.
const EVID = id => evidenceDir('probe', id, '2026-07-29');

test('exitCodeFor maps every contract result', () => {
  assert.equal(exitCodeFor('OK'), EXIT.OK);
  assert.equal(exitCodeFor('KO'), EXIT.KO);
  assert.equal(exitCodeFor('INCONCLUSIVE'), EXIT.INCONCLUSIVE);
  assert.equal(exitCodeFor('STALE'), EXIT.STALE);
  assert.equal(exitCodeFor('BLOCKED'), EXIT.BLOCKED);
  assert.throws(() => exitCodeFor('MAYBE'), /unknown result/);
});

test('buildResult keeps only contract keys and drops empty evidence', () => {
  const r = buildResult({ id: 'A-01', result: 'KO', why: 'got 2', ms: 4100 });
  assert.deepEqual(Object.keys(r).sort(), ['id', 'ms', 'result', 'why']);
});

test('buildResult adds attempts only when a retry happened', () => {
  assert.equal('attempts' in buildResult({ id: 'A-01', result: 'OK', ms: 1, attempts: 1 }), false);
  assert.equal(buildResult({ id: 'A-01', result: 'OK', ms: 1, attempts: 2 }).attempts, 2);
});

test('ndjson is a single line', () => {
  const line = ndjson(buildResult({ id: 'A-01', result: 'OK', ms: 10 }));
  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line).id, 'A-01');
});

test('evidenceDir is date-scoped under the configured runs directory', (t) => {
  t.after(__setConfigForTest({ runsDir: 'docs/scenario-runs' }));
  assert.equal(evidenceDir('demo', 'A-01', '2026-07-29'), 'docs/scenario-runs/demo/2026-07-29/A-01');
});

test('evidenceDir follows a custom runsDir', (t) => {
  t.after(__setConfigForTest({ runsDir: 'out/runs' }));
  assert.equal(evidenceDir('demo', 'A-01', '2026-07-29'), 'out/runs/demo/2026-07-29/A-01');
});

test('fail/blocked/inconclusive throw the matching throwable class carrying the given message', () => {
  assert.throws(() => fail('nope'), err => err instanceof Ko && err.message === 'nope');
  assert.throws(() => blocked('env down'), err => err instanceof Blocked && err.message === 'env down');
  assert.throws(() => inconclusive('subjective'), err => err instanceof Inconclusive && err.message === 'subjective');
  // cross-check: each helper's throwable is NOT one of the other two classes
  assert.throws(() => fail('x'), err => !(err instanceof Blocked) && !(err instanceof Inconclusive));
});

function runProbe(body) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-probe-'));
  const file = join(dir, 'probe.mjs');
  writeFileSync(file, body);
  // spawnSync (unlike execFileSync) never throws on a non-zero exit code —
  // it just reports status/stdout/stderr uniformly, which lets tests below
  // inspect stderr directly (e.g. to prove no TypeError crashed the probe).
  const { status, stdout, stderr } = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  return { code: status, out: stdout, err: stderr };
}

test('a Ko throw exits 1, captures evidence, and prints one JSON line', () => {
  const { code, out } = runProbe(`
    import { scenario, fail } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-01', async () => fail('diverged'), {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
      captureEvidence: async (_c, dir) => dir,
      today: () => '2026-07-29',
    });
  `);
  const last = JSON.parse(out.trim().split('\n').pop());
  assert.equal(code, 1);
  assert.equal(last.result, 'KO');
  assert.equal(last.evidence, EVID('X-01'));
});

test('an Inconclusive throw exits 2 and captures no evidence', () => {
  const { code, out } = runProbe(`
    import { scenario, inconclusive } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-02', async () => inconclusive('subjective UX'), {
      epic: 'probe', registry: () => ({ row: () => ({}) }),
      captureEvidence: async () => 'should-not-be-called',
    });
  `);
  const last = JSON.parse(out.trim().split('\n').pop());
  assert.equal(code, 2);
  assert.equal(last.result, 'INCONCLUSIVE');
  assert.equal('evidence' in last, false);
});

// BLOCKED captures evidence too, and this is not a nicety: assertMarker()
// throws Blocked, and it is the gate every browser scenario passes through, so
// a failed login — the commonest browser failure there is — arrives as a
// BLOCKED. Capturing only on KO left exactly that case with an empty evidence
// directory, at the one moment a screenshot answers the question.
test('a Blocked throw exits 4 and still captures evidence', () => {
  const { code, out } = runProbe(`
    import { scenario, blocked } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-03', async () => blocked('env unreachable'), {
      epic: 'probe', registry: () => ({ row: () => ({}) }),
      captureEvidence: async (_c, dir) => dir,
      today: () => '2026-07-29',
    });
  `);
  const last = JSON.parse(out.trim().split('\n').pop());
  assert.equal(code, 4);
  assert.equal(last.result, 'BLOCKED');
  assert.equal(last.why, 'env unreachable');
  assert.equal(last.evidence, EVID('X-03'));
});

// The other two non-OK outcomes deliberately do NOT capture: neither reached
// the environment in a state worth photographing, and a screenshot of a page
// that was never driven is noise in the run directory.
test('STALE captures no evidence', () => {
  const { code, out } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-15', async () => {}, {
      epic: 'probe',
      compiledFrom: 'deadbeefdead',
      registry: () => ({ row: () => ({ id: 'X-15' }) }),
      captureEvidence: async () => 'should-not-be-called',
    });
  `);
  const last = JSON.parse(out.trim().split('\n').pop());
  assert.equal(code, 3);
  assert.equal(last.result, 'STALE');
  assert.equal('evidence' in last, false);
});

test('a plain unexpected Error (not one of the three throwables) still exits 1 as KO, never a silent pass', () => {
  const { code, out } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-04', async () => { throw new Error('boom'); }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
      captureEvidence: async (_c, dir) => dir,
      today: () => '2026-07-29',
    });
  `);
  const last = JSON.parse(out.trim().split('\n').pop());
  assert.equal(code, 1);
  assert.equal(last.result, 'KO');
  assert.equal(last.why, 'boom');
  assert.equal(last.evidence, EVID('X-04'));
});

test('a passing fn exits 0 with a clean OK result (no why, no evidence)', () => {
  const { code, out } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-05', async () => {}, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
    });
  `);
  const last = JSON.parse(out.trim());
  assert.equal(code, 0);
  assert.equal(last.result, 'OK');
  assert.equal('why' in last, false);
  assert.equal('evidence' in last, false);
});

test('cleanups run on the OK path, in reverse registration order, and the result line is still last', () => {
  const { code, out } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-06', async ctx => {
      ctx.cleanups.push(async () => console.log('cleanup:A'));
      ctx.cleanups.push(async () => console.log('cleanup:B'));
    }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
    });
  `);
  const lines = out.trim().split('\n');
  assert.equal(code, 0);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(0, 2), ['cleanup:B', 'cleanup:A']);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.result, 'OK');
});

test('on the KO path, captureEvidence runs before cleanups, cleanups still run, and the result line is still last', () => {
  const { code, out } = runProbe(`
    import { scenario, fail } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-07', async ctx => {
      ctx.cleanups.push(async () => console.log('cleanup-ran'));
      fail('diverged');
    }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
      captureEvidence: async (_c, dir) => { console.log('evidence-captured'); return dir; },
      today: () => '2026-07-29',
    });
  `);
  const lines = out.trim().split('\n');
  assert.equal(code, 1);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(0, 2), ['evidence-captured', 'cleanup-ran']);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.result, 'KO');
  assert.equal(last.evidence, EVID('X-07'));
});

test('a throwing cleanup does not stop the remaining cleanups and does not change the exit code', () => {
  const { code, out } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-08', async ctx => {
      ctx.cleanups.push(async () => console.log('first-registered-ran'));
      ctx.cleanups.push(async () => { throw new Error('cleanup blew up'); });
      ctx.cleanups.push(async () => console.log('last-registered-ran'));
    }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
    });
  `);
  const lines = out.trim().split('\n');
  assert.equal(code, 0);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(0, 2), ['last-registered-ran', 'first-registered-ran']);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.result, 'OK');
});

test('cleanups also run on BLOCKED and INCONCLUSIVE exits', () => {
  const blockedRun = runProbe(`
    import { scenario, blocked } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-09', async ctx => {
      ctx.cleanups.push(async () => console.log('cleanup-ran'));
      blocked('env down');
    }, { epic: 'probe', registry: () => ({ row: () => ({}) }) });
  `);
  const blockedLines = blockedRun.out.trim().split('\n');
  assert.equal(blockedRun.code, 4);
  assert.equal(blockedLines[0], 'cleanup-ran');
  assert.equal(JSON.parse(blockedLines[blockedLines.length - 1]).result, 'BLOCKED');

  const inconclusiveRun = runProbe(`
    import { scenario, inconclusive } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-10', async ctx => {
      ctx.cleanups.push(async () => console.log('cleanup-ran'));
      inconclusive('subjective UX');
    }, { epic: 'probe', registry: () => ({ row: () => ({}) }) });
  `);
  const inconclusiveLines = inconclusiveRun.out.trim().split('\n');
  assert.equal(inconclusiveRun.code, 2);
  assert.equal(inconclusiveLines[0], 'cleanup-ran');
  assert.equal(JSON.parse(inconclusiveLines[inconclusiveLines.length - 1]).result, 'INCONCLUSIVE');
});

test('a plain synchronous cleanup returning undefined does not crash the wrapper and the result line is still emitted', () => {
  const { code, out, err } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-11', async ctx => {
      ctx.cleanups.push(() => console.log('sync-cleanup-ran'));
    }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
    });
  `);
  assert.equal(err.includes('TypeError'), false);
  assert.equal(code, 0);
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'sync-cleanup-ran');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.result, 'OK');
});

test('a synchronous cleanup that throws does not stop the remaining cleanups and does not change the exit code', () => {
  const { code, out, err } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-12', async ctx => {
      ctx.cleanups.push(() => console.log('first-registered-ran'));
      ctx.cleanups.push(() => { throw new Error('sync cleanup blew up'); });
      ctx.cleanups.push(() => console.log('last-registered-ran'));
    }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
    });
  `);
  assert.equal(err.includes('TypeError'), false);
  assert.equal(code, 0);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.slice(0, 2), ['last-registered-ran', 'first-registered-ran']);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.result, 'OK');
});

test('a mix of synchronous and async cleanups in one scenario all run, in reverse registration order', () => {
  const { code, out, err } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-13', async ctx => {
      ctx.cleanups.push(() => console.log('sync-1'));
      ctx.cleanups.push(async () => console.log('async-1'));
      ctx.cleanups.push(() => console.log('sync-2'));
    }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
    });
  `);
  assert.equal(err.includes('TypeError'), false);
  assert.equal(code, 0);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.slice(0, 3), ['sync-2', 'async-1', 'sync-1']);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.result, 'OK');
});

test('a non-async captureEvidence on the KO path does not crash the wrapper and the result line is still emitted', () => {
  const { code, out, err } = runProbe(`
    import { scenario, fail } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-14', async () => fail('diverged'), {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
      captureEvidence: (_c, dir) => dir,
      today: () => '2026-07-29',
    });
  `);
  assert.equal(err.includes('TypeError'), false);
  assert.equal(code, 1);
  const last = JSON.parse(out.trim().split('\n').pop());
  assert.equal(last.result, 'KO');
  assert.equal(last.evidence, EVID('X-14'));
});

// `throw 'boom'` is legal JS: err.message is undefined, buildResult() drops an
// undefined `why`, and the run then reports a KO with no explanation at all.
test('a non-Error throw still carries a why, rather than a KO with no explanation', () => {
  const { code, out } = runProbe(`
    import { scenario } from '${import.meta.dirname}/../scenario.mjs';
    await scenario('X-16', async () => { throw 'boom'; }, {
      epic: 'probe',
      registry: () => ({ row: () => ({}) }),
    });
  `);
  const last = JSON.parse(out.trim().split('\n').pop());
  assert.equal(code, 1);
  assert.equal(last.result, 'KO');
  assert.equal(last.why, 'boom');
});

test('EXIT carries SKIPPED as 5, distinct from every other outcome', () => {
  assert.equal(EXIT.SKIPPED, 5);
  assert.equal(exitCodeFor('SKIPPED'), 5);
  // A duplicated code would make two outcomes indistinguishable to the shell.
  const codes = Object.values(EXIT);
  assert.equal(new Set(codes).size, codes.length);
});
