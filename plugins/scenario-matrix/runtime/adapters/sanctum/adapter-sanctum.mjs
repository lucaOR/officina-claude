// The sanctum adapter's contribution module: its `httpClient` (the stateful headers on every
// request, the XSRF header on the verbs Laravel guards, and `client.csrf(kind)`) and its
// `raw-request` lint rule. The module imports api.mjs, so the verb set and the header values have
// one definition.
import { Blocked } from './errors.mjs';
import { statefulHeaders, CSRF_VERBS } from './api.mjs';

export const name = 'sanctum';

// Laravel's own route, mounted by Sanctum. The response body is empty and irrelevant: the entire
// product of this call is the Set-Cookie pair (session + XSRF-TOKEN) it lands in the jar.
export const CSRF_COOKIE_PATH = '/sanctum/csrf-cookie';

// Applies the stateful headers on EVERY request, because a request without them is refused by the
// stateful gate as unauthenticated. X-XSRF-TOKEN goes on the verbs in CSRF_VERBS only. A caller that
// sets the header itself (any case) is left alone, so a row can probe a rejected token, and a
// mutating verb with no token in the jar is refused before the socket is touched: sent anyway, it
// would answer 500 "CSRF token mismatch" and read as a product defect.
export function httpClient(client) {
  client.addRequestHeaders(({ verb, host, path, opts }) => {
    const out = { ...statefulHeaders(host) };
    const callerSigned = Object.keys(opts.headers ?? {}).some(k => k.toLowerCase() === 'x-xsrf-token');
    if (CSRF_VERBS.has(verb.toLowerCase()) && !callerSigned) {
      const token = client.jar.value(host, 'XSRF-TOKEN');
      if (!token) {
        throw new Blocked(`${verb} ${path} on ${host} needs an X-XSRF-TOKEN and the jar holds none -- `
          + 'call client.csrf() before the first mutating request, or the app answers 500 "CSRF token mismatch"');
      }
      out['X-XSRF-TOKEN'] = token;
    }
    return out;
  });

  // The leg that makes the session EXIST. Not bookkeeping: a mutating POST sent without the
  // stateful headers still answers 200 while issuing no session cookie, so state the route stored
  // is silently lost and a later callback fails. Origin present but X-XSRF-TOKEN absent 500s
  // "CSRF token mismatch" instead. Both legs, always -- which is why this is a method rather than
  // advice, and why the header function above attaches the token itself.
  client.csrf = async (kind) => {
    const host = client.hostOf(kind);
    const res = await client.request(kind, CSRF_COOKIE_PATH);
    if (res.status !== 204 && res.status !== 200) {
      throw new Blocked(`GET ${CSRF_COOKIE_PATH} on ${host} answered ${res.status} -- the csrf-cookie `
        + 'route is not reachable, so no session can be established for a mutating call');
    }
    if (!client.jar.value(host, 'XSRF-TOKEN')) {
      throw new Blocked(`GET ${CSRF_COOKIE_PATH} on ${host} answered ${res.status} but set no XSRF-TOKEN `
        + 'cookie -- a mutating request cannot be signed');
    }
    return res;
  };
}

export const lint = [
  {
    // An app that puts the stateful-frontend middleware in front of its API routes reads
    // `referer ?: origin` and returns false when both are absent, which is exactly what a browser
    // automation APIRequestContext sends. The route then answers 401 UNAUTHENTICATED with a valid
    // session sitting unused in the cookie jar, and the row reports KO against whatever guard it
    // MEANT to reach. Mechanised here because it fails OPEN: the call looks right, the cookies are
    // right, and the only symptom is a plausible-looking product defect.
    id: 'raw-request',
    kind: 'code',
    re: /\b(?:context|page)\.request\.(?:get|post|put|patch|delete|head|fetch)\s*\(/,
    msg: 'raw context.request — use apiRequest(), which sends the Referer/Origin Sanctum\'s '
      + 'statefulApi() gate requires (a bare call 401s on a route whose guard would have passed)',
  },
];
