import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadCatalog } from '../catalog.mjs';
import { detect } from '../detect.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const REPOS = join(PLUGIN, 'test', 'fixtures', 'repos');
const catalog = loadCatalog(PLUGIN);

const put = (root, rel, text = '') => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const tmpRepo = () => mkdtempSync(join(tmpdir(), 'scn-detect-'));

test('the laravel-mysql fixture proposes docker, mysql, laravel, sanctum, http and mailpit with evidence', () => {
  const found = detect(join(REPOS, 'laravel-mysql'), catalog);
  assert.equal(found.mode, 'fresh');
  assert.deepEqual(found.adapters.map(a => a.name).sort(), ['docker', 'http', 'laravel', 'mailpit', 'mysql', 'sanctum']);
  const byName = Object.fromEntries(found.adapters.map(a => [a.name, a.evidence]));
  assert.ok(byName.docker.some(e => e.file === 'docker-compose.yml'));
  assert.ok(byName.laravel.some(e => e.file === 'artisan'));
  assert.ok(byName.laravel.some(e => e.file === 'composer.json' && e.line === 4));
  assert.ok(byName.sanctum.some(e => e.file === 'composer.json' && e.line === 5));
  assert.ok(byName.mysql.some(e => e.file === 'docker-compose.yml' && e.line === 3));
  assert.ok(byName.mysql.some(e => e.file === '.env.example' && e.line === 2));
  assert.ok(byName.mailpit.some(e => e.file === 'docker-compose.yml' && e.line === 5));
  assert.deepEqual(byName.http, [{ file: null, line: null, signal: 'always' }]);
  assert.deepEqual(found.assets.compose, ['docker-compose.yml']);
});

test('assets list runnable scripts, package.json scripts and the login state file', () => {
  const { assets } = detect(join(REPOS, 'laravel-mysql'), catalog);
  assert.deepEqual(assets.scripts, ['seed-db.sh', 'npm run dev', 'npm run test']);
  assert.equal(assets.loginState, 'storage-state.json');
  assert.equal(detect(join(REPOS, 'small-harness'), catalog).assets.loginState, null);
});

test('the small harness is adopt mode and lists its lib files', () => {
  const found = detect(join(REPOS, 'small-harness'), catalog);
  assert.equal(found.mode, 'adopt');
  assert.deepEqual(found.assets.harness.libFiles, ['README.md', 'db.mjs', 'index.mjs', 'package.json', 'widgets.mjs']);
  assert.deepEqual(found.assets.harness.matrices, ['notes.yaml']);
  assert.deepEqual(found.assets.harness.scripts, ['notes/A-01.mjs']);
  assert.deepEqual(found.assets.harness.infra, []);
});

test('a repo with a manifest is upgrade mode', () => {
  const repo = tmpRepo();
  put(repo, '.claude/scenarios/_lib/index.mjs', 'export {};\n');
  put(repo, '.claude/scenarios/_lib/.plugin-manifest.json', '{}\n');
  assert.equal(detect(repo, catalog).mode, 'upgrade');
});

test('registry keys of a matrix and manifests below the root are read', () => {
  const repo = tmpRepo();
  put(repo, '.claude/scenarios/m.yaml', 'epic: m\ninfra:\n  env_registry:\n    db: {}\n    mail: {}\n');
  put(repo, '.claude/scenarios/broken.yaml', 'a: [unclosed\n');
  put(repo, 'apps/web/package.json', '{ "devDependencies": {\n "@playwright/test": "1"\n } }');
  const byName = Object.fromEntries(detect(repo, catalog).adapters.map(a => [a.name, a.evidence]));
  assert.deepEqual(byName.mysql, [{ file: '.claude/scenarios/m.yaml', line: 4, signal: 'registryKey db' }]);
  assert.equal(byName.mailpit[0].line, 5);
  assert.equal(byName.browser[0].file, 'apps/web/package.json');
  assert.equal(byName.browser[0].line, 2);
});

test('node_modules and vendor are never searched, at any level', () => {
  const repo = tmpRepo();
  const dep = '{ "dependencies": { "laravel/framework": "1" } }';
  put(repo, 'node_modules/composer.json', dep);
  put(repo, 'vendor/composer.json', dep);
  put(repo, 'sub/node_modules/composer.json', dep);
  put(repo, 'sub/vendor/composer.json', dep);
  put(repo, 'a/b/vendor/composer.json', dep);
  put(repo, 'vendor/pkg/docker-compose.yml', 'image: mysql:8\n');
  const found = detect(repo, catalog);
  assert.deepEqual(found.adapters.map(a => a.name), ['http']);
  assert.deepEqual(found.assets.compose, []);
  put(repo, 'sub/composer.json', dep);
  const laravel = detect(repo, catalog).adapters.find(a => a.name === 'laravel');
  assert.deepEqual(laravel.evidence.map(e => e.file), ['sub/composer.json']);
});

test('the walk reaches a/b/file and no deeper', () => {
  const repo = tmpRepo();
  const dep = '{ "dependencies": { "laravel/framework": "1" } }';
  put(repo, 'a/b/composer.json', dep);
  put(repo, 'a/b/c/composer.json', dep);
  put(repo, 'x/y/z/composer.json', dep);
  const laravel = detect(repo, catalog).adapters.find(a => a.name === 'laravel');
  assert.deepEqual(laravel.evidence.map(e => e.file), ['a/b/composer.json']);
});

test('an unreadable directory is skipped instead of aborting the detect', t => {
  if (process.getuid?.() === 0) return t.skip('root ignores permission bits');
  const repo = tmpRepo();
  put(repo, 'data/mysql/file');
  put(repo, 'ok/composer.json', '{ "dependencies": { "laravel/framework": "1" } }');
  const locked = join(repo, 'data', 'mysql');
  chmodSync(locked, 0o000);
  t.after(() => chmodSync(locked, 0o755));
  const laravel = detect(repo, catalog).adapters.find(a => a.name === 'laravel');
  assert.deepEqual(laravel.evidence.map(e => e.file), ['ok/composer.json']);
});

test('the node-postgres fixture proposes docker, postgres and http with evidence', () => {
  const found = detect(join(REPOS, 'node-postgres'), catalog);
  assert.deepEqual(found.adapters.map(a => a.name).sort(), ['docker', 'http', 'postgres']);
  const byName = Object.fromEntries(found.adapters.map(a => [a.name, a.evidence]));
  assert.ok(byName.postgres.some(e => e.file === 'docker-compose.yml' && e.line === 3));
  assert.ok(byName.postgres.some(e => e.file === 'package.json'));
});

test('a generic db registry key alone does not propose postgres', () => {
  const repo = tmpRepo();
  put(repo, '.claude/scenarios/m.yaml', 'epic: m\ninfra:\n  env_registry:\n    db: {}\n');
  assert.ok(!detect(repo, catalog).adapters.some(a => a.name === 'postgres'));
});

test('registry keys are found by indentation: quoted keys, comments, nested maps and block scalars', () => {
  const repo = tmpRepo();
  put(repo, '.claude/scenarios/m.yaml', [
    '---',
    'notes: |',
    '  infra:',
    '    env_registry:',
    '      stubs: {}',
    'infra: &infra',
    '  provisioning: make up',
    '  env_registry: # the facts',
    '    # a comment line',
    '',
    '    "db": {}',
    "    'mail': {}",
    '    exec:',
    '      app: { container: web }',
    '      login: nested, not a registry key',
    '    log_sources: |',
    '      fault_containers: inside a block scalar',
    '  teardown: make down',
    'scenarios: []',
  ].join('\n'));
  const found = detect(repo, catalog).adapters;
  const registryEvidence = found.flatMap(a => a.evidence.filter(e => e.signal.startsWith('registryKey')).map(e => [e.signal, e.line]));
  assert.deepEqual(registryEvidence.sort(), [['registryKey db', 11], ['registryKey exec', 13], ['registryKey log_sources', 16], ['registryKey mail', 12]]);
});

test('a flow-style registry and a registry outside the top-level infra yield no keys', () => {
  const repo = tmpRepo();
  put(repo, '.claude/scenarios/a.yaml', 'infra:\n  env_registry: {db: x}\n');
  put(repo, '.claude/scenarios/b.yaml', 'scenarios:\n  - id: A-01\n    infra:\n      env_registry:\n        db: x\n');
  assert.ok(!detect(repo, catalog).adapters.some(a => a.evidence.some(e => e.signal.startsWith('registryKey'))));
});
