// Raw HTTP against a product API from inside a logged-in browser context.
//
// Why this module exists at all, since the browser automation library already hands every script a
// `context.request` that shares the browsing context's cookie jar:
//
//   An app that calls `$middleware->statefulApi()` in its bootstrap file installs Sanctum's
//   EnsureFrontendRequestsAreStateful in front of every route file under `routes/api`. Its gate is
//   fromFrontend() (vendor/laravel/sanctum/.../EnsureFrontendRequestsAreStateful):
//
//       $domain = $request->headers->get('referer') ?: $request->headers->get('origin');
//       if (is_null($domain)) { return false; }
//
//   A browser automation APIRequestContext sends NEITHER header unless you ask for them. So
//   fromFrontend() returns false, the session middleware never runs, `auth:web` has no session to
//   resolve a user from, and the route answers 401 {"code":"UNAUTHENTICATED"} -- with the right
//   cookies present, on the right origin, against a route whose guard would have passed. The SPA's
//   own XHRs always carry a Referer, which is exactly why the UI works while a hand-rolled request
//   beside it does not.
//
//   That is the worst failure shape a scenario harness has -- a green-looking accusation against
//   product code that did nothing wrong -- so the fix is a lever every script must go through
//   rather than a header each author has to remember. The `raw-request` lint rule rejects a bare
//   `context.request.` in a compiled script for the same reason.
//
// The Referer is `https://<host>/` and the Origin `https://<host>`, because fromFrontend() strips
// the scheme, appends a trailing slash if absent, and Str::is()-matches against each configured
// domain suffixed `/*`. The app lists its own host in SANCTUM_STATEFUL_DOMAINS, so the host the
// script is already driving is always the correct one to present -- which is why this takes a
// registry alias rather than a free-text URL, and cannot be pointed somewhere the registry does not
// know.
import { Blocked, Inconclusive } from './errors.mjs';

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);

// Exported for the unit test, which must be able to assert the exact header values without a live
// browser: getting these subtly wrong (a missing trailing slash, a scheme-less host) fails OPEN as
// a 401, i.e. as a fake product bug, so they are worth pinning independently of any call site.
export function statefulHeaders(host) {
  if (!host) throw new Inconclusive('statefulHeaders() needs a host');
  return {
    // Referer is what fromFrontend() reads FIRST (`referer ?: origin`), so sending only Origin
    // would work today and break silently the day the vendor reorders that expression. Sending
    // both costs nothing.
    Referer: `https://${host}/`,
    Origin: `https://${host}`,
  };
}

// The session's CSRF token, read from the cookie jar SCOPED TO ONE HOST.
//
// The scoping is the entire point. A login can walk several hosts, and each Laravel app it touches
// sets its own XSRF-TOKEN on its own domain. After such a login the jar holds one per host.
// `context.cookies()` with no argument returns ALL of them, in visit order, so a
// find(c => c.name === 'XSRF-TOKEN') picks the token belonging to a DIFFERENT application and the
// target answers "CSRF token mismatch."
//
// Percent-decoded because Laravel writes the cookie URL-encoded and
// ValidateCsrfToken::getTokenFromRequest() decrypts the RAW header value.
export async function xsrfToken(context, host) {
  if (typeof context?.cookies !== 'function') {
    throw new Blocked('xsrfToken(): the browser context exposes no cookies() -- was the browser opened and awaited?');
  }
  const jar = await context.cookies(`https://${host}`);
  const cookie = jar.find(c => c.name === 'XSRF-TOKEN');
  if (!cookie) {
    throw new Blocked(`no XSRF-TOKEN cookie for ${host} after login -- that application never issued one, so a `
      + 'mutating request cannot be signed (the jar may still hold another host\'s token, which would be refused)');
  }
  return decodeURIComponent(cookie.value);
}

// Verbs Laravel's ValidateCsrfToken actually guards. GET/HEAD/OPTIONS are exempt, which is
// precisely why GET-only rows keep passing while every write fails.
// Exported so the http client's contribution guards the SAME verb set rather than keeping a second
// copy of it: the two clients differ in where the jar lives, never in which verbs are guarded.
export const CSRF_VERBS = new Set(['post', 'put', 'patch', 'delete']);

// context: the browser context from the opened browser, whose cookie jar carries the session
//          established by login(), which is the whole point of routing through it rather than
//          scnFetch().
// b:       any object with `host(kind)`; the registry qualifies. Hosts stay registry-owned, as
//          everywhere else the facade is used.
// kind:    a host alias that `b.host(kind)` resolves.
// path:    path with or without a leading slash, query string included.
export async function apiRequest(context, b, kind, path, opts = {}) {
  const { method = 'get', headers = {}, ...rest } = opts;
  const verb = String(method).toLowerCase();
  if (!METHODS.has(verb)) throw new Inconclusive(`apiRequest(): unsupported method ${method}`);
  if (!context?.request?.[verb]) {
    throw new Blocked(`apiRequest(): the browser context exposes no request.${verb}() -- was the browser opened and awaited?`);
  }

  // A body on a method that does not carry one is a MISTAKE, not a request. The concrete accident:
  // converting call sites from context.request.<verb>(url, opts) to apiRequest(..., opts) dropped
  // the verb, which this function's `method = 'get'` default then swallowed. Every write went out
  // as a GET, and the symptoms were plausible enough to be mistaken for product defects for a full
  // run -- DELETE became GET and returned 200 with the user's own payload; PUT became GET and
  // returned 200 with the field unchanged; POST became GET and 404'd on a route that exists. Only a
  // GET that carried a body was common to all of them, so that is what is refused here.
  if ((verb === 'get' || verb === 'head') && (opts.data !== undefined || opts.multipart !== undefined || opts.form !== undefined)) {
    throw new Inconclusive(
      `apiRequest(): a ${verb.toUpperCase()} was given a request body (${['data', 'multipart', 'form'].filter(k => opts[k] !== undefined).join('/')}) `
      + '-- almost certainly a missing `method` option, which would otherwise be sent as a bodyless GET and '
      + 'answered by whatever GET route happens to match',
    );
  }

  const host = b.host(kind);
  const url = `https://${host}${String(path).startsWith('/') ? '' : '/'}${path}`;

  // Caller headers win on collision. A row that deliberately probes what happens with a WRONG
  // Origin has to be able to say so, and this lever refusing to be overridden would push that row
  // back to a bare context.request call, reintroducing the very trap this exists to close.
  // The CSRF token is attached HERE rather than left to each call site, for the same reason the
  // stateful headers are: scripts that wrote their own reader all took the wrong host's token. A
  // caller that sets the header explicitly still wins, so a row deliberately probing a rejected
  // token can pass a bad one.
  const needsCsrf = CSRF_VERBS.has(verb)
    && !Object.keys(headers).some(k => k.toLowerCase() === 'x-xsrf-token');
  const csrf = needsCsrf ? { 'X-XSRF-TOKEN': await xsrfToken(context, host) } : {};

  const merged = { ...statefulHeaders(host), ...csrf, ...headers };

  // failOnStatusCode defaults false because a scenario JUDGES the status: half these rows exist to
  // assert a 404 or a 422, and a lever that threw on those would turn the expected outcome into an
  // untyped throw, which scenario.mjs classifies KO -- a passing row reported as a product bug.
  return context.request[verb](url, { failOnStatusCode: false, headers: merged, ...rest });
}
