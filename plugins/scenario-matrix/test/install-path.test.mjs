// An installed plugin is a copy of the repository, and node_modules is gitignored, so it has none.
// setup.mjs must run from such a copy: these tests make one and drive setup from it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(PLUGIN, 'test', 'fixtures', 'repos');
const ADAPTERS = 'docker,mysql,laravel,sanctum,http,mailpit';

let root;
let installed;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'scn-install-path-'));
  installed = join(root, 'scenario-matrix');
  cpSync(PLUGIN, installed, { recursive: true, filter: src => basename(src) !== 'node_modules' });
});
after(() => rmSync(root, { recursive: true, force: true }));

const setup = (...args) => spawnSync(process.execPath, [join(installed, 'skills', 'setup', 'scripts', 'setup.mjs'), ...args], { encoding: 'utf8' });
const repoCopy = name => {
  const repo = mkdtempSync(join(root, `${name}-`));
  cpSync(join(FIXTURES, name), repo, { recursive: true });
  return repo;
};

test('the install-shaped copy has no npm package to lean on', () => {
  assert.equal(existsSync(join(installed, 'node_modules')), false);
  assert.throws(() => createRequire(join(installed, 'package.json')).resolve('yaml'), /Cannot find module/);
});

test('detect runs from the copy and proposes the fixture\'s adapters', () => {
  const r = setup('detect', join(FIXTURES, 'laravel-mysql'), '--json');
  assert.equal(r.status, 0, r.stderr);
  const found = JSON.parse(r.stdout);
  assert.equal(found.mode, 'fresh');
  assert.deepEqual(found.adapters.map(a => a.name).sort(), ['docker', 'http', 'laravel', 'mailpit', 'mysql', 'sanctum']);
});

test('detect from the copy reads a matrix\'s registry keys', () => {
  const repo = mkdtempSync(join(root, 'registry-'));
  mkdirSync(join(repo, '.claude', 'scenarios'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'scenarios', 'm.yaml'), 'epic: m\ninfra:\n  env_registry:\n    db: {}\n    mail: {}\n');
  const r = setup('detect', repo, '--json');
  assert.equal(r.status, 0, r.stderr);
  const byName = Object.fromEntries(JSON.parse(r.stdout).adapters.map(a => [a.name, a.evidence]));
  assert.deepEqual(byName.mysql, [{ file: '.claude/scenarios/m.yaml', line: 4, signal: 'registryKey db' }]);
  assert.deepEqual(byName.mailpit, [{ file: '.claude/scenarios/m.yaml', line: 5, signal: 'registryKey mail' }]);
});

test('plan and apply run from the copy', () => {
  const repo = repoCopy('laravel-mysql');
  const plan = setup('plan', repo, '--adapters', ADAPTERS, '--json');
  assert.equal(plan.status, 0, plan.stderr);
  const p = JSON.parse(plan.stdout);
  assert.equal(p.mode, 'fresh');
  assert.ok(p.adapters.includes('sql'), 'sql arrives through requires');
  const apply = setup('apply', repo, '--adapters', ADAPTERS);
  assert.equal(apply.status, 0, apply.stderr);
  const manifest = JSON.parse(readFileSync(join(repo, '.claude', 'scenarios', '_lib', '.plugin-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.adapters, p.adapters);
});

test('no setup script imports an npm package', () => {
  const dir = join(PLUGIN, 'skills', 'setup', 'scripts');
  const sources = readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.mjs') && !f.split(sep).includes('test'));
  assert.ok(sources.length > 5, 'the setup scripts were found');
  for (const file of sources) {
    const specs = [...readFileSync(join(dir, file), 'utf8').matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    for (const spec of specs) assert.match(spec, /^(node:|\.\.?\/)/, `${file} imports ${spec}`);
  }
});
