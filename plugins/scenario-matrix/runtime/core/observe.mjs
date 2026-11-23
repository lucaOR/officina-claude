// Backend observation: log slices, mail, stub request journals. Core keeps what
// names no technology: the HTTP helper, the slice mark, the source lookup, the
// grep filtering and the negative assert. Reading a source is a driver, one per
// source kind (`logSource.<kind>`), and mail and stubs are drivers of their
// own, all contributed by adapters. A driver `logSource.<kind>` is an object:
//
//   read(reg, src, opts)         -> Promise<string>  the source's text
//   capture(reg, src, dir, opts) -> Promise<void>    writes <dir>/<src.service>.log
//
// `src` is what the registry returns for the service, plus `service`, on both
// objects passed to read() and capture(). `opts` reach the driver untouched.
import http from 'node:http';
import https from 'node:https';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { driver } from './ext.mjs';
import { REPO } from './paths.mjs';
import { Ko, Blocked } from './errors.mjs';

// A stdout-style log source cannot be truncated between rows, so its slice is
// time-based: scenario() records the start of each attempt through
// markLogSlice(), and a driver reads it back with logSliceStart().
//
// The mark is pulled back by SLICE_MARGIN_MS because the timestamps a source
// compares against may come from another clock than this process's. A margin
// of a second can leak a previous row's last lines into this slice, which is
// harmless for evidence and for a positive logs() assert. The reverse error,
// losing this row's first lines, would make noLog() pass vacuously, so the
// margin errs this way.
const SLICE_MARGIN_MS = 1000;
let sliceStart = null;

export function markLogSlice(now = Date.now()) {
  sliceStart = new Date(now - SLICE_MARGIN_MS).toISOString();
  return sliceStart;
}

export const logSliceStart = () => sliceStart;

const sourceDriver = (src) => driver(`logSource.${src.kind}`);

export async function logs(reg, service, opts = {}) {
  const src = reg.logSource(service);
  const raw = await sourceDriver(src).read(reg, { ...src, service }, opts);
  const lines = String(raw).split('\n').filter(Boolean);
  const { grep = null } = opts;
  if (!grep) return lines;
  const re = grep instanceof RegExp ? grep : new RegExp(grep);
  return lines.filter(l => re.test(l));
}

export async function noLog(reg, service, pattern, opts = {}) {
  const hits = await logs(reg, service, { ...opts, grep: pattern });
  if (hits.length > 0) {
    throw new Ko(`expected no log line matching ${pattern}, got ${hits.length}: ${hits[0].slice(0, 200)}`);
  }
}

// Every registered log source's slice, written to <dir>/logs/<service>.log on
// a failing attempt, so a KO or BLOCKED row carries the server side of the
// story next to its other evidence without the script asking for it. Best
// effort per source: a source this run never started is recorded in
// _sources.txt and skipped, and one unreadable source never costs the others.
export async function captureLogs(reg, dir, opts = {}) {
  // Names first: a registry that cannot list its sources writes nothing.
  const names = reg.logSourceNames();
  const target = join(isAbsolute(dir) ? dir : join(REPO, dir), 'logs');
  mkdirSync(target, { recursive: true });
  const index = [];
  for (const service of names) {
    try {
      const src = reg.logSource(service);
      await sourceDriver(src).capture(reg, { ...src, service }, target, opts);
      const text = readFileSync(join(target, `${service}.log`), 'utf8');
      index.push(`${service}\t${text.split('\n').filter(Boolean).length} line(s)`);
    } catch (err) {
      index.push(`${service}\tskipped: ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`);
    }
  }
  writeFileSync(join(target, '_sources.txt'), `slice since ${sliceStart ?? '(unmarked)'}\n${index.join('\n')}\n`);
  return target;
}

export const mail = async (reg, filter = {}, opts = {}) => driver('mail')(reg, filter, opts);
export const mailCount = async (reg, opts = {}) => driver('mailCount')(reg, opts);
export const mailMessage = async (reg, id, opts = {}) => driver('mailMessage')(reg, id, opts);
export const stub = (reg, name) => driver('stub')(reg, name);

// A TRANSPORT failure is Blocked on both schemes. node:http and node:https do
// not reject on an HTTP status — a 500 resolves normally and the caller judges
// it — so a rejection here can only mean the socket never carried a request:
// the target is not running, its port is not published, or its certificate
// could not be negotiated. That is the environment, and it used to reach KO.
const asTransportFailure = (method, url, err) => new Blocked(
  `${method} ${url} did not connect: ${err?.message ?? String(err)}`, { cause: err },
);

// Route every control-plane call through this helper instead of a bare fetch()
// so https:// targets get rejectUnauthorized: false -- scoped to exactly this
// one request, not a process-wide NODE_TLS_REJECT_UNAUTHORIZED override. The
// built-in fetch() cannot verify a self-signed certificate and fails with a
// bare "fetch failed".
//
// `headers` and `servername` exist for a target selected by the REQUEST rather
// than by DNS: connecting to a published address while overriding what the
// request claims to be talking to, as curl's --connect-to does, which moves
// BOTH the Host header and the TLS SNI name. They are kept separate because
// they are separately load-bearing: a server routes on the Host header, and one
// that virtual-hosts on SNI needs the other.
//
// `text()` exists for callers that judge an HTML page, not JSON. The body is
// read once and both views are served from that single string, so text() does
// not spend json(). Both schemes go through node's http modules rather than the
// built-in fetch(), because undici drops a `Host` header SILENTLY, which would
// leave a lever's most important option ignored on one scheme.
//
// node:http does NOT follow redirects, where fetch() did: a lever that
// silently followed a redirect would be judging a page it never asked for.
export function scnFetch(url, { method = 'GET', body, headers, servername } = {}) {
  const secure = url.startsWith('https:');
  return new Promise((resolve, reject) => {
    const options = { method };
    if (secure) options.rejectUnauthorized = false;
    if (headers) options.headers = headers;
    if (secure && servername) options.servername = servername;
    const req = (secure ? https : http).request(url, options, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        text: async () => chunks,
        json: async () => JSON.parse(chunks || 'null'),
      }));
    });
    req.on('error', err => reject(asTransportFailure(method, url, err)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
