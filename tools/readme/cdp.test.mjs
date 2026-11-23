import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { findChrome, openBrowser } from './cdp.mjs';

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-cdp-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for Chromium: a shell script that runs `body` with $profile set to its --user-data-dir.
function fakeChrome(dir, body) {
  const p = path.join(dir, 'fake-chrome');
  fs.writeFileSync(p, `#!/bin/sh\nfor a in "$@"; do case "$a" in --user-data-dir=*) profile="\${a#--user-data-dir=}";; esac; done\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

test('openBrowser on a directory fails with a clear message', () => withTmp(async (dir) => {
  await assert.rejects(openBrowser(dir), (e) => /could not start/.test(e.message) && e.message.includes(dir));
}));

test('openBrowser on a file that is not executable fails with a clear message', () => withTmp(async (dir) => {
  const p = path.join(dir, 'chrome');
  fs.writeFileSync(p, 'not a program');
  await assert.rejects(openBrowser(p), (e) => /could not start/.test(e.message) && /EACCES/.test(e.message));
}));

test('a Chromium that exits at once fails fast and shows the end of its stderr', () => withTmp(async (dir) => {
  const chrome = fakeChrome(dir, 'echo "missing libnss3.so" >&2; exit 3');
  const started = Date.now();
  await assert.rejects(openBrowser(chrome), (e) => /exited/.test(e.message) && e.message.includes('missing libnss3.so'));
  assert.ok(Date.now() - started < 5000, 'it waited for a port from a process that had exited');
}));

test('a Chromium that reports no port fails with its stderr, and close waits for its exit', () => withTmp(async (dir) => {
  const seen = path.join(dir, 'profile-path');
  // On SIGTERM it takes a moment and writes into its profile, as Chromium does while it shuts down.
  const chrome = fakeChrome(dir, `echo "$profile" > "${seen}"; echo "no usable display" >&2
trap 'sleep 0.3; mkdir -p "$profile"; touch "$profile/late"; exit 0' TERM
sleep 30 & wait $!`);
  await assert.rejects(openBrowser(chrome, { startTimeout: 500 }), (e) => /DevTools port/.test(e.message) && e.message.includes('no usable display'));
  const profile = fs.readFileSync(seen, 'utf8').trim();
  await sleep(800);
  assert.equal(fs.existsSync(profile), false, 'the profile came back after close removed it');
}));

test('a page that fails to load throws and writes no file', { skip: !findChrome() }, () => withTmp(async (dir) => {
  const browser = await openBrowser(findChrome());
  try {
    const out = path.join(dir, 'x.webp');
    await assert.rejects(browser.shot(`file://${path.join(dir, 'missing.html')}`, { out, width: 320, height: 200 }), /ERR_FILE_NOT_FOUND/);
    assert.equal(fs.existsSync(out), false);
  } finally { await browser.close(); }
}));

test('a page whose load event never fires times out', { skip: !findChrome(), timeout: 20000 }, () => withTmp(async (dir) => {
  // The page waits for an image the server never sends, so its load event never fires.
  const server = http.createServer((req, res) => {
    if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end('<img src="/never">');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await openBrowser(findChrome());
  try {
    const out = path.join(dir, 'x.webp');
    const url = `http://127.0.0.1:${server.address().port}/`;
    await assert.rejects(browser.shot(url, { out, width: 320, height: 200, timeout: 1000 }), /load/);
    assert.equal(fs.existsSync(out), false);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
}));

test('a prepare script runs in the loaded page before the screenshot, and its value comes back', { skip: !findChrome() }, () => withTmp(async (dir) => {
  const browser = await openBrowser(findChrome());
  try {
    const out = path.join(dir, 'x.webp');
    const value = await browser.shot('data:text/html,<title>before</title><p>hi', {
      out, width: 320, height: 200,
      prepare: 'new Promise((r) => requestAnimationFrame(() => r(document.title + "/" + innerWidth)))',
    });
    assert.equal(value, 'before/320');
    assert.ok(fs.existsSync(out));
  } finally { await browser.close(); }
}));

test('a prepare script that throws fails the shot and writes no file', { skip: !findChrome() }, () => withTmp(async (dir) => {
  const browser = await openBrowser(findChrome());
  try {
    const out = path.join(dir, 'x.webp');
    await assert.rejects(browser.shot('data:text/html,<p>hi', {
      out, width: 320, height: 200, prepare: 'document.getElementById("missing").click()',
    }), /prepare script failed/);
    assert.equal(fs.existsSync(out), false);
  } finally { await browser.close(); }
}));
