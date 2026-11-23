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

export async function openBrowser(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-chrome-'));
  const proc = spawn(chromePath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const close = async () => {
    proc.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  };

  try {
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* not up yet */ }
    }
    if (!port) throw new Error('Chromium did not report a DevTools port');

    let targets;
    for (let i = 0; i < 50 && !targets?.some((t) => t.type === 'page'); i++) {
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); }
    }
    const target = targets?.find((t) => t.type === 'page');
    if (!target) throw new Error('Chromium exposed no page target');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools socket failed')), { once: true });
    });
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
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
      async shot(url, { out, width, height, dark = false, format = 'webp', quality = 85 }) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        // Set the colour scheme before navigating: the dashboard draws its charts on load.
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
        const loaded = new Promise((resolve) => {
          const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.delete(l); resolve(); } };
          listeners.add(l);
        });
        await send('Page.navigate', { url });
        await loaded;
        await sleep(300);
        const params = format === 'png' ? { format } : { format, quality };
        const { data } = await send('Page.captureScreenshot', params);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.from(data, 'base64'));
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
