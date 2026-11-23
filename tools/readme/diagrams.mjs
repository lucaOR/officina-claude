import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixedTheme } from './themes.mjs';

export const DIAGRAMS = ['checkout-sequence', 'catalogue-erd', 'handoff-loop'];

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'diagrams', 'bin', 'diagram.mjs');

export function renderDiagramAssets(srcDir, outDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-diagram-'));
  const written = [];
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const name of DIAGRAMS) {
      const raw = path.join(tmp, `${name}.svg`);
      const r = spawnSync(process.execPath, [CLI, path.join(srcDir, `${name}.json`), '--out', raw], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`diagram CLI failed for ${name}: ${r.stdout}${r.stderr}`);
      const svg = fs.readFileSync(raw, 'utf8');
      for (const theme of ['light', 'dark']) {
        const file = path.join(outDir, `${name}-${theme}.svg`);
        fs.writeFileSync(file, fixedTheme(svg, theme));
        written.push(file);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return written;
}
