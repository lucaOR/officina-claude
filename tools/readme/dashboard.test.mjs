import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeDemoTranscripts } from './transcripts.mjs';
import { buildDemoDashboard } from './dashboard.mjs';

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-dash-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('same seed writes identical transcripts', () => withTmp((tmp) => {
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const idsA = writeDemoTranscripts(a);
  const idsB = writeDemoTranscripts(b);
  assert.deepEqual(idsA, idsB);
  assert.ok(idsA.length > 0);
  for (const id of idsA) {
    assert.ok(fs.readFileSync(path.join(a, `${id}.jsonl`)).equals(fs.readFileSync(path.join(b, `${id}.jsonl`))), id);
  }
}));

test('the hook records one session row per demo transcript inside the work dir', () => withTmp(async (tmp) => {
  const file = await buildDemoDashboard(tmp);
  const ids = fs.readdirSync(path.join(tmp, 'home', '.claude', 'projects', '-demo-bookshop')).filter((f) => f.endsWith('.jsonl'));
  const lines = fs.readFileSync(path.join(tmp, 'home', '.claude', 'metrics', 'sessions.v4.csv'), 'utf8').trim().split('\n');
  assert.equal(lines.length - 1, ids.length);
  assert.ok(fs.statSync(file).size > 10 * 1024);
}));

const here = path.dirname(fileURLToPath(import.meta.url));

// Builds the demo dashboard in a child process with this environment, and returns its HTML
// without the generation time, which moves from minute to minute.
function buildIn(dir, env) {
  const mod = JSON.stringify(pathToFileURL(path.join(here, 'dashboard.mjs')).href);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { buildDemoDashboard } from ${mod}; process.stdout.write(await buildDemoDashboard(${JSON.stringify(dir)}));`,
  ], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(r.stdout, 'utf8').replace(/"generatedAt":"[^"]*"/, '');
}

test('the demo dashboard ignores the caller\'s timezone and METRICS_ settings', () => withTmp((tmp) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('METRICS_')));
  const plain = buildIn(path.join(tmp, 'plain'), { ...clean, TZ: 'UTC' });
  const odd = buildIn(path.join(tmp, 'odd'), {
    ...clean, TZ: 'Pacific/Kiritimati',
    METRICS_BREAK_MIN_CC: '1', METRICS_TTL_GAP_MIN: '1', METRICS_GROWTH_READ_RATIO: '0.1', METRICS_GROWTH_MIN_DROP: '1',
    METRICS_TURN_DUR_TOL_S: '0', METRICS_TURN_INV_TOL_MS: '0', METRICS_QUEUED_MS: '1',
  });
  assert.ok(plain === odd, 'the dashboard changed with the caller\'s environment');
}));
