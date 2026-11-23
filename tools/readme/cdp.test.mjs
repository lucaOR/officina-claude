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

function onPath(dir, name, mode = 0o755) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, mode);
  return p;
}

test('findChrome finds the headless shell in the Linux arm64 and macOS Playwright layouts', () => withTmp((dir) => {
  for (const [cache, sub] of [
    [['.cache'], 'chrome-headless-shell-linux-arm64'],
    [['Library', 'Caches'], 'chrome-headless-shell-mac-arm64'],
    [['Library', 'Caches'], 'chrome-headless-shell-mac-x64'],
  ]) {
    const home = path.join(dir, sub);
    const p = path.join(home, ...cache, 'ms-playwright', 'chromium_headless_shell-1254', sub, 'chrome-headless-shell');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    assert.equal(findChrome({}, home), p, sub);
  }
}));

test('findChrome falls back to a browser on PATH, in a fixed order of names', () => withTmp((dir) => {
  const first = path.join(dir, 'first');
  const second = path.join(dir, 'second');
  onPath(first, 'google-chrome-stable');
  const chromium = onPath(second, 'chromium');
  const PATH = [first, second].join(path.delimiter);
  assert.equal(findChrome({ PATH }, path.join(dir, 'home')), chromium);
  fs.rmSync(chromium);
  assert.equal(findChrome({ PATH }, path.join(dir, 'home')), path.join(first, 'google-chrome-stable'));
}));

test('findChrome skips a browser name on PATH that is not an executable file', () => withTmp((dir) => {
  const bin = path.join(dir, 'bin');
  onPath(bin, 'chromium', 0o644);
  fs.mkdirSync(path.join(bin, 'chromium-browser'));
  const chrome = onPath(bin, 'google-chrome');
  assert.equal(findChrome({ PATH: bin }, path.join(dir, 'home')), chrome);
}));

test('findChrome prefers the Playwright headless shell to a browser on PATH', () => withTmp((dir) => {
  onPath(path.join(dir, 'bin'), 'chromium');
  const shell = fakeShell(dir, 1254);
  assert.equal(findChrome({ PATH: path.join(dir, 'bin') }, dir), shell);
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

// Runs fn with these variables set in this process's environment, then restores them.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('Chromium starts with a US English locale and hidden scrollbars', () => withTmp(async (dir) => {
  const dump = path.join(dir, 'dump');
  const chrome = fakeChrome(dir, `printf '%s\\n' "$@" > "${dump}.args"; env > "${dump}.env"; exit 1`);
  await withEnv({ LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' }, () => assert.rejects(openBrowser(chrome)));
  assert.ok(fs.readFileSync(`${dump}.args`, 'utf8').split('\n').includes('--hide-scrollbars'));
  const env = fs.readFileSync(`${dump}.env`, 'utf8').split('\n');
  for (const line of ['LANG=en_US.UTF-8', 'LC_ALL=en_US.UTF-8', 'LANGUAGE=en_US']) assert.ok(env.includes(line), line);
}));

test('a page sees US English whatever the caller\'s locale', { skip: !findChrome() }, () => withTmp(async (dir) => {
  // Under de_DE, Chromium reports "de" and draws the dashboard's date inputs as 01.10.2026.
  await withEnv({ LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' }, async () => {
    const browser = await openBrowser(findChrome());
    try {
      const value = await browser.shot('data:text/html,<p>hi', {
        out: path.join(dir, 'x.webp'), width: 320, height: 200,
        prepare: 'navigator.language + " " + Intl.DateTimeFormat().resolvedOptions().locale',
      });
      assert.equal(value, 'en-US en-US');
    } finally { await browser.close(); }
  });
}));

test('a second shot of the same page reloads it under the new colour scheme', { skip: !findChrome() }, () => withTmp(async (dir) => {
  // The page records the colour scheme it loaded under, as the dashboard does when it draws.
  const page = path.join(dir, 'p.html');
  fs.writeFileSync(page, '<script>document.title = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"</script>');
  const url = `file://${page}#part`;
  const browser = await openBrowser(findChrome());
  try {
    const opts = { width: 320, height: 200, timeout: 5000, prepare: 'document.title' };
    assert.equal(await browser.shot(url, { ...opts, out: path.join(dir, 'a.webp') }), 'light');
    assert.equal(await browser.shot(url, { ...opts, out: path.join(dir, 'b.webp'), dark: true }), 'dark');
  } finally { await browser.close(); }
}));
