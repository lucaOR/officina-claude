import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-shots-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// No Chromium can be found: HOME has no Playwright cache and PATH holds no browser.
function noBrowser(dir, extra = {}) {
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  return { HOME: home, PATH: bin, ...extra };
}

test('shots exits 1 naming CHROME when no browser is found', () => withTmp((dir) => {
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'readme', 'shots.mjs')], {
    encoding: 'utf8',
    env: noBrowser(dir, { CHROME: '/nonexistent' }),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHROME/);
}));

test('shots run through a symlinked repo path still runs, and fails with no browser', () => withTmp((dir) => {
  const link = path.join(dir, 'repo');
  fs.symlinkSync(root, link);
  const r = spawnSync(process.execPath, [path.join(link, 'tools', 'readme', 'shots.mjs')], {
    encoding: 'utf8',
    env: noBrowser(dir),
  });
  assert.notEqual(r.status, 0, `exited ${r.status} with stdout ${JSON.stringify(r.stdout)}`);
  assert.match(r.stderr, /CHROME/);
}));

const assetsDir = path.join(root, '.github', 'assets');
const stamp = () => Object.fromEntries(fs.readdirSync(assetsDir).map((f) => [f, fs.statSync(path.join(assetsDir, f)).mtimeMs]));

test('a broken CHROME fails with a clear message before any image is written', () => withTmp((dir) => {
  const chrome = path.join(dir, 'chrome');
  fs.writeFileSync(chrome, 'not a program');
  const before = stamp();
  const r = spawnSync(process.execPath, [path.join(root, 'tools', 'readme', 'shots.mjs')], {
    encoding: 'utf8',
    env: noBrowser(dir, { CHROME: chrome }),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not start Chromium/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'printed a stack trace');
  assert.deepEqual(stamp(), before, 'files under .github/assets changed');
}));
