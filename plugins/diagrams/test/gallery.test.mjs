import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES } from '../lib/rows.mjs';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(pluginDir, 'README.md'), 'utf8');

// Runs the generator inside a throwaway copy of the plugin, so a test never drifts the repo.
const inCopy = fn => {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-'));
  try { cpSync(pluginDir, dir, { recursive: true }); fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

test('the committed gallery matches a fresh render', () => {
  const r = spawnSync('node', ['scripts/gallery.mjs', '--check'], { cwd: pluginDir });
  assert.equal(r.status, 0, r.stdout.toString());
});

test('the gallery generator works from any working directory', () => {
  const r = spawnSync('node', [join(pluginDir, 'scripts', 'gallery.mjs'), '--check'], { cwd: join(pluginDir, '..', '..') });
  assert.equal(r.status, 0, r.stdout.toString() + r.stderr.toString());
});

test('the README gallery lists every kind', () => {
  for (const t of TYPES) assert.ok(readme.includes(`examples/${t}.svg`), t);
});

test('every kind has a json and an svg example', () => {
  const files = readdirSync(join(pluginDir, 'examples')).sort();
  assert.deepEqual(files, TYPES.flatMap(t => [`${t}.json`, `${t}.svg`]).sort());
});

test('--check fails and names the file when a generated file is altered', () => {
  inCopy(dir => {
    const target = join(dir, 'examples', 'tree.svg');
    writeFileSync(target, `${readFileSync(target, 'utf8')} `);
    const r = spawnSync('node', ['scripts/gallery.mjs', '--check'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stdout.toString(), /examples\/tree\.svg/);
    assert.doesNotMatch(r.stdout.toString(), /examples\/state\.svg/);
  });
});

test('--check fails when the README gallery block is altered', () => {
  inCopy(dir => {
    const target = join(dir, 'README.md');
    writeFileSync(target, readFileSync(target, 'utf8').replace('examples/erd.svg', 'examples/x.svg'));
    const r = spawnSync('node', ['scripts/gallery.mjs', '--check'], { cwd: dir });
    assert.equal(r.status, 1);
    assert.match(r.stdout.toString(), /README\.md/);
  });
});

test('generating twice gives the same bytes', () => {
  inCopy(dir => {
    const run = () => spawnSync('node', ['scripts/gallery.mjs'], { cwd: dir });
    const read = () => TYPES.map(t => readFileSync(join(dir, 'examples', `${t}.svg`), 'utf8')).concat(readFileSync(join(dir, 'README.md'), 'utf8'));
    assert.equal(run().status, 0);
    const first = read();
    assert.equal(run().status, 0);
    assert.deepEqual(read(), first);
  });
});

test('a gallery svg is standalone, with light and dark styles inside', () => {
  const svg = readFileSync(join(pluginDir, 'examples', 'sequence.svg'), 'utf8');
  assert.match(svg, /^<svg [^>]*><style>svg\.dg\{/);
  assert.match(svg, /prefers-color-scheme: ?dark/);
});

test('the README promise of zero dependencies holds', () => {
  try { assert.deepEqual(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).dependencies ?? {}, {}); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const d of ['lib', 'bin', 'scripts']) {
    for (const f of readdirSync(join(pluginDir, d))) {
      const src = readFileSync(join(pluginDir, d, f), 'utf8');
      for (const m of src.matchAll(/from '([^']+)'/g)) assert.match(m[1], /^(\.|node:)/, `${d}/${f}: ${m[1]}`);
    }
  }
});
