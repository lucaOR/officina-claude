// Every test here drives the client through an INJECTED transport rather than a live stack, so
// what is pinned is the exact wire shape: which headers go out, on which socket, carrying which
// cookie. Those are the facts that fail OPEN when wrong, so a live rehearsal is the worst place to
// discover them. The hooks, the adapters and the config come from `__setForTest`, never from the
// lib's own hooks.mjs or config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CookieJar, apiClient, rawRequest, redirectTarget, encodeMultipart } from '../http.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';

const APP = 'app.example.test';

// Records every outgoing request and replays a queued response per call. `calls[i].options` is
// what node:https would have been handed (host, port, servername, headers) and `calls[i].body`
// is what was written to the socket.
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

// The slice of the registry the client reads: host(alias) throws Blocked on a miss, like the real one.
function fakeReg({ stubs = {}, stubInternal } = {}) {
  const hosts = { app: APP, other: 'other.example.test', local: 'http://localhost:8000' };
  return {
    raw: { stubs },
    host(alias) {
      if (!(alias in hosts)) throw new Blocked(`unknown host alias: ${alias}`);
      return hosts[alias];
    },
    ...(stubInternal ? { stubInternal } : {}),
  };
}

// No project hook, no installed adapter, no tenant key: the client alone.
function isolate(t, { hooks = {}, adapters = {}, config = {} } = {}) {
  t.after(__setForTest({ hooks, adapters, providers: {}, config }));
}

// --- CookieJar -------------------------------------------------------------

test('the jar accepts both node shapes of set-cookie: an array and a bare string', () => {
  const jar = new CookieJar();
  jar.accept('a.test', ['x=1; Path=/', 'y=2; HttpOnly']);
  jar.accept('b.test', 'z=3; Path=/');
  assert.equal(jar.header('a.test'), 'x=1; y=2');
  assert.equal(jar.header('b.test'), 'z=3');
});

test('the jar is scoped per host, so two hosts\' XSRF-TOKENs cannot be confused', () => {
  // A flat jar would hand back whichever application's token was set first.
  const jar = new CookieJar();
  jar.accept('accounts.test', 'XSRF-TOKEN=accounts-one');
  jar.accept(APP, 'XSRF-TOKEN=app-one');
  assert.equal(jar.value(APP, 'XSRF-TOKEN'), 'app-one');
  assert.equal(jar.value('accounts.test', 'XSRF-TOKEN'), 'accounts-one');
  assert.equal(jar.value('never-visited.test', 'XSRF-TOKEN'), null);
});

test('the jar percent-decodes, because a token is often compared against its raw form', () => {
  const jar = new CookieJar();
  jar.accept(APP, 'XSRF-TOKEN=tok%3Dvalue%2Bmore');
  assert.equal(jar.value(APP, 'XSRF-TOKEN'), 'tok=value+more');
  // The stored form stays encoded, so the Cookie header replays exactly what the server set.
  assert.equal(jar.header(APP), 'XSRF-TOKEN=tok%3Dvalue%2Bmore');
});

test('a later set-cookie for the same name on the same host replaces the earlier value', () => {
  const jar = new CookieJar();
  jar.accept(APP, 'session=first');
  jar.accept(APP, 'session=second');
  assert.equal(jar.header(APP), 'session=second');
});

// --- rawRequest ------------------------------------------------------------

test('rawRequest sends path + query and takes port from the URL', async () => {
  const t = fakeTransport([{ status: 200, body: 'ok' }]);
  await rawRequest({ url: 'https://x.test:8443/a/b?c=1&d=2', agents: t.agents });
  assert.equal(t.calls[0].options.path, '/a/b?c=1&d=2');
  assert.equal(t.calls[0].options.host, 'x.test');
  assert.equal(t.calls[0].options.port, 8443);
  assert.equal(t.calls[0].options.headers.Host, 'x.test:8443');
});

test('connect overrides the socket target while Host and SNI stay on the logical name', async () => {
  // This is `curl --connect-to`: the request is addressed to a hostname this machine cannot
  // resolve, and lands on a container on loopback.
  const t = fakeTransport([{ status: 302, headers: { location: 'https://app.test/cb?code=xyz' } }]);
  const res = await rawRequest({
    url: 'https://idp.example.test/oauth2/authorize?x=1',
    connect: { host: '127.0.0.1', port: '9443', hostHeader: 'idp.example.test' },
    agents: t.agents,
  });
  const { options } = t.calls[0];
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 9443);
  assert.equal(options.headers.Host, 'idp.example.test');
  assert.equal(options.servername, 'idp.example.test');
  assert.equal(options.rejectUnauthorized, false);
  // The redirect is RETURNED, never followed: it carries the one-shot code.
  assert.equal(res.status, 302);
  assert.equal(t.calls.length, 1);
});

test('SNI carries the hostname only, never host:port', async () => {
  const t = fakeTransport([{ status: 200 }]);
  await rawRequest({ url: 'https://auth.example.test:8443/token', agents: t.agents });
  assert.equal(t.calls[0].options.headers.Host, 'auth.example.test:8443');
  assert.equal(t.calls[0].options.servername, 'auth.example.test');
});

test('a transport failure throws Blocked naming the remedy, not an untyped error', async () => {
  const boom = () => {
    const req = { on: (evt, cb) => { if (evt === 'error') setImmediate(() => cb(new Error('ECONNREFUSED'))); return req; }, write: () => {}, end: () => {} };
    return req;
  };
  await assert.rejects(
    () => rawRequest({ url: 'https://down.test/x', agents: { https: boom, http: boom } }),
    /failed at the transport.*ECONNREFUSED.*scn stack/s,
  );
});

test('json() throws Blocked with the body when the response is not JSON', async () => {
  const t = fakeTransport([{ status: 500, body: '<html>Whoops</html>' }]);
  const res = await rawRequest({ url: 'https://x.test/y', agents: t.agents });
  assert.throws(() => res.json(), /expected JSON.*non-JSON body: <html>/s);
});

test('a binary body survives intact on bytes, and body is its single utf8 decode', async () => {
  // 0xE2 0x82 0xAC is a euro sign split across two chunks: decoding each chunk on its own would
  // turn it into replacement characters.
  const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xe2, 0x82, 0xac]);
  const make = (options, cb) => {
    const req = {
      on: () => req,
      write: () => {},
      end: () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.emit('data', bin.subarray(0, 6));
        res.emit('data', bin.subarray(6));
        res.emit('end');
      },
    };
    return req;
  };
  const res = await rawRequest({ url: 'https://x.test/y', agents: { https: make, http: make } });
  assert.deepEqual(res.bytes, bin);
  assert.ok(res.body.endsWith('€'));
});

// --- request ---------------------------------------------------------------

test('a request is plain: Accept and no stateful or csrf headers without an adapter that adds them', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, body: '{}' }]);
  await apiClient(fakeReg(), { transport: tr.agents }).request('app', '/api/things');
  const h = tr.calls[0].options.headers;
  assert.equal(h.Accept, 'application/json');
  assert.equal(h.Referer, undefined);
  assert.equal(h.Origin, undefined);
  assert.equal(h['X-XSRF-TOKEN'], undefined);
  assert.equal(h.Host, APP);
});

test('a bearer set with setToken is sent as Authorization and readable as token', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, body: '{}' }, { status: 200, body: '{}' }]);
  const client = apiClient(fakeReg(), { transport: tr.agents });
  assert.equal(client.token, null);
  await client.request('app', '/a');
  client.setToken('tok-abc');
  assert.equal(client.token, 'tok-abc');
  await client.request('app', '/b');
  assert.equal(tr.calls[0].options.headers.Authorization, undefined);
  assert.equal(tr.calls[1].options.headers.Authorization, 'Bearer tok-abc');
});

test('the client carries no token minting and no per-tenant identity: those belong to the project', (t) => {
  isolate(t);
  const client = apiClient(fakeReg(), { transport: fakeTransport().agents });
  assert.equal(client.mint, undefined);
  assert.equal(client.identity, undefined);
});

test('unknown request opts are ignored rather than turned into headers', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, body: '{}' }]);
  await apiClient(fakeReg(), { transport: tr.agents }).request('app', '/x', { company: 'c-1' });
  assert.deepEqual(Object.keys(tr.calls[0].options.headers).sort(), ['Accept', 'Host']);
});

test('set-cookie lands in the jar and the next call replays it', async (t) => {
  isolate(t);
  const tr = fakeTransport([
    { status: 204, headers: { 'set-cookie': ['session=sess-1; Path=/; HttpOnly', 'XSRF-TOKEN=tok%3Dvalue; Path=/'] } },
    { status: 200, body: '[]' },
  ]);
  const client = apiClient(fakeReg(), { transport: tr.agents });
  await client.request('app', '/first');
  await client.request('app', '/api/things');
  assert.equal(tr.calls[1].options.headers.Cookie, 'session=sess-1; XSRF-TOKEN=tok%3Dvalue');
  assert.equal(client.jar.value(APP, 'XSRF-TOKEN'), 'tok=value');
});

test('a json body is serialised with its Content-Type and length, and an empty object is still a body', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, body: '{}' }]);
  await apiClient(fakeReg(), { transport: tr.agents }).request('app', '/api/things', { method: 'POST', json: {} });
  const call = tr.calls[0];
  assert.equal(call.options.headers['Content-Type'], 'application/json');
  assert.equal(call.body, '{}');
  assert.equal(call.options.headers['Content-Length'], 2);
});

test('caller headers win over every default', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, body: '' }]);
  const client = apiClient(fakeReg(), { transport: tr.agents });
  client.setToken('tok-abc');
  await client.request('app', '/x', { headers: { Authorization: 'Bearer wrong', Accept: 'text/plain' } });
  assert.equal(tr.calls[0].options.headers.Authorization, 'Bearer wrong');
  assert.equal(tr.calls[0].options.headers.Accept, 'text/plain');
});

test('request() refuses an unsupported method as an authoring mistake', async (t) => {
  isolate(t);
  const client = apiClient(fakeReg(), { transport: fakeTransport().agents });
  await assert.rejects(() => client.request('app', '/x', { method: 'TRACE' }), /unsupported method TRACE/);
});

test('a path without a leading slash is joined, not concatenated', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, body: '{}' }]);
  await apiClient(fakeReg(), { transport: tr.agents }).request('app', 'api/things');
  assert.equal(tr.calls[0].options.path, '/api/things');
});

test('an unknown host alias is Blocked, never a silent fallback host', async (t) => {
  isolate(t);
  const client = apiClient(fakeReg(), { transport: fakeTransport().agents });
  await assert.rejects(() => client.request('nope', '/x'), Blocked);
});

test('request() refuses two bodies rather than silently ranking one over the other', async (t) => {
  isolate(t);
  const tr = fakeTransport();
  const client = apiClient(fakeReg(), { transport: tr.agents });
  await assert.rejects(
    () => client.request('app', '/x', { method: 'POST', json: {}, multipart: { a: 'b' } }),
    /three ways to set THE body -- pass exactly one/,
  );
  assert.equal(tr.calls.length, 0);
});

// --- host resolution -------------------------------------------------------

test('resolveHost is called with use http and the tenant', async (t) => {
  const seen = [];
  isolate(t, {
    hooks: { resolveHost: (alias, ctx) => { seen.push({ alias, ...ctx }); return 'tenant-a.example.test'; } },
    config: { tenantKey: 'tenant' },
  });
  const reg = fakeReg();
  const tr = fakeTransport([{ status: 200, body: '{}' }]);
  await apiClient(reg, { tenant: 'acme', transport: tr.agents }).request('app', '/x');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].alias, 'app');
  assert.equal(seen[0].use, 'http');
  assert.equal(seen[0].tenant, 'acme');
  assert.equal(seen[0].reg, reg);
  assert.equal(tr.calls[0].options.host, 'tenant-a.example.test');
});

test('resolveHost sees a null tenant when the client was built without one', async (t) => {
  const seen = [];
  isolate(t, { hooks: { resolveHost: (alias, ctx) => { seen.push(ctx.tenant); return APP; } }, config: { tenantKey: 'tenant' } });
  await apiClient(fakeReg(), { transport: fakeTransport().agents }).request('app', '/x');
  assert.deepEqual(seen, [null]);
});

test('without a resolveHost hook the registry host is used, over https', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, body: '{}' }]);
  await apiClient(fakeReg(), { transport: tr.agents }).request('app', '/x');
  assert.equal(tr.calls[0].options.port, 443);
  assert.equal(tr.calls[0].options.headers.Host, APP);
});

test('a resolved value with a scheme is the base URL, and the jar keys on its host', async (t) => {
  isolate(t);
  const tr = fakeTransport([
    { status: 200, headers: { 'set-cookie': 'session=local-1' }, body: '{}' },
    { status: 200, body: '{}' },
  ]);
  const client = apiClient(fakeReg(), { transport: tr.agents });
  await client.request('local', '/api/things?a=1');
  await client.request('local', '/again');

  const { options } = tr.calls[0];
  assert.equal(options.host, 'localhost');
  assert.equal(options.port, 8000);
  assert.equal(options.path, '/api/things?a=1');
  assert.equal(options.headers.Host, 'localhost:8000');
  assert.equal(options.rejectUnauthorized, undefined, 'a plain-http base must not go through the TLS path');
  assert.equal(client.jar.header('localhost:8000'), 'session=local-1');
  assert.equal(tr.calls[1].options.headers.Cookie, 'session=local-1');
});

// --- the client seams ------------------------------------------------------

test('extendClient can add a member', async (t) => {
  const seen = [];
  isolate(t, {
    hooks: {
      http: {
        extendClient(client, ctx) {
          seen.push(ctx);
          client.whoami = () => `tenant:${ctx.tenant}`;
        },
      },
    },
    config: { tenantKey: 'tenant' },
  });
  const reg = fakeReg();
  const client = apiClient(reg, { tenant: 'acme', transport: fakeTransport().agents });
  assert.equal(client.whoami(), 'tenant:acme');
  assert.equal(seen[0].reg, reg);
});

test('extendClient receives the options the client was built with, transport included', async (t) => {
  let got;
  isolate(t, { hooks: { http: { extendClient(client, ctx) { got = ctx.opts; } } } });
  const transport = fakeTransport().agents;
  apiClient(fakeReg(), { transport, company: 'c-1' });
  assert.equal(got.transport, transport);
  assert.equal(got.company, 'c-1');
});

test('every contributed httpClient function runs on the client, then the project hook', (t) => {
  const order = [];
  isolate(t, {
    adapters: {
      one: { httpClient: () => order.push('one') },
      two: { httpClient: () => order.push('two') },
      none: {},
    },
    hooks: { http: { extendClient: () => order.push('hook') } },
  });
  apiClient(fakeReg(), { transport: fakeTransport().agents });
  assert.deepEqual(order, ['one', 'two', 'hook']);
});

test('a contribution receives the registry and the tenant', (t) => {
  let got;
  isolate(t, { adapters: { one: { httpClient: (client, ctx) => { got = ctx; } } }, config: { tenantKey: 'tenant' } });
  const reg = fakeReg();
  apiClient(reg, { tenant: 'acme', transport: fakeTransport().agents });
  assert.deepEqual(got, { reg, tenant: 'acme' });
});

test('addRequestHeaders merges after Accept and before the bearer, cookie, body headers and the caller', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 200, headers: { 'set-cookie': 'session=s1' } }, { status: 200 }]);
  const client = apiClient(fakeReg(), { transport: tr.agents });
  const calls = [];
  client.addRequestHeaders(({ verb, host, path, opts, client: self }) => {
    calls.push({ verb, host, path, opts, self });
    return { Accept: 'text/html', Authorization: 'Bearer from-seam', 'X-First': '1' };
  });
  client.addRequestHeaders(() => ({ 'X-First': '2', 'X-Second': 'b' }));
  client.setToken('tok');
  await client.request('app', '/seed');
  await client.request('app', '/x', { method: 'post', json: {}, headers: { 'X-Second': 'caller' } });

  const h = tr.calls[1].options.headers;
  assert.equal(h.Accept, 'text/html', 'a contributed header replaces the default Accept');
  assert.equal(h['X-First'], '2', 'a later registration replaces an earlier one');
  assert.equal(h.Authorization, 'Bearer tok', 'the bearer replaces a contributed Authorization');
  assert.equal(h.Cookie, 'session=s1');
  assert.equal(h['X-Second'], 'caller', 'the caller wins last');
  assert.equal(calls[1].verb, 'POST');
  assert.equal(calls[1].host, APP);
  assert.equal(calls[1].path, '/x');
  assert.equal(calls[1].opts.json !== undefined, true);
  assert.equal(calls[1].self, client);
});

test('a throwing header function stops the request before the socket', async (t) => {
  isolate(t);
  const tr = fakeTransport();
  const client = apiClient(fakeReg(), { transport: tr.agents });
  client.addRequestHeaders(() => { throw new Blocked('no credentials yet'); });
  await assert.rejects(() => client.request('app', '/x'), /no credentials yet/);
  assert.equal(tr.calls.length, 0);
});

test('hostOf resolves an alias to the host the jar keys on', (t) => {
  isolate(t);
  const client = apiClient(fakeReg(), { transport: fakeTransport().agents });
  assert.equal(client.hostOf('app'), APP);
  assert.equal(client.hostOf('local'), 'localhost:8000');
});

// --- viaStub ---------------------------------------------------------------

const STUB = 'fixture-stub';
const stubReg = () => fakeReg({
  stubs: { [STUB]: 'http://127.0.0.1:9999' },
  stubInternal: name => `http://${name}.local.test`,
});

test('viaStub rewrites the socket target and keeps the logical host on the wire', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 302, headers: { location: 'https://app.test/cb?code=xyz' } }]);
  const client = apiClient(stubReg(), { transport: tr.agents });
  const res = await client.viaStub(STUB, 'http://fixture-stub.local.test/authorize?x=1');

  assert.equal(tr.calls[0].options.host, '127.0.0.1');
  assert.equal(tr.calls[0].options.port, 9999);
  assert.equal(tr.calls[0].options.headers.Host, 'fixture-stub.local.test');
  assert.equal(res.status, 302);
});

test('viaStub REFUSES a url pointing somewhere else, which is what makes it an assertion', async (t) => {
  // Without this, a product that emitted a wrong host and one that emitted the right host would
  // both be silently forwarded to the stub and both look green.
  isolate(t);
  const client = apiClient(stubReg(), { transport: fakeTransport().agents });
  await assert.rejects(
    () => client.viaStub(STUB, 'https://idp.example.test/authorize'),
    /stands in for http:\/\/fixture-stub\.local\.test.*refusing to send it/s,
  );
});

test('viaStub throws Blocked naming the registry key for an unknown stub, without naming a technology', async (t) => {
  isolate(t);
  const client = apiClient(stubReg(), { transport: fakeTransport().agents });
  await assert.rejects(
    () => client.viaStub('nope', 'http://fixture-stub.local.test/x'),
    (err) => err instanceof Blocked
      && /unknown stub: nope.*infra\.env_registry\.stubs\.nope/s.test(err.message)
      && !/docker/i.test(err.message),
  );
});

test('viaStub without the stub adapter is Blocked and names the setup command', async (t) => {
  isolate(t);
  const client = apiClient(fakeReg(), { transport: fakeTransport().agents });
  await assert.rejects(
    () => client.viaStub(STUB, 'http://fixture-stub.local.test/x'),
    (err) => err instanceof Blocked && /viaStub needs the stub adapter.*\/scenario-matrix:setup --add stub/s.test(err.message),
  );
});

// --- redirectTarget --------------------------------------------------------

test('redirectTarget returns the Location as a URL and throws Blocked when there is none', () => {
  const target = redirectTarget({ status: 302, headers: { location: 'https://app.test/cb?code=xyz&state=s1' } });
  assert.equal(target.searchParams.get('code'), 'xyz');
  assert.equal(target.searchParams.get('state'), 's1');
  assert.throws(() => redirectTarget({ status: 200, headers: {} }), /expected a redirect.*no Location header/s);
});

test('redirectTarget resolves a relative Location against the base it was given', () => {
  const target = redirectTarget({ status: 302, headers: { location: '/app/x?done=success' } },
    { base: `https://${APP}` });
  assert.equal(target.toString(), `https://${APP}/app/x?done=success`);
});

// --- multipart -------------------------------------------------------------

test('encodeMultipart keeps file bytes intact, which a string round trip would not', () => {
  // 0x50 0x4b is the ZIP magic every .xlsx/.ods starts with, and 0x80 is a byte no UTF-8 decode
  // survives, so this fails loudly if the encoder ever goes back through a JS string.
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0xff]);
  const { body, contentType } = encodeMultipart(
    { source: 'local', file: { name: 'x.xlsx', mimeType: 'application/zip', buffer: bytes } },
    'BOUND',
  );
  assert.equal(contentType, 'multipart/form-data; boundary=BOUND');
  const marker = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), body.indexOf('x.xlsx'));
  assert.deepEqual(body.subarray(marker + 4, marker + 4 + bytes.length), bytes);
});

test('encodeMultipart writes a plain field without a filename and a file part with one', () => {
  const { body } = encodeMultipart(
    { source: 'local', file: { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('h\n') } },
    'BOUND',
  );
  const text = body.toString('utf8');
  assert.match(text, /--BOUND\r\nContent-Disposition: form-data; name="source"\r\n\r\nlocal\r\n/);
  assert.match(text, /name="file"; filename="a\.csv"\r\nContent-Type: text\/csv\r\n\r\nh\n\r\n/);
  assert.ok(text.endsWith('--BOUND--\r\n'), `body does not close the boundary: ${JSON.stringify(text.slice(-20))}`);
});

test('encodeMultipart refuses a nameless file part rather than posting an extension-less upload', () => {
  assert.throws(
    () => encodeMultipart({ file: { buffer: Buffer.from('x') } }),
    /carries no name/,
  );
});

test('a multipart request sends the generated Content-Type and its own length', async (t) => {
  isolate(t);
  const tr = fakeTransport([{ status: 202, body: '{"id":"b1"}' }]);
  await apiClient(fakeReg(), { transport: tr.agents }).request('app', '/api/imports', {
    method: 'POST',
    multipart: { source: 'local', file: { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from('h\n') } },
  });
  const call = tr.calls[0];
  assert.match(call.options.headers['Content-Type'], /^multipart\/form-data; boundary=scnform/);
  assert.equal(call.options.headers['Content-Length'], Buffer.byteLength(call.body));
});
