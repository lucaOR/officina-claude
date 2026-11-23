import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixedTheme } from './themes.mjs';
import { renderDiagramAssets } from './diagrams.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = path.join(root, '.github', 'assets', 'src');
const DARK_BLOCK = /@media \(prefers-color-scheme: dark\)\{svg\.dg\{([^}]*)\}\}/;

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-diagrams-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function cliSvg() {
  return withTmp((dir) => {
    const out = path.join(dir, 'x.svg');
    const r = spawnSync(process.execPath, [path.join(root, 'plugins/diagrams/bin/diagram.mjs'), path.join(srcDir, 'checkout-sequence.json'), '--out', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(out, 'utf8');
  });
}

const panel = (s) => s.match(/--dg-panel:([^;}]*)/g);

test('fixedTheme light drops the dark media block', () => {
  const svg = cliSvg();
  const light = fixedTheme(svg, 'light');
  assert.ok(!light.includes('prefers-color-scheme'));
  assert.ok(light.includes('svg.dg{--dg-ink:var(--ink, #1d1d1f)'));
  assert.deepEqual(panel(light), [panel(svg)[0]]);
});

test('fixedTheme dark applies the dark variables unconditionally', () => {
  const svg = cliSvg();
  const dark = fixedTheme(svg, 'dark');
  assert.ok(!dark.includes('@media'));
  const darkPanel = svg.match(DARK_BLOCK)[1].match(/--dg-panel:([^;}]*)/)[0];
  assert.equal(panel(dark).at(-1), darkPanel);
  assert.ok(dark.indexOf(darkPanel) > dark.indexOf(panel(svg)[0]));
});

test('fixedTheme paints a full-size canvas rect beneath everything', () => {
  const svg = cliSvg();
  for (const [theme, fill] of [['light', '#ffffff'], ['dark', '#0d1117']]) {
    const out = fixedTheme(svg, theme);
    const after = out.slice(out.indexOf('</style>') + '</style>'.length);
    assert.ok(after.startsWith(`<rect width="100%" height="100%" fill="${fill}"/>`), theme);
  }
});

test('fixedTheme throws on an SVG without the dark block', () => {
  assert.throws(() => fixedTheme('<svg><style>svg.dg{--dg-panel:#fff}</style></svg>', 'dark'), /dark/);
  assert.throws(() => fixedTheme('<svg></svg>', 'light'), /dark/);
});

test('renderDiagramAssets writes a light and a dark file per spec', () => withTmp((dir) => {
  const written = renderDiagramAssets(srcDir, dir);
  assert.equal(written.length, 6);
  for (const name of ['checkout-sequence', 'catalogue-erd', 'handoff-loop']) {
    for (const theme of ['light', 'dark']) assert.ok(written.includes(path.join(dir, `${name}-${theme}.svg`)));
  }
  for (const f of written) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(s.startsWith('<svg'), f);
    assert.ok(!s.includes('prefers-color-scheme'), f);
  }
}));
