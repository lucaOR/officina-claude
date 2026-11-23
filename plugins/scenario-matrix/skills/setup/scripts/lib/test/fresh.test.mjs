import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog, resolveAdapters } from '../catalog.mjs';
import { missingNpm, plan } from '../plan.mjs';
import { apply } from '../apply.mjs';
import { readManifest } from '../manifest.mjs';
import { install } from '../install.mjs';
import { verify } from '../verify.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const FIXTURE = join(PLUGIN, 'test', 'fixtures', 'repos', 'laravel-mysql');
const PROPOSED = ['docker', 'mysql', 'laravel', 'sanctum', 'http', 'mailpit'];
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const scratch = prefix => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };

function freshRepo() {
  const repo = scratch('scn-fresh-');
  cpSync(FIXTURE, repo, { recursive: true });
  return repo;
}
const libOf = repo => join(repo, '.claude', 'scenarios', '_lib');
const infraOf = repo => join(repo, '.claude', 'scenarios', '_infra');
const setup = (repo, adapters = PROPOSED) => apply(repo, plan(repo, { adapters, mode: 'fresh' }));
const quiet = () => { const lines = []; return { lines, out: line => lines.push(line) }; };

// Runs an installed lib's tests the way a project's `npm test` does, offline: SCN_DOCKER_TESTS is
// unset, and a stand-in `docker` first on PATH logs any call that reaches it. Tests that need docker
// put their own fake first, so a logged call means a test reached for the real daemon.
function runInstalledTests(lib) {
  const shim = mkdtempSync(join(tmpdir(), 'scn-no-real-docker-'));
  const log = join(shim, 'calls.log');
  writeFileSync(join(shim, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`);
  chmodSync(join(shim, 'docker'), 0o755);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
  delete env.SCN_DOCKER_TESTS;
  // Under `node --test` this process carries NODE_TEST_CONTEXT, and a child `node --test` that
  // inherits it skips every file and exits 0, so the run would prove nothing.
  delete env.NODE_TEST_CONTEXT;
  const files = readdirSync(join(lib, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => join('test', f));
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: lib, encoding: 'utf8', env });
  const realDocker = existsSync(log) ? readFileSync(log, 'utf8') : '';
  rmSync(shim, { recursive: true, force: true });
  return { ...r, files, realDocker };
}

test('fresh setup writes core, chosen adapters, generated files and a manifest with the sha256 of each', () => {
  const repo = freshRepo();
  const { written } = setup(repo);
  const lib = libOf(repo);
  const manifest = readManifest(lib);
  assert.equal(manifest.version, JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version);
  assert.deepEqual(manifest.adapters, resolveAdapters(loadCatalog(PLUGIN), PROPOSED).map(a => a.name));
  assert.ok(manifest.adapters.includes('sql'), 'sql arrives through requires');
  assert.deepEqual(manifest.generated, ['adapters.mjs', 'index.mjs', 'harness-api.md']);
  for (const name of ['run.mjs', 'adapter-docker.mjs', 'db.mjs', 'test/run.test.mjs', 'test/support/run-scenario.mjs']) {
    assert.ok(name in manifest.files, `${name} is recorded`);
  }
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(sha(join(lib, name)), hash, name);
  for (const name of ['hooks.mjs', 'project-exports.mjs', 'project-api.md', 'scenarios.config.json', 'package.json', '.gitignore']) {
    assert.ok(existsSync(join(lib, name)), `${name} exists`);
    assert.ok(!(name in manifest.files), `${name} is project-owned`);
  }
  for (const name of manifest.generated) assert.ok(existsSync(join(lib, name)));
  assert.equal(written.at(-1), join('.claude', 'scenarios', '_lib', '.plugin-manifest.json'), 'the manifest is written last');
  assert.ok(existsSync(join(repo, '.claude', 'scenarios', 'README.md')));
  assert.ok(existsSync(join(repo, '.claude', 'scenarios', 'AUTHORING.md')));
});

test('index.mjs exports exactly the core names plus the chosen adapters\' names', async () => {
  const repo = freshRepo();
  setup(repo);
  symlinkSync(join(PLUGIN, 'node_modules'), join(repo, 'node_modules'), 'dir');
  const catalog = loadCatalog(PLUGIN);
  const expected = new Set(Object.values(catalog.core.exports).flat());
  for (const a of resolveAdapters(catalog, PROPOSED)) for (const names of Object.values(a.exports ?? {})) names.forEach(n => expected.add(n));
  const mod = await import(pathToFileURL(join(libOf(repo), 'index.mjs')).href);
  assert.deepEqual(Object.keys(mod).sort(), [...expected].sort());
});

test('package.json gets only the chosen adapters\' dependencies', () => {
  const repo = freshRepo();
  setup(repo);
  const pkg = JSON.parse(readFileSync(join(libOf(repo), 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, { yaml: '2.9.1' });
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs');
  assert.deepEqual(pkg.engines, { node: '>=20' });
  const other = freshRepo();
  setup(other, [...PROPOSED, 'browser']);
  assert.deepEqual(JSON.parse(readFileSync(join(libOf(other), 'package.json'), 'utf8')).dependencies, { yaml: '2.9.1', playwright: '1.61.1' });
});

test('an existing package.json keeps its pins and its "//" comment', () => {
  const repo = freshRepo();
  mkdirSync(libOf(repo), { recursive: true });
  const before = { '//': 'pinned on purpose', name: 'mine', private: true, type: 'module', scripts: { test: 'node --test' }, dependencies: { yaml: '2.0.0' }, devDependencies: { left: '1.0.0' } };
  writeFileSync(join(libOf(repo), 'package.json'), JSON.stringify(before, null, 2) + '\n');
  const p = plan(repo, { adapters: [...PROPOSED, 'browser'], mode: 'fresh' });
  assert.deepEqual(p.npmAdd, { playwright: '1.61.1' });
  apply(repo, p);
  const after = JSON.parse(readFileSync(join(libOf(repo), 'package.json'), 'utf8'));
  assert.deepEqual(after, { ...before, dependencies: { yaml: '2.0.0', playwright: '1.61.1' } });
  assert.deepEqual(Object.keys(after), Object.keys(before));
});

test('infra templates never overwrite an existing file', () => {
  const repo = freshRepo();
  mkdirSync(infraOf(repo), { recursive: true });
  writeFileSync(join(infraOf(repo), 'up.sh'), 'mine\n');
  mkdirSync(libOf(repo), { recursive: true });
  writeFileSync(join(libOf(repo), 'hooks.mjs'), 'export const mine = 1;\n');
  setup(repo);
  assert.equal(readFileSync(join(infraOf(repo), 'up.sh'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(libOf(repo), 'hooks.mjs'), 'utf8'), 'export const mine = 1;\n');
  assert.ok(existsSync(join(infraOf(repo), 'down.sh')));
  assert.ok(existsSync(join(infraOf(repo), 'baseline.sh')));
});

test('fresh setup wires the lifecycle to the placeholder infra scripts, and up.sh refuses with the refused exit', () => {
  const repo = freshRepo();
  setup(repo);
  const config = JSON.parse(readFileSync(join(libOf(repo), 'scenarios.config.json'), 'utf8'));
  assert.equal(config.lifecycle.up, 'bash .claude/scenarios/_infra/up.sh');
  assert.equal(config.lifecycle.down, 'bash .claude/scenarios/_infra/down.sh');
  assert.equal(config.reset.baseline, 'bash .claude/scenarios/_infra/baseline.sh');
  assert.equal(config.adapters.laravel.defaultWorkdir, '/var/www/html');
  const up = spawnSync('bash', [join(infraOf(repo), 'up.sh')], { encoding: 'utf8' });
  assert.equal(up.status, config.lifecycle.refusedExit);
  assert.match(up.stderr + up.stdout, /up\.sh/);
  assert.equal(spawnSync('bash', [join(infraOf(repo), 'down.sh')], { encoding: 'utf8' }).status, 0);
  // A baseline that did nothing would let one row's writes leak into the next, so the placeholder
  // fails every row's reset until the project writes its own.
  const baseline = spawnSync('bash', [join(infraOf(repo), 'baseline.sh')], { encoding: 'utf8' });
  assert.equal(baseline.status, 78);
  assert.match(baseline.stderr, /baseline\.sh is a placeholder/);
});

test('a fresh plan leaves the adopt fields empty and merges system packages per distro', () => {
  const repo = freshRepo();
  const p = plan(repo, { adapters: [...PROPOSED, 'browser'], mode: 'fresh' });
  assert.equal(p.mode, 'fresh');
  for (const key of ['replace', 'keep', 'projectExportLines', 'testsReplaced', 'skillMentions']) assert.deepEqual(p[key], [], key);
  assert.deepEqual(p.postInstall, ['npx playwright install chromium']);
  assert.deepEqual(p.systemPackages, { debian: ['libasound2t64'] });
  assert.deepEqual(p.generated, ['adapters.mjs', 'index.mjs', 'harness-api.md']);
  assert.equal(p.infra.length, 3);
  assert.throws(() => plan(repo, { adapters: PROPOSED, mode: 'adopt' }), /adopt/);
});

test('the installed lib passes its own tests', () => {
  const repo = freshRepo();
  setup(repo);
  symlinkSync(join(PLUGIN, 'node_modules'), join(repo, 'node_modules'), 'dir');
  const r = runInstalledTests(libOf(repo));
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-1000));
  assert.equal(r.realDocker, '', 'the installed tests stay offline');
});

test('install runs npm install then each post-install command and never sudo', () => {
  const repo = freshRepo();
  setup(repo);
  const calls = [];
  const run = (command, args, opts) => { calls.push({ command, args, cwd: opts.cwd }); return { status: 0 }; };
  const { lines, out } = quiet();
  install(repo, { postInstall: ['npx playwright install chromium'], systemPackages: { debian: ['libasound2t64'] } }, { run, out });
  assert.deepEqual(calls.map(c => [c.command, ...c.args]), [['npm', 'install'], ['npx', 'playwright', 'install', 'chromium']]);
  assert.equal(calls[0].cwd, libOf(repo));
  assert.ok(!calls.some(c => [c.command, ...c.args].includes('sudo')));
  assert.ok(lines.some(l => /debian/.test(l) && /libasound2t64/.test(l)), 'system packages are printed per distro');
  assert.throws(() => install(repo, { postInstall: ['sudo apt install x'] }, { run, out }), /sudo/);
  assert.throws(() => install(repo, { postInstall: [] }, { run: () => ({ status: 1 }), out }), /npm install/);
});

test('verify runs selftest only with --live', () => {
  const repo = freshRepo();
  setup(repo);
  writeFileSync(join(repo, '.claude', 'scenarios', 'demo.yaml'), 'epic: demo\n');
  const record = () => {
    const calls = [];
    return { calls, run: (command, args) => { calls.push([command, ...args].map(a => a.replace(/^_lib\//, '')).join(' ')); return { status: 0 }; } };
  };
  const offline = record();
  const { lines, out } = quiet();
  const result = verify(repo, { live: false }, { run: offline.run, out });
  assert.deepEqual(offline.calls, ['node check.mjs demo.yaml', 'node lint.mjs demo', 'node run.mjs demo --plan', "node --input-type=module -e await import('./index.mjs')", 'npm test']);
  assert.equal(result.ok, true);
  assert.ok(lines.some(l => /selftest/.test(l) && /skipped/.test(l)));
  const live = record();
  verify(repo, { live: true }, { run: live.run, out });
  assert.ok(live.calls.includes('node selftest.mjs demo'));
  const failing = verify(repo, { live: false }, { run: () => ({ status: 1 }), out });
  assert.equal(failing.ok, false);
});

test('verify fails when index.mjs cannot be imported, as a kept lever naming a dropped export would', () => {
  const repo = freshRepo();
  setup(repo);
  symlinkSync(join(PLUGIN, 'node_modules'), join(repo, 'node_modules'), 'dir');
  // Only the import check really runs; the other checks are faked as passing.
  const run = (command, args, { cwd }) => (args[0] === '--input-type=module' ? spawnSync(command, args, { cwd, encoding: 'utf8' }) : { status: 0 });
  const { lines, out } = quiet();
  assert.equal(verify(repo, {}, { run, out }).ok, true, lines.join('\n'));
  writeFileSync(join(libOf(repo), 'project-exports.mjs'), "export { gone } from './no-such-module.mjs';\n");
  const broken = verify(repo, {}, { run, out });
  assert.equal(broken.ok, false);
  assert.match(broken.rows.find(r => r.check === 'import index.mjs').result, /^fail/);
});

test('missingNpm counts a pin in devDependencies as present', () => {
  const catalog = loadCatalog(PLUGIN);
  const chosen = resolveAdapters(catalog, ['browser']);
  assert.deepEqual(missingNpm(catalog, chosen, { devDependencies: { yaml: '2.0.0' } }), { playwright: '1.61.1' });
  assert.deepEqual(missingNpm(catalog, chosen, { dependencies: { playwright: '1' }, devDependencies: { yaml: '2' } }), {});
});

test('fresh setup on node-postgres passes its own tests', () => {
  const repo = scratch('scn-fresh-pg-');
  cpSync(join(PLUGIN, 'test', 'fixtures', 'repos', 'node-postgres'), repo, { recursive: true });
  apply(repo, plan(repo, { adapters: ['docker', 'postgres', 'http'], mode: 'fresh' }));
  symlinkSync(join(PLUGIN, 'node_modules'), join(repo, 'node_modules'), 'dir');
  const lib = libOf(repo);
  assert.ok(readManifest(lib).adapters.includes('sql'), 'sql arrives through requires');
  const r = runInstalledTests(lib);
  assert.ok(r.files.includes(join('test', 'db-postgres.test.mjs')), 'the postgres tests are installed');
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-1000));
  assert.equal(r.realDocker, '', 'the Docker-backed postgres test waits for SCN_DOCKER_TESTS=1, so nothing reaches docker');
  assert.match(r.stdout, /SCN_DOCKER_TESTS=1/, 'the gated test says how to run it');
});
