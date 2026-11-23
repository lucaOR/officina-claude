import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
