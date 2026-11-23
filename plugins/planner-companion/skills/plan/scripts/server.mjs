// Adapted from superpowers (MIT), Copyright (c) 2025 Jesse Vincent
// The live plan page: serves the review page, takes the page's actions as JSON POSTs and pushes
// "reload" over a WebSocket when the plan folder changes. Loopback only, session key on every route.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { renderPlanPage } from './lib/page.mjs';
import { pick, undo, updateReal } from './lib/changes.mjs';
import * as queue from './lib/queue.mjs';
import { stateDir } from './lib/store.mjs';

// ========== WebSocket Protocol (RFC 6455) ==========

const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0A };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_PAYLOAD_BYTES = 10 * 1024 * 1024;

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const secondByte = buffer[1];
  const opcode = buffer[0] & 0x0F;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7F;
  let offset = 2;

  if (!masked) throw new Error('Client frames must be masked');

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    const extendedLen = buffer.readBigUInt64BE(2);
    if (extendedLen > BigInt(MAX_FRAME_PAYLOAD_BYTES)) {
      throw new Error('WebSocket frame payload exceeds maximum allowed size');
    }
    payloadLen = Number(extendedLen);
    offset = 10;
  }

  if (payloadLen > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error('WebSocket frame payload exceeds maximum allowed size');
  }

  const maskOffset = offset;
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;

  const mask = buffer.slice(maskOffset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  }

  return { opcode, payload: data, bytesConsumed: totalLen };
}

// ========== Configuration ==========

const PLAN_DIR = process.argv[2] ? fs.realpathSync(path.resolve(process.argv[2])) : null;
if (!PLAN_DIR || !fs.statSync(PLAN_DIR).isDirectory()) {
  console.error('usage: server.mjs <plan-dir>');
  process.exit(2);
}
const STATE_DIR = stateDir(PLAN_DIR);
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const INFO_FILE = path.join(STATE_DIR, 'server-info.json');
const PORT_FILE = path.join(STATE_DIR, 'last-port');
const TOKEN_FILE = path.join(STATE_DIR, 'last-token');
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;

const randomPort = () => 49152 + Math.floor(Math.random() * 16383);
// An explicit PLANNING_PORT wins (0 asks the OS for a free one), else the port this plan last
// bound (so an open tab reconnects after a restart), else a random high port.
function preferredPort() {
  if (process.env.PLANNING_PORT !== undefined && process.env.PLANNING_PORT !== '') {
    const p = Number(process.env.PLANNING_PORT);
    if (Number.isInteger(p) && p >= 0 && p < 65536) return p;
  }
  try {
    const p = Number(fs.readFileSync(PORT_FILE, 'utf-8').trim());
    if (Number.isInteger(p) && p > 1023 && p < 65536) return p;
  } catch { /* no prior port recorded */ }
  return randomPort();
}
let PORT = preferredPort();

// Per-plan secret key. It rides the served URL as ?key= and is mirrored into a cookie on first
// load so the page's own requests and the WebSocket carry it. Persisted next to the port so a
// restart keeps the key and an already-open tab's cookie still validates.
const generateToken = () => crypto.randomBytes(32).toString('hex');

function chmodOwnerOnly(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function initialToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (/^[0-9a-f]{32,}$/i.test(t)) {
      chmodOwnerOnly(TOKEN_FILE);
      return { value: t, fromFile: true };
    }
  } catch { /* no prior token recorded */ }
  return { value: generateToken(), fromFile: false };
}

const tokenInfo = initialToken();
let TOKEN = tokenInfo.value;
let tokenFromFile = tokenInfo.fromFile;
let COOKIE_NAME = 'planning-key-' + PORT; // refined to the actual bound port in onListen

// ========== Templates and Constants ==========

const FORBIDDEN_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Session key required</title>
<style>body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; }
h1 { color: #333; } p { color: #666; } code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 4px; }</style>
</head>
<body><h1>Session key required</h1>
<p>This page needs the full URL your coding agent gave you, including the
<code>?key=&hellip;</code> part. Copy the complete URL and open it again.</p></body></html>`;

// The cookie is set by the response; the bootstrap page only drops the key from the address bar.
const BOOTSTRAP_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Opening the plan</title></head>
<body>
<script>location.replace('/');</script>
</body>
</html>`;

// ========== Authentication ==========

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// A request is authorized if it carries the session key as ?key= or as the
// session cookie. Both are compared in constant time.
function isAuthorized(req) {
  const q = req.url.indexOf('?');
  if (q >= 0) {
    const params = new URLSearchParams(req.url.slice(q + 1));
    if (params.has('key')) {
      const key = params.get('key');
      return Boolean(key && timingSafeEqualStr(key, TOKEN));
    }
  }
  const cookie = parseCookies(req.headers['cookie'])[COOKIE_NAME];
  if (cookie && timingSafeEqualStr(cookie, TOKEN)) return true;
  return false;
}

function pathnameOf(url) {
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function queryKey(url) {
  const q = url.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1)).get('key');
}

function securityHeaders(headers = {}) {
  return {
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...headers
  };
}

// The server is only ever reached as 127.0.0.1 or localhost on its own port; any other Host is a
// rebinding attempt or a misdirected client, refused even when it carries the key.
function isOwnHost(req) {
  const host = req.headers.host;
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

// The page is only ever opened at http://<Host>, so its own requests carry exactly that Origin.
function isOwnOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return Boolean(origin && host && origin === `http://${host}`);
}

// A WebSocket handshake from a non-browser client carries no Origin; a browser always does.
function isAllowedWebSocketOrigin(req) {
  return !req.headers.origin || isOwnOrigin(req);
}

// ========== HTTP Request Handler ==========

function sendJson(res, status, body) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Read the body while it streams, so an oversized one is cut off at the limit instead of buffered.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY_BYTES) { reject(new HttpError(413, 'body too large')); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new HttpError(413, 'body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(400, 'Content-Type must be application/json');
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'body is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  return body;
}

function requireStrings(body, names) {
  for (const name of names) {
    if (typeof body[name] !== 'string' || body[name] === '') throw new HttpError(400, `missing field: ${name}`);
  }
}

// A lib result is ok, a conflict (409) or a list of diagnostics (422).
function outcome(result) {
  if (result.ok) return [200, result];
  if (result.conflict) return [409, { conflict: result.conflict }];
  return [422, { diagnostics: result.diagnostics }];
}

const ROUTES = {
  '/api/ask': async (body) => {
    requireStrings(body, ['kind', 'target', 'text']);
    if (body.kind !== 'comment' && body.kind !== 'change') throw new HttpError(400, 'kind must be comment or change');
    return [200, { ok: true, ...await queue.ask(PLAN_DIR, body) }];
  },
  '/api/pick': async (body) => {
    requireStrings(body, ['target', 'option']);
    const result = await pick(PLAN_DIR, body.target, body.option);
    if (!result.ok || !result.change) return outcome(result);
    const question = await queue.queuePick(PLAN_DIR, { target: body.target, option: body.option, change: result.change.id });
    return [200, { ...result, question }];
  },
  '/api/resolve': async (body) => {
    requireStrings(body, ['thread']);
    await queue.resolve(PLAN_DIR, body.thread);
    return [200, { ok: true }];
  },
  '/api/to-change': async (body) => {
    requireStrings(body, ['thread']);
    return [200, { ok: true, question: await queue.toChange(PLAN_DIR, body.thread) }];
  },
  // A page undo or update changes what the session believes, so it is queued for the session (R61).
  '/api/undo': async (body) => {
    requireStrings(body, ['change']);
    const result = await undo(PLAN_DIR, body.change, { withLater: body.withLater === true, dryRun: body.dryRun === true });
    if (!result.ok || result.dryRun) return outcome(result);
    const question = await queue.queueNotice(PLAN_DIR, { kind: 'undo', undone: result.changes, touched: result.touched });
    return [200, { ...result, question }];
  },
  '/api/update-real': async () => {
    const result = await updateReal(PLAN_DIR);
    if (!result.ok) return outcome(result);
    const question = await queue.queueNotice(PLAN_DIR, { kind: 'update', wrote: ['plan.json', 'plan.md'] });
    return [200, { ...result, question }];
  },
};

async function handlePost(req, res, pathname) {
  const route = ROUTES[pathname];
  if (!route) { sendJson(res, 404, { error: 'not found' }); return; }
  const body = await readJsonBody(req);
  const [status, payload] = await route(body);
  sendJson(res, status, payload);
}

async function dispatch(req, res) {
  const pathname = pathnameOf(req.url);
  const keyFromQuery = queryKey(req.url);
  if (req.method === 'GET' && pathname === '/' && keyFromQuery) {
    res.writeHead(200, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
    res.end(BOOTSTRAP_PAGE);
  } else if (req.method === 'GET' && pathname === '/') {
    const html = await renderPlanPage(PLAN_DIR);
    res.writeHead(200, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
    res.end(html);
  } else if (req.method === 'POST') {
    await handlePost(req, res, pathname);
  } else {
    sendJson(res, 404, { error: 'not found' });
  }
}

function handleRequest(req, res) {
  if (!isOwnHost(req)) {
    sendJson(res, 403, { error: 'unexpected Host header' });
    return;
  }
  if (!isAuthorized(req)) {
    res.writeHead(403, securityHeaders({ 'Content-Type': 'text/html; charset=utf-8' }));
    res.end(FORBIDDEN_PAGE);
    return;
  }
  if (req.method === 'POST' && !isOwnOrigin(req)) {
    sendJson(res, 403, { error: 'foreign or missing Origin' });
    return;
  }
  touchActivity(); // only authorized requests count as activity

  // Mirror the key into a cookie so the page's own requests authenticate after bootstrap.
  // HttpOnly keeps it from page scripts; SameSite=Strict plus the Origin check stop cross-site posts.
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + TOKEN + '; HttpOnly; SameSite=Strict; Path=/');

  dispatch(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('request failed:', err.stack || err.message);
    if (res.headersSent) { res.destroy(); return; }
    if (status === 413) res.setHeader('Connection', 'close');
    sendJson(res, status, { error: err.message });
    if (status === 413) req.destroy();
  });
}

// ========== WebSocket Connection Handling ==========

const clients = new Set();

function handleUpgrade(req, socket) {
  if (pathnameOf(req.url) !== '/ws' || !isOwnHost(req) || !isAuthorized(req) || !isAllowedWebSocketOrigin(req)) { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  touchActivity();

  const accept = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let buffer = Buffer.alloc(0);
  clients.add(socket);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      let result;
      try {
        result = decodeFrame(buffer);
      } catch {
        socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
        clients.delete(socket);
        return;
      }
      if (!result) break;
      buffer = buffer.slice(result.bytesConsumed);

      switch (result.opcode) {
        case OPCODES.TEXT: // the page sends nothing over the socket; its actions are POSTs
          break;
        case OPCODES.CLOSE:
          socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          clients.delete(socket);
          return;
        case OPCODES.PING:
          socket.write(encodeFrame(OPCODES.PONG, result.payload));
          break;
        case OPCODES.PONG:
          break;
        default: {
          const closeBuf = Buffer.alloc(2);
          closeBuf.writeUInt16BE(1003);
          socket.end(encodeFrame(OPCODES.CLOSE, closeBuf));
          clients.delete(socket);
          return;
        }
      }
    }
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

function broadcast(msg) {
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify(msg)));
  for (const socket of clients) {
    try { socket.write(frame); } catch { clients.delete(socket); }
  }
}

// ========== Activity Tracking ==========

// Idle timeout: shut down after this long with no activity. Default 4 hours.
const IDLE_TIMEOUT_MS = (() => {
  const ms = Number(process.env.PLANNING_IDLE_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 4 * 60 * 60 * 1000;
})();
// How often the watchdog checks for idleness; configurable so tests run fast.
const LIFECYCLE_CHECK_MS = (() => {
  const ms = Number(process.env.PLANNING_LIFECYCLE_CHECK_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : 60 * 1000;
})();
let lastActivity = Date.now();

function touchActivity() {
  lastActivity = Date.now();
}

// ========== File Watching ==========

// The lock directory and the atomic-write temp files are plumbing, not plan changes.
const isPlumbing = filename => filename === '.lock' || filename.endsWith('.tmp');

// ========== Server Startup ==========

function writeOwnerOnly(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function startServer() {
  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);

  let debounce = null;
  const watcher = fs.watch(PLAN_DIR, (eventType, filename) => {
    if (filename && isPlumbing(String(filename))) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      touchActivity();
      broadcast({ type: 'reload' });
    }, 100);
  });
  watcher.on('error', (err) => console.error('fs.watch error:', err.message));

  let stopping = false;
  function shutdown(reason) {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ type: 'server-stopped', reason }));
    try { fs.unlinkSync(INFO_FILE); } catch { /* already gone */ }
    watcher.close();
    clearInterval(lifecycleCheck);
    if (debounce) clearTimeout(debounce);
    // Close any upgraded WebSocket sockets so server.close() can complete and
    // the process actually exits instead of lingering on an open connection.
    for (const socket of clients) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  }

  const lifecycleCheck = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) shutdown('idle timeout');
  }, LIFECYCLE_CHECK_MS);
  lifecycleCheck.unref();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // If the preferred port is already taken, fall back to a random port once instead of failing.
  let triedFallback = false;

  function onListen() {
    PORT = server.address().port;
    // The cookie name keys on the ACTUAL bound port so it cannot collide with another
    // server's cookie in the shared localhost jar.
    COOKIE_NAME = 'planning-key-' + PORT;
    // Record the bound port and token so the next start reuses them, but only when we got our
    // preferred port. On a fallback someone else holds it; persisting would strand their tab.
    if (!triedFallback) {
      try { fs.writeFileSync(PORT_FILE, String(PORT)); } catch { /* best effort */ }
      try {
        fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
        chmodOwnerOnly(TOKEN_FILE);
      } catch { /* best effort */ }
    }
    const url = `http://${HOST}:${PORT}/?key=${TOKEN}`;
    console.log(JSON.stringify({ type: 'server-started', port: PORT, planDir: PLAN_DIR }));
    // server-info embeds the key, so it stays owner-only. It is written last: its presence means "ready".
    writeOwnerOnly(INFO_FILE, JSON.stringify({ pid: process.pid, port: PORT, url, planDir: PLAN_DIR, startedAt: new Date().toISOString() }) + '\n');
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !triedFallback) {
      triedFallback = true;
      PORT = randomPort();
      if (tokenFromFile) {
        TOKEN = generateToken();
        tokenFromFile = false;
      }
      server.listen(PORT, HOST, onListen);
    } else {
      console.error('Server failed to bind:', err.message);
      process.exit(1);
    }
  });
  server.listen(PORT, HOST, onListen);
}

startServer();
