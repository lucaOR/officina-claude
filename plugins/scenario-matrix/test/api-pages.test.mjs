import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS_DIR = join(PLUGIN, 'runtime', 'adapters');
const FIVE = [
  '1. How is it stood up for real?',
  '2. How do you know it is ready, without waiting a fixed time?',
  '3. What deterministic marker shows it processed something?',
  '4. How do you force it to fail and undo that?',
  "5. What does it do that the others don't?",
];

const adapters = readdirSync(ADAPTERS_DIR).filter((n) => existsSync(join(ADAPTERS_DIR, n, 'adapter.json')));
const manifest = (name) => JSON.parse(readFileSync(join(ADAPTERS_DIR, name, 'adapter.json'), 'utf8'));
const apiPage = (name) => readFileSync(join(ADAPTERS_DIR, name, manifest(name).api), 'utf8');
const mentions = (page, name) => new RegExp(`\\b${name}\\b`).test(page);

test('every adapter api.md opens with the five answers', () => {
  assert.ok(adapters.length > 0);
  for (const name of adapters) {
    const lines = apiPage(name).split('\n').map((l) => l.trimEnd());
    let from = 0;
    for (const q of FIVE) {
      const at = lines.indexOf(q, from);
      assert.notEqual(at, -1, `${name}/api.md: missing or out of order: ${q}`);
      const answer = lines.slice(at + 1).find((l) => l.trim() !== '');
      assert.ok(answer && !FIVE.includes(answer), `${name}/api.md: no answer after: ${q}`);
      from = at + 1;
    }
  }
});

test('every adapter export appears in its api.md', () => {
  for (const name of adapters) {
    const page = apiPage(name);
    for (const [file, names] of Object.entries(manifest(name).exports)) {
      for (const n of names) assert.ok(mentions(page, n), `${name}/api.md does not mention ${n} (${file})`);
    }
  }
});

// Hook names as templates/hooks.mjs documents them: `group.member` or a bare name.
function templateHooks() {
  const hooks = new Set();
  let group = null;
  for (const line of readFileSync(join(PLUGIN, 'runtime/templates/hooks.mjs'), 'utf8').split('\n')) {
    const opens = line.match(/^\/\/ export const (\w+) = \{\s*$/);
    if (opens) { group = opens[1]; continue; }
    if (/^\/\/ \};/.test(line)) { group = null; continue; }
    const top = line.match(/^\/\/ (\w+(?:\.\w+)?)(?:\(| ->)/);
    if (top) { hooks.add(top[1]); continue; }
    const member = line.match(/^\/\/\s{3}\/\/ (\w+)(?:\(| ->)/);
    if (member && group) hooks.add(`${group}.${member[1]}`);
  }
  return hooks;
}

test('harness-api.md names every core export and every core hook', () => {
  const page = readFileSync(join(PLUGIN, 'reference/harness-api.md'), 'utf8');
  const core = JSON.parse(readFileSync(join(PLUGIN, 'runtime/core/core.json'), 'utf8'));
  const hooks = templateHooks();
  assert.ok(hooks.size >= 19, `the template should document the hooks, found: ${[...hooks]}`);
  const missing = [];
  for (const [file, names] of Object.entries(core.exports)) {
    for (const n of names) if (!mentions(page, n)) missing.push(`export ${n} (${file})`);
  }
  for (const h of hooks) if (!page.includes(h)) missing.push(`hook ${h}`);
  assert.deepEqual(missing, []);
});
