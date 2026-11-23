// The sanctum adapter's contribution to the http client, driven through an injected transport.
// What is pinned is the wire shape: a mutating POST sent without the stateful headers answers 200
// while issuing no session cookie, and one with an Origin but no X-XSRF-TOKEN answers "CSRF token
// mismatch", so each of these fails OPEN when wrong. Adapters, hooks and config come from
// `__setForTest`, never from the lib's own hooks.mjs or config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apiClient } from '../http.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';
import * as sanctumAdapter from '../adapter-sanctum.mjs';

const APP = 'app.example.test';

function fakeTransport(queue = []) {
  const calls = [];
  const make = (options, cb) => {
    const call = { options, body: '' };
    calls.push(call);
    const req = {
      on: () => req,
      write: (chunk) => { call.body += chunk; },
      end: () => {
        const next = queue.shift() ?? { status: 200, headers: {}, body: '' };
        const res = new EventEmitter();
        res.statusCode = next.status ?? 200;
        res.headers = next.headers ?? {};
        cb(res);
        res.emit('data', next.body ?? '');
        res.emit('end');
      },
    };
    return req;
  };
  return { calls, agents: { https: make, http: make } };
}

const reg = () => ({
  raw: {},
  host(alias) {
    if (alias === 'app') return APP;
    if (alias === 'local') return 'http://localhost:8000';
    throw new Blocked(`unknown host alias: ${alias}`);
  },
});

// Laravel sets BOTH cookies on the csrf-cookie leg, the XSRF one URL-encoded: the '%3D' is a real
// '=' that must survive into the header decoded.
const CSRF_OK = {
  status: 204,
  headers: { 'set-cookie': ['app_session=sess-1; Path=/; HttpOnly', 'XSRF-TOKEN=tok%3Dvalue; Path=/'] },
  body: '',
};

function withSanctum(t) {
  t.after(__setForTest({ adapters: { sanctum: sanctumAdapter }, hooks: {}, providers: {}, config: {} }));
}

test('the adapter contributes an httpClient function and a csrf cookie path', () => {
  assert.equal(typeof sanctumAdapter.httpClient, 'function');
  assert.equal(sanctumAdapter.CSRF_COOKIE_PATH, '/sanctum/csrf-cookie');
});

test('csrf() lands both cookies in the jar and the next call replays them', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([CSRF_OK, { status: 200, body: '[]' }]);
  const client = apiClient(reg(), { transport: tr.agents });
  client.setToken('tok-abc');
  await client.csrf('app');
  await client.request('app', '/api/v1/things');

  assert.equal(tr.calls[0].options.path, sanctumAdapter.CSRF_COOKIE_PATH);
  assert.equal(tr.calls[1].options.headers.Cookie, 'app_session=sess-1; XSRF-TOKEN=tok%3Dvalue');
});

test('csrf() refuses a 200 that set no XSRF-TOKEN, which is the silent no-session shape', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([{ status: 200, headers: {}, body: '' }]);
  await assert.rejects(
    () => apiClient(reg(), { transport: tr.agents }).csrf('app'),
    /set no XSRF-TOKEN cookie.*cannot be signed/s,
  );
});

test('csrf() refuses a status that is neither 200 nor 204', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([{ status: 404, headers: {}, body: '' }]);
  await assert.rejects(
    () => apiClient(reg(), { transport: tr.agents }).csrf('app'),
    (err) => err instanceof Blocked && /answered 404.*not reachable/s.test(err.message),
  );
});

test('every request carries BOTH stateful headers plus the bearer', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([{ status: 200, body: '{}' }]);
  const client = apiClient(reg(), { transport: tr.agents });
  client.setToken('tok-abc');
  await client.request('app', '/api/v1/things');

  const h = tr.calls[0].options.headers;
  // Referer is what the stateful gate reads FIRST (`referer ?: origin`).
  assert.equal(h.Referer, `https://${APP}/`);
  assert.equal(h.Origin, `https://${APP}`);
  assert.equal(h.Authorization, 'Bearer tok-abc');
  assert.equal(h.Accept, 'application/json');
});

test('sanctum adds csrf and stateful headers to mutating verbs', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([CSRF_OK, { status: 200, body: '{}' }]);
  const client = apiClient(reg(), { transport: tr.agents });
  await client.csrf('app');
  await client.request('app', '/api/v1/things', { method: 'POST', json: {} });

  const call = tr.calls[1];
  assert.equal(call.options.headers['X-XSRF-TOKEN'], 'tok=value', 'the DECODED token');
  assert.equal(call.options.headers.Referer, `https://${APP}/`);
  assert.equal(call.options.headers.Origin, `https://${APP}`);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  // An EMPTY object is a real body, so it must be sent, not skipped as falsy.
  assert.equal(call.body, '{}');
  assert.equal(call.options.headers['Content-Length'], 2);
});

test('a mutating verb is signed for each of post, put, patch and delete', async (t) => {
  withSanctum(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const tr = fakeTransport([CSRF_OK, { status: 200 }]);
    const client = apiClient(reg(), { transport: tr.agents });
    await client.csrf('app');
    await client.request('app', '/x', { method });
    assert.equal(tr.calls[1].options.headers['X-XSRF-TOKEN'], 'tok=value', `${method} was not signed`);
  }
});

test('a GET is not given an xsrf header, matching the verbs that are actually guarded', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([CSRF_OK, { status: 200, body: '[]' }]);
  const client = apiClient(reg(), { transport: tr.agents });
  await client.csrf('app');
  await client.request('app', '/api/v1/things');
  assert.equal(tr.calls[1].options.headers['X-XSRF-TOKEN'], undefined);
  assert.equal(tr.calls[1].options.headers.Referer, `https://${APP}/`);
});

test('a mutating verb with no csrf() first is REFUSED rather than sent to a 500', async (t) => {
  withSanctum(t);
  const tr = fakeTransport();
  const client = apiClient(reg(), { transport: tr.agents });
  await assert.rejects(
    () => client.request('app', '/api/v1/things', { method: 'POST', json: {} }),
    (err) => err instanceof Blocked && /needs an X-XSRF-TOKEN and the jar holds none.*call client\.csrf\(\)/s.test(err.message),
  );
  // Nothing was sent: the refusal is before the socket, so a row cannot half-drive the product
  // and then report the 500 as a finding.
  assert.equal(tr.calls.length, 0);
});

test('caller headers win, so a row can deliberately probe a wrong Origin or a bad token', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([CSRF_OK, { status: 419, body: '' }]);
  const client = apiClient(reg(), { transport: tr.agents });
  await client.csrf('app');
  await client.request('app', '/api/v1/things', {
    method: 'POST', json: {}, headers: { Origin: 'https://evil.test', 'X-XSRF-TOKEN': 'wrong' },
  });
  assert.equal(tr.calls[1].options.headers.Origin, 'https://evil.test');
  assert.equal(tr.calls[1].options.headers['X-XSRF-TOKEN'], 'wrong');
});

test('a caller-supplied token also lifts the no-csrf refusal, whatever the header case', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([{ status: 419, body: '' }]);
  const client = apiClient(reg(), { transport: tr.agents });
  await client.request('app', '/x', { method: 'POST', headers: { 'x-xsrf-token': 'probe' } });
  assert.equal(tr.calls[0].options.headers['x-xsrf-token'], 'probe');
  assert.equal(tr.calls[0].options.headers['X-XSRF-TOKEN'], undefined);
});

test('a multipart request keeps the csrf header and the generated Content-Type', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([CSRF_OK, { status: 202, body: '{"id":"b1"}' }]);
  const client = apiClient(reg(), { transport: tr.agents });
  await client.csrf('app');
  await client.request('app', '/api/v1/imports', {
    method: 'POST',
    multipart: { source: 'local', file: { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('h\n') } },
  });
  const call = tr.calls[1];
  assert.match(call.options.headers['Content-Type'], /^multipart\/form-data; boundary=scnform/);
  assert.equal(call.options.headers['Content-Length'], Buffer.byteLength(call.body));
  assert.equal(call.options.headers['X-XSRF-TOKEN'], 'tok=value');
});

test('the jar keys on the resolved host, so a scheme-carrying base signs against its own token', async (t) => {
  withSanctum(t);
  const tr = fakeTransport([
    { status: 204, headers: { 'set-cookie': 'XSRF-TOKEN=local-token' } },
    { status: 200 },
  ]);
  const client = apiClient(reg(), { transport: tr.agents });
  await client.csrf('local');
  await client.request('local', '/x', { method: 'POST' });
  assert.equal(tr.calls[1].options.headers['X-XSRF-TOKEN'], 'local-token');
});

test('without the sanctum adapter installed the client carries no csrf()', (t) => {
  t.after(__setForTest({ adapters: {}, hooks: {}, providers: {}, config: {} }));
  assert.equal(apiClient(reg(), { transport: fakeTransport().agents }).csrf, undefined);
});
