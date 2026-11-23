import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = path.join(root, '.github', 'assets');
const SVG_NS = 'http://www.w3.org/2000/svg';
// GitHub's canvas colours, as in themes.mjs: each banner paints its own so it stays legible
// when the browser's colour scheme and the visitor's GitHub theme disagree.
const CANVAS = { light: '#ffffff', dark: '#0d1117' };

const banner = (theme) => path.join(assets, `banner-${theme}.svg`);

test('banner files are small fixed-theme SVGs', () => {
  for (const theme of ['light', 'dark']) {
    const file = banner(theme);
    assert.ok(fs.existsSync(file), `${file} is missing`);
    const size = fs.statSync(file).size;
    assert.ok(size < 8192, `${theme} banner is ${size} bytes`);
    const svg = fs.readFileSync(file, 'utf8');
    const rootTag = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
    assert.match(rootTag, /\sviewBox="0 0 1280 320"/, theme);
    assert.ok(!svg.includes('prefers-color-scheme'), theme);
    const urls = svg.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    assert.deepEqual(urls.filter((u) => u !== SVG_NS), [], theme);
    // The first thing drawn is a solid canvas over the whole viewBox.
    const drawn = svg.slice(svg.indexOf('</style>') + '</style>'.length).trimStart();
    assert.ok(drawn.startsWith(`<rect width="1280" height="320" fill="${CANVAS[theme]}"/>`), theme);
  }
});

test('banner chips name the marketplace plugins in order', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const names = marketplace.plugins.map((p) => p.name);
  for (const theme of ['light', 'dark']) {
    const svg = fs.readFileSync(banner(theme), 'utf8');
    const chips = svg.match(/<g class="chips"[^>]*>([\s\S]*?)<\/g>/)?.[1] ?? '';
    const labels = [...chips.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    assert.deepEqual(labels, names, theme);
  }
});
