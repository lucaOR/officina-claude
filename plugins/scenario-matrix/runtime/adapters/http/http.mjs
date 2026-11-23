// A browser-free HTTP client with its OWN cookie jar and a bearer slot.
//
// WHY THIS EXISTS, given a browser-context request lever may already be installed:
//
//   A browser-bound request lever reads the cookies of a BrowserContext and dispatches through it.
//   That is right for every row whose subject is a logged-in USER, because the session was
//   established by driving the real UI. It is unusable for a row that never opens a browser at
//   all: there is no context to take a jar from.
//
//   observe.mjs's scnFetch() is browser-free but keeps NO jar and discards the response headers.
//   Both things a headless login leg has to read live in those discarded headers: Set-Cookie (the
//   session an OAuth `state` is stored against) and Location (the redirect carrying the
//   authorization code).
//
//   So an API-only row needs a third shape, and this is it. It is NOT a replacement for either: a
//   row with a browser should keep using the browser-bound lever, because a jar that agrees with
//   the UI's own is worth more than one this module maintains in parallel.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   Follow redirects. Every redirect in these flows is EVIDENCE: the 302 out of an identity
//   provider carries the code, and following it would consume exactly the thing the row asserts
//   on, and would replay a one-shot code against a stub that refuses the second use.
//
//   Throw on a non-2xx. Half these rows exist to assert a 404 or a 422, and a lever that threw on
//   those would turn the expected outcome into an untyped throw, which scenario.mjs classifies
//   Ko: a passing row reported as a product bug. Transport failures DO throw, typed Blocked:
//   nothing was learned about the product when the socket never opened.
//
//   Know any authentication scheme. The bearer is a plain slot (`setToken`), and everything else a
//   project or another adapter needs on the wire goes through `addRequestHeaders`, a seam that
//   `contributions('httpClient')` functions and the `http.extendClient` hook both reach.
import http from 'node:http';
import https from 'node:https';
import { Blocked, Inconclusive } from './errors.mjs';
import { hook, contributions, tenantOf } from './ext.mjs';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

// A cookie jar scoped BY HOST, and host-only on purpose.
//
// A real browser jar keys on the cookie's Domain attribute, so a cookie set with
// Domain=.example.test would be sent to every subdomain. Nothing this client talks to is assumed to
// do that, and the bug this scoping exists to prevent is a jar holding two XSRF-TOKENs from two
// hosts, where picking the wrong one gets "CSRF token mismatch" from the right host. Keying on the
// host makes that mistake unrepresentable rather than merely avoidable.
//
// If a row ever genuinely needs a Domain-scoped cookie to travel across hosts, this is the class to
// teach about Domain. Do not work around it at a call site by copying a value between hosts, which
// would hide the fact that the product set a cookie the client could not have honoured.
export class CookieJar {
  constructor() {
    this.byHost = new Map();
  }

  // `setCookie` is node's res.headers['set-cookie'], which is an ARRAY when more than one cookie is
  // set and a bare string when exactly one is. Normalised here rather than at each call site.
  accept(host, setCookie) {
    if (!setCookie) return;
    const jar = this.byHost.get(host) ?? new Map();
    for (const line of [].concat(setCookie)) {
      // Everything before the first ';' is `name=value`; the rest is attributes (Path, HttpOnly,
      // SameSite, Expires) that this client has no use for: it never persists across a process and
      // never crosses a host.
      const pair = String(line).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    this.byHost.set(host, jar);
  }

  header(host) {
    const jar = this.byHost.get(host);
    if (!jar || jar.size === 0) return null;
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // Percent-decoded because a framework writes a token cookie URL-encoded and compares the header
  // against the raw value, so sending it still encoded is a "token mismatch" 500.
  value(host, name) {
    const raw = this.byHost.get(host)?.get(name);
    return raw === undefined ? null : decodeURIComponent(raw);
  }
}

// The one function in this module that reaches outside the process. `agents` is injectable so the
// unit tests drive the whole client against a fake transport rather than a live stack.
//
// `connect` is what makes a stubbed identity provider possible: the socket goes to
// `connect.host:connect.port` while the Host header and the TLS SNI both present `hostHeader`.
// That is exactly `curl --connect-to`, and it is how a request addressed to a hostname this machine
// cannot resolve lands on a container on 127.0.0.1 without touching /etc/hosts or the process's DNS.
export function rawRequest({
  url,
  method = 'GET',
  headers = {},
  body,
  connect = null,
  agents = { https: https.request, http: http.request },
} = {}) {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const hostHeader = connect?.hostHeader ?? target.host;
  const port = connect ? connect.port : (target.port || (secure ? 443 : 80));

  const options = {
    host: connect ? connect.host : target.hostname,
    port: Number(port),
    method,
    path: `${target.pathname}${target.search}`,
    headers: { Host: hostHeader, ...headers },
  };
  if (secure) {
    // Scoped to this one request, never process-wide: the same treatment scnFetch() gives the
    // self-signed stubs. servername keeps TLS SNI on the LOGICAL hostname so the server picks the
    // right certificate and reconstructs the right issuer.
    options.rejectUnauthorized = false;
    // Hostname only, never host:port. A Host HEADER legitimately carries the port, but TLS SNI is a
    // hostname and a server handed one with a port appended matches no certificate.
    options.servername = String(connect?.hostHeader ?? target.hostname).split(':')[0];
  }

  const send = secure ? agents.https : agents.http;
  return new Promise((resolve, reject) => {
    const req = send(options, (res) => {
      // Collected as Buffers and decoded once: appending each chunk to a string decodes it on its
      // own, which mangles a multi-byte character split across two chunks and makes a binary body
      // (a spreadsheet download) useless.
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); });
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: text,
          // The raw body, for a binary download a caller re-uploads or parses.
          bytes,
          // Named json() rather than a parsed field so a non-JSON body (the empty 204, the HTML
          // redirect page) is not a parse error on every response that happens to carry one.
          json: () => {
            try {
              return JSON.parse(text || 'null');
            } catch {
              throw new Blocked(`expected JSON from ${method} ${url} but got ${res.statusCode} `
                + `with a non-JSON body: ${text.slice(0, 200)}`);
            }
          },
        });
      });
    });
    req.on('error', err => reject(new Blocked(`${method} ${url} failed at the transport: ${err.message} `
      + '(the container is down, the port is not published, or the scn stack was never brought up)')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Encodes a `multipart` option into the exact wire bytes rawRequest() writes. It exists because a
// browser-bound upload lever needs a BrowserContext, which is precisely what an API-only row does
// not have. Without this, such a row's only routes were hand-rolling `node:https` or shelling out
// to curl, both of which lint clean while being exactly the bypass the single-import-surface rule
// exists to stop.
//
// The field shape is deliberately the browser-bound lever's, so the two upload idioms read the same
// at a call site: a string value is a plain field, and an object carrying `buffer` is a file part
// with its own `name` (the FILENAME the server sees) and `mimeType`. That filename matters beyond
// cosmetics: a server that keeps the client extension and branches its parser on it cannot choose
// a reader for a file part sent without a name.
//
// Returns a Buffer, never a string: a spreadsheet part is a ZIP container, and round-tripping
// those bytes through a JS string mangles them.
export function encodeMultipart(fields, boundary = `scnform${Math.random().toString(16).slice(2)}`) {
  const chunks = [];
  for (const [field, value] of Object.entries(fields)) {
    const isFile = value !== null && typeof value === 'object' && value.buffer !== undefined;
    if (isFile && !value.name) {
      throw new Inconclusive(`encodeMultipart(): the file part "${field}" carries no name, so the server `
        + 'would receive an extension-less upload and could not pick a reader for it');
    }
    const disposition = isFile
      ? `form-data; name="${field}"; filename="${value.name}"`
      : `form-data; name="${field}"`;
    const type = isFile ? `\r\nContent-Type: ${value.mimeType ?? 'application/octet-stream'}` : '';
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n`, 'utf8'));
    chunks.push(isFile ? Buffer.from(value.buffer) : Buffer.from(String(value), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const defaultResolveHost = (alias, { reg }) => reg.host(alias);

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// reg:  the loaded registry. Only `host(alias)` and, for viaStub, `raw.stubs` and `stubInternal` are read.
// opts: `transport` replaces the node agents (tests). Every other key is for the project: the
//       tenant is read from it under the configured `tenantKey` and handed to `resolveHost` and to
//       `http.extendClient`, which also receives `opts` itself, so a member the project adds can
//       honour the same transport.
//
// Returns { tenant, jar, token, setToken, hostOf, addRequestHeaders, request, viaStub }, plus
// whatever the installed adapters' `httpClient` contributions and the project's `http.extendClient`
// hook add.
export function apiClient(reg, opts = {}) {
  const { transport } = opts;
  const tenant = tenantOf(opts);
  const jar = new CookieJar();
  const headerFns = [];
  let bearer = null;

  const send = (args) => rawRequest(transport ? { ...args, agents: transport } : args);

  // An alias resolved to its base URL and the host the jar keys on. A resolved value with a scheme
  // (`http://localhost:8000`) is the base URL as given, and a bare host gets `https://`.
  const resolve = (kind) => {
    const resolved = String(hook('resolveHost', defaultResolveHost)(kind, { tenant, reg, use: 'http' }));
    const base = HAS_SCHEME.test(resolved) ? resolved.replace(/\/+$/, '') : `https://${resolved}`;
    return { base, host: new URL(base).host };
  };

  const client = {
    tenant,
    jar,
    get token() { return bearer; },

    // The bearer every later request sends as `Authorization: Bearer <token>`. Passing null clears it.
    // Obtaining one is the project's business, so nothing here knows a grant type.
    setToken(token) { bearer = token ?? null; },

    // The host a kind resolves to, which is the key the jar files its cookies under.
    hostOf(kind) { return resolve(kind).host; },

    // Registers `fn({ verb, host, path, opts, client })`, which returns a headers object and may
    // throw to refuse the request before anything is sent. request() merges, in this order: Accept,
    // every registered function's headers in registration order, Authorization (the bearer),
    // Cookie, Content-Type, Content-Length, and last the caller's own `headers`, so a caller always
    // wins on a collision.
    addRequestHeaders(fn) { headerFns.push(fn); },

    // kind: a host alias resolved through `resolveHost`, else through the registry's `hosts:` block.
    //       A registry alias rather than a free-text URL, so this cannot be pointed somewhere the
    //       registry does not know.
    // opts.json: serialised as the body AND sets Content-Type. An empty object is a legitimate
    //       body, so the check is `!== undefined`, never a truthiness test.
    // Unknown opts are ignored here: a project that needs one turned into a header registers it
    // through addRequestHeaders.
    // Caller headers win on collision: a row that deliberately probes a WRONG Origin or a bad token
    // has to be able to say so, or it gets pushed back to hand-rolling the request.
    async request(kind, path, opts = {}) {
      const { method = 'GET', headers = {}, json, body, multipart } = opts;
      // Refused rather than silently ranked: two bodies in one call means the author expected one
      // of them to be sent and has no way of telling which one was.
      if ([json, body, multipart].filter(v => v !== undefined).length > 1) {
        throw new Inconclusive('request(): json, body and multipart are three ways to set THE body -- pass exactly one');
      }
      const verb = String(method).toUpperCase();
      if (!METHODS.has(verb)) throw new Inconclusive(`request(): unsupported method ${method}`);

      const { base, host } = resolve(kind);
      const url = `${base}${String(path).startsWith('/') ? '' : '/'}${path}`;

      const contributed = {};
      for (const fn of headerFns) Object.assign(contributed, fn({ verb, host, path, opts, client }));

      const cookie = jar.header(host);
      const form = multipart !== undefined ? encodeMultipart(multipart) : null;
      const payload = form ? form.body : (json !== undefined ? JSON.stringify(json) : body);
      const merged = {
        Accept: 'application/json',
        ...contributed,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(form ? { 'Content-Type': form.contentType } : {}),
        ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      };

      const res = await send({ url, method: verb, headers: merged, body: payload });
      jar.accept(host, res.headers['set-cookie']);
      return res;
    },

    // A request to a hostname this machine cannot resolve, answered by the stub standing in for it.
    // `url` is the LOGICAL url, typically one the product itself just emitted, and it is checked
    // against the stub's own registered internal address before anything is sent.
    //
    // That check is the point, not a formality: it asserts the product built a URL pointing at the
    // hostname the stub is impersonating. Without it, a product that emitted a real provider URL
    // and a product that emitted a wrong one would both be silently redirected to the stub and
    // both look green.
    async viaStub(name, url, opts = {}) {
      if (typeof reg.stubInternal !== 'function') {
        throw new Blocked('viaStub needs the stub adapter: run /scenario-matrix:setup --add stub');
      }
      const published = reg.raw.stubs?.[name];
      if (!published) {
        throw new Blocked(`unknown stub: ${name} (add infra.env_registry.stubs.${name}, `
          + 'the host-published 127.0.0.1:<port> address of the stub)');
      }
      const internal = new URL(reg.stubInternal(name));
      const asked = new URL(url);
      if (asked.host !== internal.host) {
        throw new Blocked(`viaStub(${name}) was given ${asked.origin}, but that stub stands in for `
          + `${internal.origin} -- refusing to send it, because forwarding it anyway would let a URL built `
          + 'against the wrong host pass as if it had been built against the right one');
      }
      const socket = new URL(published);
      const { method = 'GET', headers = {}, body } = opts;
      const cookie = jar.header(asked.host);
      const res = await send({
        url,
        method: String(method).toUpperCase(),
        headers: {
          Accept: 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body,
        connect: { host: socket.hostname, port: socket.port, hostHeader: asked.host },
      });
      jar.accept(asked.host, res.headers['set-cookie']);
      return res;
    },
  };

  for (const { fn } of contributions('httpClient')) fn(client, { reg, tenant });
  hook('http.extendClient', () => {})(client, { reg, tenant, opts });

  return client;
}

// The `location` off a 302, as an absolute URL and with a typed throw when there is none. Every
// caller of this was otherwise going to write `new URL(res.headers.location)` and get a TypeError
// on the response that forgot to redirect, which scenario.mjs classifies Ko, blaming the product
// for a shape the row never checked.
export function redirectTarget(res, { base = null } = {}) {
  const location = res?.headers?.location;
  if (!location) {
    throw new Blocked(`expected a redirect but the response was ${res?.status} with no Location header`);
  }
  return base ? new URL(location, base) : new URL(location);
}
