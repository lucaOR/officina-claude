import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join } from 'node:path';
import { stubFault } from '../fault.mjs';
import * as stubAdapter from '../adapter-stub.mjs';
import { collectProbes } from '../selftest.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';
import { LIB } from '../paths.mjs';
import { bootStub, freePort } from './support/stub-process.mjs';

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: { stub: stubAdapter }, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const readBody = req => new Promise(resolve => {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => resolve(body));
});

// Serves one canned status and records every request it sees.
async function withServer(status, fn) {
  const seen = [];
  const server = await listen(http.createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, body: await readBody(req) });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(status === 204 ? '' : '{}');
  }));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

test('stubFault(...).fail() POSTs the spec to __scn/fail, normalizing times: Infinity to null', async () => {
  await withServer(204, async (base, seen) => {
    await stubFault({ raw: { stubs: { payments: base } } }, 'payments').fail({ path: '/x' });
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, '/__scn/fail');
    assert.deepEqual(JSON.parse(seen[0].body), { path: '/x', status: 500, times: null });
  });
});

test('stubFault(...).fail() forwards an explicit status and times unchanged', async () => {
  await withServer(204, async (base, seen) => {
    await stubFault({ raw: { stubs: { payments: base } } }, 'payments').fail({ path: '/a/b', status: 503, times: 2 });
    assert.deepEqual(JSON.parse(seen[0].body), { path: '/a/b', status: 503, times: 2 });
  });
});

test('stubFault(...).fail() is Blocked on a non-2xx response', async () => {
  await withServer(400, async (base) => {
    await assert.rejects(
      () => stubFault({ raw: { stubs: { payments: base } } }, 'payments').fail({ path: '/x' }),
      err => err instanceof Blocked && /400/.test(err.message),
    );
  });
});

test('stubFault(...).clear() DELETEs __scn/fail', async () => {
  await withServer(204, async (base, seen) => {
    await stubFault({ raw: { stubs: { payments: base } } }, 'payments').clear();
    assert.deepEqual(seen.map(s => [s.method, s.url]), [['DELETE', '/__scn/fail']]);
  });
});

// A silently failed clear leaves a fault live for the NEXT scenario, which then fails in code that
// is not its own.
test('stubFault(...).clear() is Blocked on a non-2xx response, symmetric with fail()', async () => {
  await withServer(500, async (base) => {
    await assert.rejects(() => stubFault({ raw: { stubs: { payments: base } } }, 'payments').clear(), /500/);
  });
});

test('an unknown stub control plane is Blocked', () => {
  assert.throws(() => stubFault({ raw: { stubs: {} } }, 'payments'), err => err instanceof Blocked && /unknown stub: payments/.test(err.message));
});

test('the stubFault probe injects a fault, sees it, and leaves nothing armed', async () => {
  const port = await freePort();
  const child = await bootStub(join(LIB, 'test/fixtures/generic-stub.mjs'), port);
  try {
    const base = `http://127.0.0.1:${port}`;
    const reg = { raw: { stubs: { payments: base } } };
    const cfg = { adapters: { stub: { selftest: { name: 'payments' } } } };
    const probe = collectProbes(reg, cfg).find(p => p.owner === 'stub' && p.name.startsWith('stub fault'));
    assert.equal(probe.missing, undefined);
    assert.equal(await probe.run(reg, cfg), true);
    assert.equal((await fetch(`${base}/scn-selftest-boom`)).status, 200);
  } finally {
    child.kill('SIGKILL');
  }
});

test('the stubFault probe clears the fault when a step in between throws', async () => {
  let cleared = 0;
  const server = await listen(http.createServer((req, res) => {
    if (req.method === 'DELETE' && req.url === '/__scn/fail') cleared += 1;
    if (req.url === '/scn-selftest-boom') { req.socket.destroy(); return; }
    res.writeHead(204);
    res.end();
  }));
  try {
    const reg = { raw: { stubs: { payments: `http://127.0.0.1:${server.address().port}` } } };
    const cfg = { adapters: { stub: { selftest: { name: 'payments' } } } };
    const probe = collectProbes(reg, cfg).find(p => p.owner === 'stub' && p.name.startsWith('stub fault'));
    await assert.rejects(() => probe.run(reg, cfg), Blocked);
    assert.equal(cleared, 1);
  } finally {
    server.close();
  }
});

test('the drivers are the journal and the fault', () => {
  assert.deepEqual(Object.keys(stubAdapter.drivers).sort(), ['stub', 'stubFault']);
});
