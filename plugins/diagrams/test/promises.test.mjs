import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStandalone } from '../lib/standalone.mjs';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a standalone svg carries light and dark styles inside', () => {
  const { svg } = renderStandalone({ type: 'workflow', title: 'Release', rows: [['build', 'Build'], ['ship', 'Ship'], ['build > ship']] });
  assert.match(svg, /^<svg [^>]*><style>svg\.dg\{/);
  assert.match(svg, /prefers-color-scheme: ?dark/);
});

test('the README promise of zero dependencies holds', () => {
  try { assert.deepEqual(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).dependencies ?? {}, {}); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const d of ['lib', 'bin']) {
    for (const f of readdirSync(join(pluginDir, d))) {
      const src = readFileSync(join(pluginDir, d, f), 'utf8');
      for (const m of src.matchAll(/from '([^']+)'/g)) assert.match(m[1], /^(\.|node:)/, `${d}/${f}: ${m[1]}`);
    }
  }
});
