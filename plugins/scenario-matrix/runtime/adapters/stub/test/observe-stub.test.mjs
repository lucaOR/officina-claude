import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { stub } from '../observe.mjs';
import * as stubAdapter from '../adapter-stub.mjs';
import { collectProbes } from '../selftest.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: { stub: stubAdapter }, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Runs `fn` against a server driven by `handler`, and records what it was asked.
async function withServer(handler, fn) {
  const seen = [];
  const server = await listen(http.createServer((req, res) => { seen.push({ method: req.method, url: req.url }); handler(req, res); }));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

const answer = (status, body = '{}') => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };

test('stub().requests() reads the journal of a plain-http stub', async () => {
  const journal = [{ method: 'GET', path: '/x', body: '', at: 'now' }];
  await withServer(answer(200, JSON.stringify(journal)), async (base, seen) => {
    assert.deepEqual(await stub({ raw: { stubs: { payments: base } } }, 'payments').requests(), journal);
    assert.deepEqual(seen, [{ method: 'GET', url: '/__scn/requests' }]);
  });
});

test('stub().requests() is Blocked on a non-2xx response and names the control plane generically', async () => {
  await withServer(answer(404), async (base) => {
    await assert.rejects(
      () => stub({ raw: { stubs: { payments: base } } }, 'payments').requests(),
      err => err instanceof Blocked && /404/.test(err.message) && /__scn/.test(err.message) && !/server\.js|_infra/.test(err.message),
    );
  });
});

test('stub().clear() sends DELETE to the stub\'s own __scn/requests path', async () => {
  await withServer(answer(204, ''), async (base, seen) => {
    await assert.doesNotReject(() => stub({ raw: { stubs: { 'stub-a': base } } }, 'stub-a').clear());
    assert.deepEqual(seen, [{ method: 'DELETE', url: '/__scn/requests' }]);
  });
});

test('stub().clear() is Blocked on a non-2xx response', async () => {
  await withServer(answer(500), async (base) => {
    await assert.rejects(
      () => stub({ raw: { stubs: { 'stub-a': base } } }, 'stub-a').clear(),
      err => err instanceof Blocked && /journal clear returned 500/.test(err.message),
    );
  });
});

test('a stub that is not listening is Blocked, never a product KO', async () => {
  const server = await listen(http.createServer(() => {}));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  const reg = { raw: { stubs: { payments: `http://127.0.0.1:${port}` } } };
  await assert.rejects(() => stub(reg, 'payments').requests(), err => err instanceof Blocked && /did not connect/.test(err.message));
});

test('an unknown stub is Blocked and says where to add it', () => {
  assert.throws(
    () => stub({ raw: { stubs: {} } }, 'payments'),
    err => err instanceof Blocked && /unknown stub: payments/.test(err.message) && /infra\.env_registry\.stubs\.payments/.test(err.message),
  );
});

test('stubInternal returns the in-stack address of a stub', () => {
  const { stubInternal } = stubAdapter.registry.accessors({ stubs_internal: { payments: 'http://payments:8080' } });
  assert.equal(stubInternal('payments'), 'http://payments:8080');
});

test('stubInternal on an unknown name is Blocked and names neither a compose file nor a network', () => {
  const { stubInternal } = stubAdapter.registry.accessors({ stubs_internal: {} });
  assert.throws(
    () => stubInternal('payments'),
    err => err instanceof Blocked
      && /unknown stub address: payments/.test(err.message)
      && /infra\.env_registry\.stubs_internal\.payments/.test(err.message)
      && /inside the stack/.test(err.message)
      && !/compose|network/i.test(err.message),
  );
});

test('the registry keys validate a mapping of stub name to URL', () => {
  for (const key of ['stubs', 'stubs_internal']) {
    const { validate } = stubAdapter.registry.keys[key];
    assert.equal(validate({ payments: 'http://127.0.0.1:9000' }), null);
    assert.match(validate('nope'), /mapping/);
    assert.match(validate({ payments: '' }), /payments/);
    assert.match(validate({ payments: 5 }), /payments/);
  }
});

test('the stub probe reads the journal only, and needs a stub name', async () => {
  const probe = cfg => collectProbes({}, cfg).find(p => p.owner === 'stub' && p.name.startsWith('stub journal'));
  assert.equal(probe({}).missing, 'adapters.stub.selftest.name');
  const cfg = { adapters: { stub: { selftest: { name: 'payments' } } } };
  assert.equal(probe(cfg).missing, undefined);
  await withServer(answer(200, '[]'), async (base, seen) => {
    const reg = { raw: { stubs: { payments: base } } };
    assert.equal(await probe(cfg).run(reg, cfg), false, 'a journal that did not grow is a failed probe');
    assert.ok(seen.every(s => !s.url.startsWith('/__scn/') || s.method === 'GET'), 'the probe never writes to the control plane');
  });
});
