// Minimal headless-Chromium driver over the DevTools protocol (Node's global WebSocket, no dependency).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome(env = process.env, home = os.homedir()) {
  if (env.CHROME && fs.existsSync(env.CHROME)) return env.CHROME;
  const cache = path.join(home, '.cache', 'ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(cache); } catch { return null; }
  const shells = dirs
    .map((d) => d.match(/^chromium_headless_shell-(\d+)$/))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [name] of shells) {
    const p = path.join(cache, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const STDERR_TAIL = 2000; // characters of Chromium's stderr kept for error messages
const short = (url) => (url.length > 80 ? `${url.slice(0, 77)}...` : url);

/**
 * Starts headless Chromium. Rejects with a message that names the cause when the binary cannot
 * run, exits early, or reports no DevTools port within `startTimeout` ms; the message ends with
 * the tail of Chromium's stderr when it wrote any.
 */
export async function openBrowser(chromePath, { startTimeout = 10_000 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-chrome-'));
  const proc = spawn(chromePath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (s) => { stderr = (stderr + s).slice(-STDERR_TAIL); });
  const withStderr = (message) => (stderr.trim() ? `${message}. Chromium's stderr ends with:\n${stderr.trim()}` : message);

  // Set once the process could not start or has exited; `exited` resolves at the same moment.
  let gone = null;
  const exited = new Promise((resolve) => {
    proc.once('error', (e) => { gone ??= `could not start Chromium at ${chromePath}: ${e.code || e.message}`; resolve(); });
    proc.once('exit', (code, signal) => { gone ??= `Chromium exited (${signal || `code ${code}`}) before it reported a DevTools port`; resolve(); });
  });

  // Wait for the exit before removing the profile: Chromium writes into it while it shuts down.
  const close = async () => {
    proc.kill();
    const force = setTimeout(() => proc.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(force);
    fs.rmSync(profile, { recursive: true, force: true });
  };

  try {
    let port;
    for (const deadline = Date.now() + startTimeout; !port && !gone && Date.now() < deadline;) {
      await sleep(100);
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* not up yet */ }
    }
    if (!port) throw new Error(withStderr(gone || `Chromium did not report a DevTools port within ${startTimeout / 1000} s`));

    let targets;
    for (let i = 0; i < 50 && !targets?.some((t) => t.type === 'page'); i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); }
    }
    const target = targets?.find((t) => t.type === 'page');
    if (!target) throw new Error(withStderr('Chromium exposed no page target'));

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools socket failed')), { once: true });
    });
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.addEventListener('close', () => {
      for (const { reject } of pending.values()) reject(new Error(withStderr('the DevTools connection closed')));
      pending.clear();
    });
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}`)); else resolve(msg.result);
      } else if (msg.method) {
        for (const l of listeners) l(msg);
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    await send('Page.enable');

    return {
      /**
       * Loads `url` and writes a screenshot to `out`. Rejects, writing nothing, when the page
       * fails to load or has not fired its load event within `timeout` ms. `prepare`, a JavaScript
       * expression, runs in the loaded page before the screenshot (to pick a tab or scroll, say);
       * a promise it returns is awaited, and shot() resolves to its value.
       */
      async shot(url, { out, width, height, dark = false, format = 'webp', quality = 85, timeout = 30_000, prepare }) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        // Set the colour scheme before navigating: the dashboard draws its charts on load.
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
        let onLoad;
        let timer;
        const loaded = new Promise((resolve, reject) => {
          onLoad = (m) => { if (m.method === 'Page.loadEventFired') resolve(); };
          listeners.add(onLoad);
          timer = setTimeout(() => reject(new Error(`${short(url)} did not finish loading within ${timeout / 1000} s`)), timeout);
        });
        try {
          const nav = await Promise.race([send('Page.navigate', { url }), loaded.then(() => ({}))]);
          // A failed load still shows Chromium's error page, which must never become an image.
          if (nav.errorText) throw new Error(`could not load ${short(url)}: ${nav.errorText}`);
          await loaded;
        } finally {
          listeners.delete(onLoad);
          clearTimeout(timer);
        }
        await sleep(300);
        let value;
        if (prepare) {
          const r = await send('Runtime.evaluate', { expression: prepare, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) {
            throw new Error(`the prepare script failed on ${short(url)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
          }
          value = r.result.value;
          await sleep(300);
        }
        const params = format === 'png' ? { format } : { format, quality };
        const { data } = await send('Page.captureScreenshot', params);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.from(data, 'base64'));
        return value;
      },
      async close() {
        ws.close();
        await close();
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
