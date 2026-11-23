// The things a browser-reach scenario needs that no other lever supplies: an open page, the KO
// screenshot scenario.mjs's captureEvidence hook asks for, and numbered step shots.
//
// Why the browser is opened from HERE and not from the compiled script: `playwright` resolves out
// of _lib/node_modules, and Node's upward node_modules lookup from _scripts/<epic>/<id>.mjs never
// reaches that directory, so a compiled script cannot `import { chromium }` at all. It would have
// to reach around index.mjs with a relative path into node_modules, which is exactly the
// environment-reach-outside-the-lib the single-import-surface rule exists to prevent. The import
// is dynamic so an API-only script, which never opens a browser, does not pay to load playwright.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LAUNCH_OPTIONS, CONTEXT_OPTIONS } from './login.mjs';
// The repo root is derived once, not a cwd-relative guess: a compiled script may be spawned from
// anywhere.
import { REPO } from './paths.mjs';
import { evidenceDir } from './result.mjs';

// Caps on what the diagnostics keep. A KO row's page can emit thousands of console lines (a
// polling list refresh does), and the file is read by a person deciding why a row failed, so the
// first entries of each kind are the useful ones.
const MAX_ENTRIES = 100;
const MAX_BODY_CHARS = 500;

// Records what a blank screenshot cannot show: console output, uncaught page errors, requests
// that never completed, and every 4xx/5xx response with the start of its body. An error-page
// redirect is the case this exists for: the screenshot is white, but the API response that
// triggered the redirect carries the server's own error message. Every listener is best-effort:
// a diagnostics failure must never fail the scenario it observes.
export function recordDiagnostics(page) {
  const log = { console: [], pageErrors: [], failedRequests: [], badResponses: [] };
  if (typeof page.on !== 'function') return log;
  const push = (list, entry) => { if (list.length < MAX_ENTRIES) list.push(entry); };
  const t = () => new Date().toISOString();

  page.on('console', msg => {
    push(log.console, { at: t(), type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', err => {
    push(log.pageErrors, { at: t(), message: err?.message ?? String(err) });
  });
  page.on('requestfailed', req => {
    push(log.failedRequests, {
      at: t(), method: req.method(), url: req.url(), error: req.failure()?.errorText ?? null,
    });
  });
  page.on('response', async res => {
    if (res.status() < 400) return;
    const entry = { at: t(), method: res.request().method(), url: res.url(), status: res.status(), body: null };
    // Pushed before the body is awaited so a response that arrives just before the page closes
    // still leaves its status line behind.
    push(log.badResponses, entry);
    try {
      entry.body = (await res.text()).slice(0, MAX_BODY_CHARS);
    } catch { /* body already gone: redirect, or the page closed */ }
  });
  return log;
}

// The dynamic import is wrapped in a default-valued parameter rather than called inline, because
// it is the one thing in here that reaches outside the process, so a test can drive the whole
// function against a fake browser. The option keys are `launchOptions`/`contextOptions`,
// deliberately not `context`: the returned `context` is the BrowserContext, and one name for two
// things reads as a bug even when it is not.
export async function openBrowser(ctx, {
  launchOptions = {},
  contextOptions = {},
  playwright = () => import('playwright'),
} = {}) {
  const { chromium } = await playwright();
  const browser = await chromium.launch({ ...LAUNCH_OPTIONS, ...launchOptions });
  const browserContext = await browser.newContext({ ...CONTEXT_OPTIONS, ...contextOptions });
  const page = await browserContext.newPage();

  // ctx.page/ctx.browser are the fields scenario.mjs declares and the evidence hook reads;
  // registering the close as a ctx cleanup (rather than leaving it to a try/finally in the
  // script) is what closes the browser on EVERY exit path: scenario() ends in process.exit(),
  // which never unwinds through a script-local finally.
  ctx.browser = browser;
  ctx.page = page;
  ctx.browserLog = recordDiagnostics(page);
  ctx.cleanups.push(() => browser.close());

  return { browser, context: browserContext, page };
}

// Matches scenario()'s captureEvidence(ctx, dir) signature, so a compiled script wires it in as
// `captureEvidence: screenshot`. Returns null rather than throwing when there is no page (an
// API-only KO), because scenario() treats a null evidence value as "nothing to record" and a
// throw here would be swallowed by its safe() wrapper anyway.
export async function screenshot(ctx, dir, { mkdir = mkdirSync, write = writeFileSync } = {}) {
  if (!ctx.page) return null;
  const target = isAbsolute(dir) ? dir : join(REPO, dir);
  mkdir(target, { recursive: true });
  const path = join(target, 'page.png');
  await ctx.page.screenshot({ path, fullPage: true });
  // browser.json sits next to page.png so one evidence directory answers both "what was on
  // screen" and "what did the page and its API calls report". Written after the screenshot so a
  // failing screenshot (page already closed) does not also lose the diagnostics gathered before it.
  write(join(target, 'browser.json'), JSON.stringify({
    url: ctx.page.url?.() ?? null,
    ...(ctx.browserLog ?? {}),
  }, null, 2));
  return path;
}

// Step screenshots for a rehearsal a human wants to look at afterwards (the UX of a flow, not just
// its verdict). screenshot() above is KO-only evidence and writes a single page.png; snap() is
// called by the script at each step it wants recorded and numbers the shots in call order under
// <evidenceDir>/steps/NN-<label>.png. The first snap of a run wipes the steps dir so a re-run on
// the same day never mixes two runs' shots. A failing shot returns null rather than throwing: a
// picture is a by-product, and losing one must never turn a green scenario red.
//
// Before shooting, snap() waits for the page's finite Web Animations (dialog fade-ins, menu
// overlay fade-outs, CSS transitions) to finish. Without that, a shot taken right after a dialog
// opens catches it half transparent with the closing menu still on top of it. Infinite animations
// (spinners) are skipped, and the whole wait is capped at SNAP_SETTLE_CAP_MS so nothing can stall
// a row. A failed settle (navigation tearing the context down) still takes the shot.
export const SNAP_SETTLE_CAP_MS = 1000;

function settleAnimations(capMs) {
  const finite = document.getAnimations().filter(a => a.playState === 'running'
    && a.effect?.getComputedTiming().endTime !== Infinity);
  return Promise.race([
    Promise.all(finite.map(a => a.finished.catch(() => {}))),
    new Promise(resolve => setTimeout(resolve, capMs)),
  ]);
}

export async function snap(ctx, label, {
  today = () => new Date().toISOString().slice(0, 10),
  mkdir = mkdirSync,
  rm = rmSync,
} = {}) {
  if (!ctx.page) return null;
  const dir = join(REPO, evidenceDir(ctx.epic, ctx.id, today()), 'steps');
  try {
    if (!ctx.snapCount) {
      rm(dir, { recursive: true, force: true });
      mkdir(dir, { recursive: true });
      ctx.snapCount = 0;
    }
    ctx.snapCount += 1;
    const safe = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const path = join(dir, `${String(ctx.snapCount).padStart(2, '0')}-${safe}.png`);
    await ctx.page.evaluate(settleAnimations, SNAP_SETTLE_CAP_MS).catch(() => {});
    await ctx.page.screenshot({ path, fullPage: true });
    return path;
  } catch {
    return null;
  }
}
