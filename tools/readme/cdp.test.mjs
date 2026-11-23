import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findChrome, openBrowser } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-cdp-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function fakeShell(home, rev) {
  const p = path.join(home, '.cache', 'ms-playwright', `chromium_headless_shell-${rev}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  return p;
}

test('findChrome prefers an existing CHROME', () => withTmp((dir) => {
  const mine = path.join(dir, 'my-chrome');
  fs.writeFileSync(mine, '');
  fakeShell(dir, 1254);
  assert.equal(findChrome({ CHROME: mine }, dir), mine);
}));

test('findChrome picks the newest Playwright headless shell', () => withTmp((dir) => {
  fakeShell(dir, 1228);
  const newest = fakeShell(dir, 1254);
  assert.equal(findChrome({}, dir), newest);
}));

test('findChrome returns null when nothing exists', () => withTmp((dir) => {
  assert.equal(findChrome({ CHROME: path.join(dir, 'missing') }, dir), null);
}));

test('shots exits 1 naming CHROME when no browser is found', () => withTmp((dir) => {
  const r = spawnSync(process.execPath, [path.join(here, 'shots.mjs')], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, CHROME: '/nonexistent' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHROME/);
}));

test('openBrowser captures a webp of the requested size', { skip: !findChrome() }, () => withTmp(async (dir) => {
  const browser = await openBrowser(findChrome());
  try {
    const out = path.join(dir, 'x.webp');
    await browser.shot('data:text/html,<body style="background:red">hi', { out, width: 320, height: 200 });
    const b = fs.readFileSync(out);
    assert.equal(b.toString('latin1', 0, 4), 'RIFF');
    assert.equal(b.toString('latin1', 8, 12), 'WEBP');
    // Chromium wraps the lossy VP8 frame in an extended VP8X header, which holds the canvas size.
    assert.equal(b.toString('latin1', 12, 16), 'VP8X');
    assert.equal(b.readUIntLE(24, 3) + 1, 320);
    assert.equal(b.readUIntLE(27, 3) + 1, 200);
    assert.ok(b.includes('VP8 '), 'expected a lossy VP8 chunk');
  } finally { await browser.close(); }
}));
