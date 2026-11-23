import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_ROWS, LOGO_COLOURS, logoSvg, wordmarkSvg } from './logo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(root, '.github', 'assets', 'logo.svg');
const SVG_NS = 'http://www.w3.org/2000/svg';

test('committed logo.svg matches logoSvg()', () => {
  assert.equal(fs.readFileSync(file, 'utf8'), logoSvg());
});

test('every grid row has the same width and only known colour keys', () => {
  assert.equal(LOGO_ROWS.length, 14);
  for (const row of LOGO_ROWS) {
    assert.equal(row.length, 19, row);
    assert.match(row, /^[.oyYg]+$/, row);
  }
  assert.deepEqual(Object.keys(LOGO_COLOURS).sort(), ['Y', 'g', 'o', 'y']);
});

test("the hat brim spans the mascot's arms", () => {
  const brim = LOGO_ROWS.find((r) => r.includes('Y') && !r.includes('o') && !r.includes('y'));
  assert.ok(brim, 'no brim row');
  const arms = LOGO_ROWS.filter((r) => r.startsWith('.o'));
  assert.ok(arms.length >= 2);
  for (const arm of arms) {
    assert.equal(brim.indexOf('Y'), arm.indexOf('o'));
    assert.equal(brim.lastIndexOf('Y'), arm.lastIndexOf('o'));
  }
});

test('the logo has no background', () => {
  const svg = logoSvg();
  for (const m of svg.matchAll(/<rect\b[^>]*>/g)) {
    const w = m[0].match(/\bwidth="(\d+)"/)[1];
    const h = m[0].match(/\bheight="(\d+)"/)[1];
    assert.ok(!(w === '19' && h === '14'), m[0]);
  }
});

test('logo.svg is small and self-contained', () => {
  const svg = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(svg) < 4096);
  const urls = svg.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  assert.deepEqual(urls.filter((u) => u !== SVG_NS), []);
  assert.ok(svg.endsWith('\n'));
  assert.match(svg, /viewBox="0 0 19 14"/);
});

const INK = { light: '#1d1d1f', dark: '#e6edf3' };
const wordmarkFile = (t) => path.join(root, '.github', 'assets', `wordmark-${t}.svg`);

test('committed wordmarks match wordmarkSvg()', () => {
  for (const t of ['light', 'dark']) assert.equal(fs.readFileSync(wordmarkFile(t), 'utf8'), wordmarkSvg(t), t);
});

test('the wordmark colours -claude terracotta', () => {
  for (const t of ['light', 'dark']) {
    const svg = fs.readFileSync(wordmarkFile(t), 'utf8');
    assert.match(svg, /<tspan\b[^>]*fill="#D97757"[^>]*>-claude<\/tspan>/, t);
    assert.match(svg, new RegExp(`<text\\b[^>]*fill="${INK[t]}"[^>]*>officina<tspan`), t);
  }
});

test('the wordmarks are small and self-contained', () => {
  for (const t of ['light', 'dark']) {
    const svg = fs.readFileSync(wordmarkFile(t), 'utf8');
    assert.ok(!svg.includes('prefers-color-scheme'), t);
    assert.ok(Buffer.byteLength(svg) < 4096, t);
    assert.ok(svg.endsWith('\n'), t);
    const urls = svg.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    assert.deepEqual(urls.filter((u) => u !== SVG_NS), [], t);
  }
  assert.throws(() => wordmarkSvg('sepia'));
});

test('the wordmark background is the theme canvas', () => {
  const CANVAS = { light: '#ffffff', dark: '#0d1117' };
  for (const t of ['light', 'dark']) {
    const svg = fs.readFileSync(wordmarkFile(t), 'utf8');
    const rects = svg.match(/<rect\b[^>]*>/g) ?? [];
    assert.equal(rects.length, 1, t);
    assert.equal(rects[0], `<rect width="760" height="112" fill="${CANVAS[t]}"/>`, t);
    assert.ok(svg.indexOf('<rect') < svg.indexOf('<text'), t);
  }
});
