// api.mjs's whole job is to make one class of silent failure impossible: a
// request that authenticates correctly at the cookie layer and is refused
// 401 anyway, because Sanctum's statefulApi() gate reads a Referer/Origin that
// Playwright's APIRequestContext does not send. Every assertion below pins a
// piece of that contract, since getting any of them wrong fails OPEN — the
// call still runs, the row still finishes, and the only symptom is a KO
// accusing product code that was never reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, statefulHeaders, xsrfToken } from '../api.mjs';
import { Blocked, Inconclusive } from '../errors.mjs';

// A minimal double for the object apiRequest() takes as `b` (the registry qualifies): it only ever
// calls .host(kind) on it now, so that is all this fixture needs to answer.
// Mirrors the registry's contract: a known kind
// resolves, an unknown one throws Blocked -- never a silent fallback host.
const B = {
  host(kind) {
    if (kind === 'app') return 'app.example.test';
    throw new Blocked(`fixture has no '${kind}' host`);
  },
};

// A recording double for the slice of Playwright's BrowserContext this lever
// touches. Returning the call rather than a Response is enough: nothing here
// asserts on the response, only on what was SENT.
function fakeContext({ jar = null } = {}) {
  const calls = [];
  const record = verb => (url, opts) => { calls.push({ verb, url, opts }); return { verb, url, opts }; };
  // The jar mirrors a real multi-host one: an accounts token
  // FIRST, then the target host's. cookies(url) must filter by host, which is
  // the property the nine hand-written readers all got wrong.
  const cookies = jar ?? [
    { name: 'XSRF-TOKEN', domain: 'accounts.example.test', value: 'accounts-token' },
    { name: 'XSRF-TOKEN', domain: 'app.example.test', value: 'app%2Dtoken' },
  ];
  return {
    calls,
    cookies: async url => (url ? cookies.filter(c => String(url).includes(c.domain)) : cookies),
    request: {
      get: record('get'), post: record('post'), put: record('put'),
      patch: record('patch'), delete: record('delete'), head: record('head'),
    },
  };
}

test('statefulHeaders sends BOTH Referer and Origin', () => {
  // fromFrontend() is `referer ?: origin` today. Sending only one would work
  // now and break silently if the vendor reorders that expression.
  const h = statefulHeaders('app.example.test');
  assert.equal(h.Referer, 'https://app.example.test/');
  assert.equal(h.Origin, 'https://app.example.test');
});

test('the Referer carries a TRAILING SLASH, which is what the vendor match needs', () => {
  // fromFrontend() appends '/' only if absent, then Str::is()-matches against
  // each configured domain suffixed '/*'. A Referer of 'https://host' (no
  // slash) is normalised by the vendor, but pinning the slash here documents
  // which side owns the normalisation.
  assert.ok(statefulHeaders('h.test').Referer.endsWith('/'));
});

test('statefulHeaders refuses an empty host rather than emitting https:///', () => {
  // Inconclusive, not Blocked: an absent host means the CALLER asked for
  // something impossible, and 'https:///' would be sent, refused, and read as
  // a product 401.
  assert.throws(() => statefulHeaders(''), Inconclusive);
  assert.throws(() => statefulHeaders(undefined), Inconclusive);
});

test('apiRequest resolves the host through b.host(), not the caller', async () => {
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/api/v1/things/x/imports');
  assert.equal(ctx.calls[0].url, 'https://app.example.test/api/v1/things/x/imports');
});

test('an unknown kind is Blocked, never a silent fallback host', async () => {
  // registry.mjs's own header states the contract this pins: every registry
  // lookup miss is Blocked, never Ko and never a bare Error -- an authoring
  // typo in `kind` must not be reported as a product failure. This is what
  // the old REG-alias fixture could not exercise at all: it fell back to a
  // synthesized `${alias}.example.test` host for anything it did not
  // recognise, so a typo'd alias silently "resolved" instead of surfacing.
  // b.host(kind) throws Blocked on exactly this miss;
  // this fixture mirrors that contract rather than papering over it.
  await assert.rejects(() => apiRequest(fakeContext(), B, 'nope', '/x'), Blocked);
});

test('apiRequest attaches the stateful headers for the host it is calling', async () => {
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/api/v1/thing');
  assert.equal(ctx.calls[0].opts.headers.Referer, 'https://app.example.test/');
  assert.equal(ctx.calls[0].opts.headers.Origin, 'https://app.example.test');
});

test('a path without a leading slash is still joined correctly', async () => {
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', 'api/v1/thing');
  assert.equal(ctx.calls[0].url, 'https://app.example.test/api/v1/thing');
});

test('caller headers are merged, and win on collision', async () => {
  // A row that deliberately probes a WRONG Origin must be able to say so;
  // a lever that refused would push that row back to a bare context.request.
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/x', {
    headers: { 'X-Tenant-Id': 'c1', Origin: 'https://evil.test' },
  });
  const sent = ctx.calls[0].opts.headers;
  assert.equal(sent['X-Tenant-Id'], 'c1');
  assert.equal(sent.Origin, 'https://evil.test');
  assert.equal(sent.Referer, 'https://app.example.test/');
});

test('failOnStatusCode defaults FALSE so an expected 404 stays a pass', async () => {
  // Half these rows exist to assert a 404 or a 422. A lever that threw on a
  // non-2xx would turn the EXPECTED outcome into an untyped throw, which
  // scenario.mjs classifies Ko -- a passing row reported as a product bug.
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/x');
  assert.equal(ctx.calls[0].opts.failOnStatusCode, false);
});

test('a caller may still opt INTO failOnStatusCode', async () => {
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/x', { failOnStatusCode: true });
  assert.equal(ctx.calls[0].opts.failOnStatusCode, true);
});

test('the method is routed to the matching request verb', async () => {
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/x', { method: 'POST', data: { a: 1 } });
  assert.equal(ctx.calls[0].verb, 'post');
  assert.deepEqual(ctx.calls[0].opts.data, { a: 1 });
});

test('an unsupported method is Inconclusive, not a silent GET', async () => {
  await assert.rejects(() => apiRequest(fakeContext(), B, 'app', '/x', { method: 'TRACE' }), Inconclusive);
});

test('a context with no request surface is Blocked, not a TypeError', async () => {
  // An untyped TypeError out of a lever is classified Ko by scenario.mjs, i.e.
  // reported as a product bug. This is an environment fact about the browser.
  await assert.rejects(() => apiRequest({}, B, 'app', '/x'), Blocked);
  await assert.rejects(() => apiRequest(undefined, B, 'app', '/x'), Blocked);
});

test('a GET carrying a body is refused — the missing-method accident', async () => {
  // An earlier conversion dropped `method` at ten call sites and every
  // write went out as a GET. DELETE->GET returned 200 with the user's own
  // payload, PUT->GET returned 200 with the field unchanged, POST->GET 404'd:
  // three different plausible-looking product defects from one missing option.
  await assert.rejects(
    () => apiRequest(fakeContext(), B, 'app', '/x', { data: { a: 1 } }),
    Inconclusive,
  );
  await assert.rejects(
    () => apiRequest(fakeContext(), B, 'app', '/x', { multipart: { file: {} } }),
    Inconclusive,
  );
  await assert.rejects(
    () => apiRequest(fakeContext(), B, 'app', '/x', { form: { a: 1 } }),
    Inconclusive,
  );
});

test('the refusal names which body option was seen', async () => {
  await assert.rejects(
    () => apiRequest(fakeContext(), B, 'app', '/x', { data: {} }),
    /data/,
  );
});

test('a bodyless GET is still fine, and a body on a write method is fine', async () => {
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/x');
  await apiRequest(ctx, B, 'app', '/x', { method: 'PUT', data: { a: 1 } });
  await apiRequest(ctx, B, 'app', '/x', { method: 'DELETE' });
  assert.deepEqual(ctx.calls.map(c => c.verb), ['get', 'put', 'delete']);
});

test('xsrfToken reads the token for the TARGET host, not the first in the jar', async () => {
  // A multi-host login leaves an XSRF-TOKEN on
  // accounts.example.test that sorts BEFORE the target's, so an unscoped
  // read signs the request with another application's token and the target
  // answers "CSRF token mismatch."
  assert.equal(await xsrfToken(fakeContext(), 'app.example.test'), 'app-token');
});

test('xsrfToken percent-decodes the cookie value', async () => {
  // Laravel writes it URL-encoded; ValidateCsrfToken decrypts the RAW header.
  assert.equal(await xsrfToken(fakeContext(), 'app.example.test'), 'app-token');
});

test('a host with no token of its own is Blocked, not silently signed with another host\'s', async () => {
  await assert.rejects(() => xsrfToken(fakeContext(), 'other.example.test'), Blocked);
});

test('apiRequest attaches the CSRF token on write verbs', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const ctx = fakeContext();
    await apiRequest(ctx, B, 'app', '/x', { method });
    assert.equal(ctx.calls[0].opts.headers['X-XSRF-TOKEN'], 'app-token', `${method} was not signed`);
  }
});

test('apiRequest does NOT attach one on GET/HEAD, which Laravel exempts', async () => {
  for (const method of ['GET', 'HEAD']) {
    const ctx = fakeContext();
    await apiRequest(ctx, B, 'app', '/x', { method });
    assert.equal(ctx.calls[0].opts.headers['X-XSRF-TOKEN'], undefined);
  }
});

test('a caller-supplied token wins, so a row may probe a REJECTED one', async () => {
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/x', { method: 'POST', headers: { 'X-XSRF-TOKEN': 'deliberately-wrong' } });
  assert.equal(ctx.calls[0].opts.headers['X-XSRF-TOKEN'], 'deliberately-wrong');
});

test('the caller-wins check is case-insensitive on the header name', async () => {
  // A caller spelling it x-xsrf-token must not end up with BOTH its own header
  // and an auto-attached one, whose precedence would then depend on the
  // client's header casing rules.
  const ctx = fakeContext();
  await apiRequest(ctx, B, 'app', '/x', { method: 'POST', headers: { 'x-xsrf-token': 'lower' } });
  const keys = Object.keys(ctx.calls[0].opts.headers).filter(k => k.toLowerCase() === 'x-xsrf-token');
  assert.deepEqual(keys, ['x-xsrf-token']);
});
