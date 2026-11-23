// Regenerates the README images: diagram SVGs, plan and dashboard screenshots, and the social preview.
// Run it as bin/readme-shots; importing it runs it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUDGET } from './budget.mjs';
import { findChrome, openBrowser } from './cdp.mjs';
import { renderDiagramAssets } from './diagrams.mjs';
import { buildDemoPlan } from './plan.mjs';
import { buildDemoDashboard } from './dashboard.mjs';
import { logoSvg, wordmarkSvg } from './logo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = path.join(root, '.github', 'assets');
const src = path.join(assets, 'src');
const SOCIAL = 'social-preview.png';

// The plan picture shows the stock tab, which the page opens for a #stock address: the settled
// D1 card beside the open D4 card, with its options and the answered thread from plan-thread.json.
// The capture fails rather than show less than the README describes.
const PLAN_TAB = 'stock';
const PLAN_VIEW = `(() => {
  const thread = document.querySelector('#D4 [data-thread]');
  const card = thread && thread.closest('article');
  if (!card || card.closest('[hidden]')) throw new Error('the D4 card and its thread are not on the page');
  if (card.getBoundingClientRect().bottom > innerHeight) throw new Error('the D4 card does not fit in the capture');
})()`;

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('no Chromium found: set CHROME to a Chromium or chrome-headless-shell binary');
    process.exit(1);
  }

  // Start the browser before anything is written, so a broken one leaves the assets as they were.
  let browser;
  try {
    browser = await openBrowser(chrome);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-shots-'));
  try {
    renderDiagramAssets(src, assets);
    fs.writeFileSync(path.join(assets, 'logo.svg'), logoSvg());
    for (const t of ['light', 'dark']) fs.writeFileSync(path.join(assets, `wordmark-${t}.svg`), wordmarkSvg(t));
    const plan = await buildDemoPlan(path.join(work, 'plan'));
    const dashboard = await buildDemoDashboard(path.join(work, 'dashboard'));

    for (const dark of [false, true]) {
      const t = dark ? 'dark' : 'light';
      await browser.shot(`${pathToFileURL(plan).href}#${PLAN_TAB}`, { out: path.join(assets, `plan-${t}.webp`), width: 1280, height: 1090, dark, prepare: PLAN_VIEW });
      await browser.shot(pathToFileURL(dashboard).href, { out: path.join(assets, `dashboard-${t}.webp`), width: 1280, height: 900, dark });
    }

    const social = path.join(src, 'social.html');
    if (fs.existsSync(social)) {
      await browser.shot(pathToFileURL(social).href, { out: path.join(assets, SOCIAL), width: 1280, height: 640, format: 'png' });
    } else {
      console.log(`skipped ${SOCIAL}: ${path.relative(root, social)} does not exist yet`);
    }
  } finally {
    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
  }

  let total = 0;
  for (const f of fs.readdirSync(assets).sort()) {
    const p = path.join(assets, f);
    if (!fs.statSync(p).isFile()) continue;
    const size = fs.statSync(p).size;
    if (f !== SOCIAL) total += size;
    console.log(`${String(size).padStart(9)}  ${f}${f === SOCIAL ? '  (not committed)' : ''}`);
  }
  console.log(`${String(total).padStart(9)}  total (budget ${BUDGET})`);
  if (total > BUDGET) {
    console.error(`over budget by ${total - BUDGET} bytes`);
    process.exit(1);
  }
}

// Always run: this file is only ever an entry point. A check that it is the main module
// compares a resolved path with the typed one, which differs through a symlink.
await main();
