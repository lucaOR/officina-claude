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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = path.join(root, '.github', 'assets');
const src = path.join(assets, 'src');
const SOCIAL = 'social-preview.png';

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('no Chromium found: set CHROME to a Chromium or chrome-headless-shell binary');
    process.exit(1);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-shots-'));
  let browser;
  try {
    renderDiagramAssets(src, assets);
    const plan = await buildDemoPlan(path.join(work, 'plan'));
    const dashboard = await buildDemoDashboard(path.join(work, 'dashboard'));

    browser = await openBrowser(chrome);
    for (const dark of [false, true]) {
      const t = dark ? 'dark' : 'light';
      await browser.shot(pathToFileURL(plan).href, { out: path.join(assets, `plan-${t}.webp`), width: 1280, height: 860, dark });
      await browser.shot(pathToFileURL(dashboard).href, { out: path.join(assets, `dashboard-${t}.webp`), width: 1280, height: 900, dark });
    }

    const social = path.join(src, 'social.html');
    if (fs.existsSync(social)) {
      await browser.shot(pathToFileURL(social).href, { out: path.join(assets, SOCIAL), width: 1280, height: 640, format: 'png' });
    } else {
      console.log(`skipped ${SOCIAL}: ${path.relative(root, social)} does not exist yet`);
    }
  } finally {
    if (browser) await browser.close();
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
