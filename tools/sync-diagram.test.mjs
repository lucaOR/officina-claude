import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sync, check, SOURCE, TARGET, MANIFEST } from './sync-diagram.mjs';

const TOOL = fileURLToPath(new URL('./sync-diagram.mjs', import.meta.url));
const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-diagram-')), 'copy');

test('a fresh sync checks clean and holds every source file plus a manifest', () => {
  const t = temp();
  sync(SOURCE, t);
  assert.deepEqual(check(SOURCE, t), []);
  for (const f of fs.readdirSync(SOURCE).filter(f => f.endsWith('.mjs'))) assert.ok(fs.existsSync(path.join(t, f)), f);
  assert.match(JSON.parse(fs.readFileSync(path.join(t, MANIFEST), 'utf8')).sha256, /^[0-9a-f]{64}$/);
});

test('an edited copy fails the check and names the file', () => {
  const t = temp();
  sync(SOURCE, t);
  fs.appendFileSync(path.join(t, 'index.mjs'), '//x');
  const problems = check(SOURCE, t);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^index\.mjs/);
});

test('the CLI exits 1 on drift and names the drifted file', () => {
  const t = temp();
  sync(SOURCE, t);
  const run = () => spawnSync(process.execPath, [TOOL, '--check', `--target=${t}`], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(run().status, 0);
  fs.appendFileSync(path.join(t, 'rows.mjs'), '//x');
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rows\.mjs: differs/);
});

test('a missing file fails the check', () => {
  const t = temp();
  sync(SOURCE, t);
  fs.rmSync(path.join(t, 'tree.mjs'));
  assert.match(check(SOURCE, t).join('\n'), /tree\.mjs: missing/);
});

test('a stale extra file fails the check', () => {
  const t = temp();
  sync(SOURCE, t);
  fs.writeFileSync(path.join(t, 'old.mjs'), '');
  assert.match(check(SOURCE, t).join('\n'), /old\.mjs: stale/);
});

test('a tampered manifest fails the check', () => {
  const t = temp();
  sync(SOURCE, t);
  fs.writeFileSync(path.join(t, MANIFEST), '{}\n');
  assert.match(check(SOURCE, t).join('\n'), new RegExp(MANIFEST));
});

test('the CLI --check passes on the committed copy, from any cwd', () => {
  const r = spawnSync(process.execPath, [TOOL, '--check'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(check(SOURCE, TARGET), []);
});
