import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logs, noLog, captureLogs, mail, mailCount, mailMessage, stub, scnFetch, markLogSlice } from '../observe.mjs';
import { __setForTest } from '../ext.mjs';
import { Ko, Blocked } from '../errors.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A fake adapter that provides one log source kind.
function withFake(t, { read, capture }) {
  t.after(__setForTest({
    adapters: { fake: { drivers: { 'logSource.fake': { read, capture } } } },
    providers: {},
  }));
}

const fakeReg = (sources) => ({
  logSourceNames: () => Object.keys(sources),
  logSource: (s) => {
    if (!sources[s]) throw new Blocked(`unknown log source: ${s}`);
    return sources[s];
  },
});

function writeLog(dir, service, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${service}.log`), text);
}

test('logs dispatches to the driver for the source kind', async (t) => {
  const seen = [];
  withFake(t, { read: async (reg, src, opts) => { seen.push({ src, opts }); return 'one\n\ntwo\nthree\n'; } });
  const reg = fakeReg({ api: { kind: 'fake', where: 'x' } });
  const marker = () => 'untouched';
  assert.deepEqual(await logs(reg, 'api', { run: marker }), ['one', 'two', 'three']);
  assert.equal(seen[0].src.where, 'x');
  assert.equal(seen[0].src.service, 'api', 'read receives the service name, as capture does');
  assert.equal(seen[0].opts.run, marker, 'opts pass through to the driver untouched');
});

test('logs filters lines by a grep pattern, string or RegExp', async (t) => {
  withFake(t, { read: async () => 'alpha 1\nbeta 2\nalpha 3\n' });
  const reg = fakeReg({ api: { kind: 'fake' } });
  assert.deepEqual(await logs(reg, 'api', { grep: 'alpha' }), ['alpha 1', 'alpha 3']);
  assert.deepEqual(await logs(reg, 'api', { grep: /beta \d/ }), ['beta 2']);
});

test('logs returns [] for a source that is present but empty', async (t) => {
  withFake(t, { read: async () => '' });
  assert.deepEqual(await logs(fakeReg({ api: { kind: 'fake' } }), 'api'), []);
});

test('logs surfaces a driver read failure, and the registry lookup failure', async (t) => {
  withFake(t, { read: async () => { throw new Blocked('no file'); } });
  const reg = fakeReg({ api: { kind: 'fake' } });
  await assert.rejects(() => logs(reg, 'api'), Blocked);
  await assert.rejects(() => logs(reg, 'missing'), /unknown log source/);
});

test('a facade with no driver throws Blocked naming the adapter to add', async (t) => {
  t.after(__setForTest({ adapters: {}, providers: {
    stub: ['stubby'], mail: ['mailer', 'other'], 'logSource.pipe': ['piper'],
  } }));
  const reg = fakeReg({ api: { kind: 'pipe' } });
  await assert.rejects(async () => stub({}, 'x'), err => err instanceof Blocked && /needs the stubby adapter/.test(err.message));
  await assert.rejects(async () => mail({}), err => err instanceof Blocked && /needs the mailer adapter \(or other\)/.test(err.message));
  await assert.rejects(() => logs(reg, 'api'), err => err instanceof Blocked && /logSource\.pipe needs the piper adapter/.test(err.message));
  await assert.rejects(async () => mailCount({}), Blocked);
  await assert.rejects(async () => mailMessage({}, 'a'), Blocked);
});

test('mail, mailCount, mailMessage and stub forward every argument to their driver', async (t) => {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, args]); return `${name}-result`; };
  t.after(__setForTest({
    adapters: { fake: { drivers: { mail: rec('mail'), mailCount: rec('mailCount'), mailMessage: rec('mailMessage'), stub: rec('stub') } } },
    providers: {},
  }));
  const reg = {};
  const opts = { run() {} };
  assert.equal(await mail(reg, { to: 'a' }, opts), 'mail-result');
  assert.equal(await mailCount(reg, opts), 'mailCount-result');
  assert.equal(await mailMessage(reg, 'id1', opts), 'mailMessage-result');
  assert.equal(stub(reg, 'one'), 'stub-result');
  assert.deepEqual(calls.map(c => c[0]), ['mail', 'mailCount', 'mailMessage', 'stub']);
  assert.deepEqual(calls[0][1], [reg, { to: 'a' }, opts]);
  assert.deepEqual(calls[2][1], [reg, 'id1', opts]);
  assert.deepEqual(calls[3][1], [reg, 'one']);
});

test('noLog throws Ko when the pattern matches the slice, and resolves silently when none does', async (t) => {
  withFake(t, { read: async () => 'ok line\nERROR boom\n' });
  const reg = fakeReg({ api: { kind: 'fake' } });
  await assert.rejects(
    () => noLog(reg, 'api', /ERROR/),
    err => err instanceof Ko && /expected no log line matching \/ERROR\/, got 1: ERROR boom/.test(err.message),
  );
  await noLog(reg, 'api', 'absent');
});

test('noLog surfaces a driver failure as an error, not a vacuous pass', async (t) => {
  withFake(t, { read: async () => { throw new Blocked('no log to read'); } });
  await assert.rejects(() => noLog(fakeReg({ api: { kind: 'fake' } }), 'api', /x/), Blocked);
});

test('captureLogs writes one file per log source and survives a failing driver', async (t) => {
  markLogSlice(Date.UTC(2026, 0, 1));
  const captured = [];
  withFake(t, {
    read: async () => '',
    capture: async (reg, src, dir, opts) => {
      captured.push({ src, dir, opts });
      if (src.broken) throw new Blocked('source went away\nsecond line');
      writeLog(dir, src.service, src.text);
    },
  });
  const reg = fakeReg({
    api: { kind: 'fake', text: 'a line\n' },
    worker: { kind: 'fake', text: 'w1\nw2\n' },
    gone: { kind: 'fake', broken: true },
  });
  const dir = mkdtempSync(join(tmpdir(), 'scn-caplogs-'));
  try {
    const seam = () => {};
    const target = await captureLogs(reg, dir, { run: seam });
    assert.equal(target, join(dir, 'logs'));
    assert.equal(captured[0].dir, target);
    assert.equal(readFileSync(join(target, 'api.log'), 'utf8'), 'a line\n');
    assert.equal(readFileSync(join(target, 'worker.log'), 'utf8'), 'w1\nw2\n');
    assert.equal(existsSync(join(target, 'gone.log')), false);
    assert.equal(captured[0].opts.run, seam, 'opts pass through to the driver untouched');
    const index = readFileSync(join(target, '_sources.txt'), 'utf8');
    assert.match(index, /^slice since 2025-12-31T23:59:59\.000Z$/m);
    assert.match(index, /^api\t1 line\(s\)$/m);
    assert.match(index, /^worker\t2 line\(s\)$/m);
    assert.match(index, /^gone\tskipped: source went away$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('captureLogs writes nothing when the registry cannot list its sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-caplogs-'));
  try {
    await assert.rejects(() => captureLogs({}, dir));
    assert.equal(existsSync(join(dir, 'logs')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- scnFetch ---------------------------------------------------------------

async function closedPort() {
  const server = await listen(http.createServer(() => {}));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('scnFetch reports a refused plain-http connection as Blocked, not as a product KO', async () => {
  const port = await closedPort();
  await assert.rejects(
    () => scnFetch(`http://127.0.0.1:${port}/__scn/requests`),
    err => err instanceof Blocked && /did not connect/.test(err.message),
  );
});

test('scnFetch reports a refused https connection as Blocked too', async () => {
  const port = await closedPort();
  await assert.rejects(
    () => scnFetch(`https://127.0.0.1:${port}/v1.0/thing`),
    err => err instanceof Blocked && /did not connect/.test(err.message),
  );
});

test('scnFetch sends caller headers, so a Host override selects the target over plain http', async () => {
  let seen = null;
  const server = await listen(http.createServer((req, res) => {
    seen = req.headers.host;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  }));
  const port = server.address().port;
  try {
    await scnFetch(`http://127.0.0.1:${port}/login`, { headers: { Host: 'app.example.test' } });
    assert.equal(seen, 'app.example.test');
  } finally {
    server.close();
  }
});

test('scnFetch exposes text(), and text() does not spend json()', async () => {
  const server = await listen(http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"tenant":"one"}');
  }));
  const port = server.address().port;
  try {
    const res = await scnFetch(`http://127.0.0.1:${port}/x`);
    assert.equal(await res.text(), '{"tenant":"one"}');
    assert.deepEqual(await res.json(), { tenant: 'one' });
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
  } finally {
    server.close();
  }
});

test('scnFetch sends the method and body, and reports a non-2xx status without rejecting', async () => {
  let seen = null;
  const server = await listen(http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => { seen = { method: req.method, b }; res.writeHead(500); res.end(); });
  }));
  const port = server.address().port;
  try {
    const res = await scnFetch(`http://127.0.0.1:${port}/x`, { method: 'POST', body: 'payload' });
    assert.deepEqual(seen, { method: 'POST', b: 'payload' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
  } finally {
    server.close();
  }
});

test('logs with no driver returns a promise that rejects with Blocked, so .catch() sees it', async (t) => {
  t.after(__setForTest({ adapters: {}, providers: { 'logSource.pipe': ['piper'] } }));
  const p = logs(fakeReg({ api: { kind: 'pipe' } }), 'api');
  assert.ok(p instanceof Promise);
  await assert.rejects(p, Blocked);
  const q = mail({});
  assert.ok(q instanceof Promise);
  await q.catch(() => {});
});

test('stub with no driver throws synchronously, like the synchronous lever it replaces', (t) => {
  t.after(__setForTest({ adapters: {}, providers: { stub: ['stubby'] } }));
  assert.throws(() => stub({}, 'x'), Blocked);
});

test('markLogSlice pulls the mark back one second and returns it as an ISO string', () => {
  assert.equal(markLogSlice(Date.UTC(2026, 5, 1, 12, 0, 5)), '2026-06-01T12:00:04.000Z');
});
