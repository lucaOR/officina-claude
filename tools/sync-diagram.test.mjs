import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sync, check, syncDoc, checkDoc, SOURCE, TARGET, DOC_SOURCE, MANIFEST } from './sync-diagram.mjs';

const TOOL = fileURLToPath(new URL('./sync-diagram.mjs', import.meta.url));
const roots = [];
const temp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-diagram-')); roots.push(r); return path.join(r, 'copy'); };
after(() => roots.forEach(r => fs.rmSync(r, { recursive: true, force: true })));

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

test('a missing or empty source throws and leaves the target alone', () => {
  const t = temp();
  sync(SOURCE, t);
  const before = fs.readFileSync(path.join(t, 'index.mjs'));
  const empty = temp();
  fs.mkdirSync(empty);
  assert.throws(() => sync(path.join(empty, 'nope'), t), /not found/);
  assert.throws(() => sync(empty, t), /no \.mjs files/);
  assert.throws(() => check(path.join(empty, 'nope'), t), /not found/);
  assert.deepEqual(fs.readFileSync(path.join(t, 'index.mjs')), before);
  assert.deepEqual(check(SOURCE, t), []);
});

test('the CLI exits 2 on a missing source and keeps the target', () => {
  const t = temp();
  sync(SOURCE, t);
  const r = spawnSync(process.execPath, [TOOL, `--source=${t}-nope`, `--target=${t}`], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not found/);
  assert.deepEqual(check(SOURCE, t), []);
});

test('sync refuses to replace a non-empty directory that is not a generated copy', () => {
  const t = temp();
  fs.mkdirSync(t);
  fs.writeFileSync(path.join(t, 'precious.txt'), 'keep');
  assert.throws(() => sync(SOURCE, t), /refusing/);
  assert.equal(fs.readFileSync(path.join(t, 'precious.txt'), 'utf8'), 'keep');
});

test('sync leaves no temp sibling behind', () => {
  const t = temp();
  sync(SOURCE, t);
  assert.deepEqual(fs.readdirSync(path.dirname(t)), ['copy']);
});

test('the rows reference syncs byte for byte and drift is detected', () => {
  const doc = `${temp()}-rows.md`;
  syncDoc(DOC_SOURCE, doc);
  assert.deepEqual(checkDoc(DOC_SOURCE, doc), []);
  assert.deepEqual(fs.readFileSync(doc), fs.readFileSync(DOC_SOURCE));
  fs.appendFileSync(doc, 'x');
  assert.match(checkDoc(DOC_SOURCE, doc)[0], /differs/);
  fs.rmSync(doc);
  assert.match(checkDoc(DOC_SOURCE, doc)[0], /missing/);
  fs.symlinkSync(DOC_SOURCE, doc);
  assert.match(checkDoc(DOC_SOURCE, doc)[0], /symlink/);
});

test('the CLI --check reports a drifted rows reference and exits 1', () => {
  const t = temp();
  const doc = `${t}-rows.md`;
  syncDoc(DOC_SOURCE, doc);
  fs.appendFileSync(doc, 'x');
  sync(SOURCE, t);
  const r = spawnSync(process.execPath, [TOOL, '--check', `--target=${t}`, `--rows-target=${doc}`], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /-rows\.md: differs/);
});
