import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../catalog.mjs';
import { plan } from '../plan.mjs';
import { apply } from '../apply.mjs';
import { readManifest, MANIFEST } from '../manifest.mjs';
import { upgrade, add } from '../upgrade.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const FIXTURE = join(PLUGIN, 'test', 'fixtures', 'repos', 'laravel-mysql');
const SETUP = join(PLUGIN, 'skills', 'setup', 'scripts', 'setup.mjs');
const SCN = join('.claude', 'scenarios');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const cli = (repo, ...args) => spawnSync(process.execPath, [SETUP, args[0], repo, ...args.slice(1)], { encoding: 'utf8' });

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

// A fresh lib with the given adapters; a fake runner records every command and always succeeds.
function freshRepo(adapters = ['sql']) {
  const repo = mkdtempSync(join(tmpdir(), 'scn-upgrade-'));
  made.push(repo);
  cpSync(FIXTURE, repo, { recursive: true });
  apply(repo, plan(repo, { adapters, mode: 'fresh' }));
  return repo;
}
const lib = (repo, ...p) => join(repo, SCN, '_lib', ...p);
const seam = () => { const ran = []; return { ran, run: (command, args) => { ran.push([command, ...args].join(' ')); return { status: 0 }; }, out: () => {} }; };
const pluginFile = name => join(PLUGIN, 'runtime', name.startsWith('db') || name.startsWith('adapter-sql') ? 'adapters/sql' : 'core', name);
const writeManifestFiles = (repo, patch) => {
  const file = lib(repo, MANIFEST);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  patch(manifest);
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
};
// Makes the lib look as if an older plugin wrote `name`: different content, matching the manifest.
function ageFile(repo, name) {
  writeFileSync(lib(repo, name), `// old plugin version\n${readFileSync(pluginFile(name), 'utf8')}`);
  writeManifestFiles(repo, m => { m.files[name] = sha(lib(repo, name)); });
}
const snapshot = dir => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => [join(e.parentPath, e.name), sha(join(e.parentPath, e.name))]));

test('upgrade replaces untouched plugin files', () => {
  const repo = freshRepo();
  ageFile(repo, 'db.mjs');
  writeManifestFiles(repo, m => { m.version = '0.0.1'; });
  const { run, out, ran } = seam();
  const result = upgrade(repo, {}, { run, out });
  assert.equal(sha(lib(repo, 'db.mjs')), sha(pluginFile('db.mjs')));
  assert.ok(result.replaced.includes('db.mjs'));
  assert.deepEqual(result.edited, []);
  const manifest = readManifest(lib(repo));
  assert.equal(manifest.version, JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version);
  for (const [name, hash] of Object.entries(manifest.files)) assert.equal(sha(lib(repo, name)), hash, name);
  assert.ok(ran.includes('npm test'), 'verify ran through the injected runner');
  assert.ok(result.verify.ok);
});

test('upgrade stops on an edited plugin file and lists it', () => {
  const repo = freshRepo();
  writeFileSync(lib(repo, 'lint.mjs'), `${readFileSync(lib(repo, 'lint.mjs'), 'utf8')}// my tweak\n`);
  writeFileSync(lib(repo, 'check.mjs'), `${readFileSync(lib(repo, 'check.mjs'), 'utf8')}// another tweak\n`);
  ageFile(repo, 'db.mjs');
  const before = snapshot(join(repo, SCN));
  assert.throws(() => upgrade(repo, {}, seam()), err => err.exitCode === 5
    && /lint\.mjs/.test(err.message) && /check\.mjs/.test(err.message)
    && /^diff --git/m.test(err.message) && /\+\/\/ my tweak/.test(err.message));
  assert.deepEqual(snapshot(join(repo, SCN)), before, 'nothing written, not even the untouched file');
  const run = cli(repo, 'upgrade');
  assert.equal(run.status, 5, run.stderr);
  assert.match(run.stderr, /lint\.mjs/);
  assert.deepEqual(snapshot(join(repo, SCN)), before);
});

test('--take overwrites and --keep preserves an edited file, both recorded in the manifest', () => {
  const repo = freshRepo();
  const core = loadCatalog(PLUGIN).core;
  const exported = Object.values(core.exports).flat()[0];
  writeManifestFiles(repo, m => { m.previousExports = [exported]; });
  const mine = `${readFileSync(lib(repo, 'lint.mjs'), 'utf8')}// mine\n`;
  writeFileSync(lib(repo, 'lint.mjs'), mine);
  writeFileSync(lib(repo, 'check.mjs'), `${readFileSync(lib(repo, 'check.mjs'), 'utf8')}// theirs\n`);
  const original = readManifest(lib(repo)).files;

  const result = upgrade(repo, { take: ['check.mjs'], keep: ['lint.mjs', 'no-such-file.mjs'] }, seam());
  assert.deepEqual(result.kept, ['lint.mjs']);
  assert.equal(readFileSync(lib(repo, 'lint.mjs'), 'utf8'), mine);
  assert.equal(sha(lib(repo, 'check.mjs')), sha(join(PLUGIN, 'runtime', 'core', 'check.mjs')));
  let manifest = readManifest(lib(repo));
  assert.deepEqual(manifest.kept, ['lint.mjs']);
  assert.equal(manifest.files['lint.mjs'], original['lint.mjs'], 'the kept edit stays detectable');
  assert.equal(manifest.files['check.mjs'], original['check.mjs']);
  assert.deepEqual(manifest.previousExports, [exported], 'previousExports carried forward');

  const again = upgrade(repo, {}, seam());
  assert.deepEqual(again.kept, ['lint.mjs'], 'a kept path is kept again without a flag');
  assert.equal(readFileSync(lib(repo, 'lint.mjs'), 'utf8'), mine);

  const taken = upgrade(repo, { take: ['lint.mjs'] }, seam());
  assert.deepEqual(taken.kept, []);
  manifest = readManifest(lib(repo));
  assert.equal(manifest.kept, undefined, 'taking a path removes it from kept');
  assert.equal(sha(lib(repo, 'lint.mjs')), sha(join(PLUGIN, 'runtime', 'core', 'lint.mjs')));
  assert.deepEqual(manifest.previousExports, [exported]);
});

test('a path in both --take and --keep is a usage error', () => {
  const repo = freshRepo();
  const run = cli(repo, 'upgrade', '--take', 'lint.mjs', '--keep', 'lint.mjs');
  assert.equal(run.status, 64, run.stderr);
});

test('add brings in requires and regenerates the index', () => {
  const repo = freshRepo(['docker']);
  const config = JSON.parse(readFileSync(lib(repo, 'scenarios.config.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(lib(repo, 'package.json'), 'utf8'));
  pkg.dependencies.yaml = '1.0.0';
  writeFileSync(lib(repo, 'package.json'), JSON.stringify(pkg, null, 2));
  const { run, out, ran } = seam();
  const result = add(repo, 'mysql', {}, { run, out });
  assert.deepEqual(result.added.sort(), ['mysql', 'sql']);
  const manifest = readManifest(lib(repo));
  assert.deepEqual([...manifest.adapters].sort(), ['docker', 'mysql', 'sql']);
  for (const name of ['db.mjs', 'adapter-sql.mjs']) assert.ok(name in manifest.files && existsSync(lib(repo, name)), name);
  const index = readFileSync(lib(repo, 'index.mjs'), 'utf8');
  assert.match(index, /db\.mjs/);
  assert.match(readFileSync(lib(repo, 'adapters.mjs'), 'utf8'), /mysql/);
  const merged = JSON.parse(readFileSync(lib(repo, 'scenarios.config.json'), 'utf8'));
  assert.ok(merged.adapters.sql, 'the required adapter\'s config key arrives');
  assert.deepEqual({ ...merged.adapters, sql: undefined, mysql: undefined }, { ...config.adapters, sql: undefined, mysql: undefined }, 'existing config keys unchanged');
  assert.equal(JSON.parse(readFileSync(lib(repo, 'package.json'), 'utf8')).dependencies.yaml, '1.0.0', 'existing pin kept');
  assert.ok(ran.includes('npm install'));

  const again = add(repo, 'mysql', {}, seam());
  assert.equal(again.already, true);
  assert.throws(() => add(repo, 'no-such-adapter', {}, seam()), /unknown adapter: no-such-adapter/);
  const cliRun = cli(repo, 'add', 'no-such-adapter');
  assert.equal(cliRun.status, 1);
  assert.match(cliRun.stderr, /no-such-adapter/);
});

test('upgrade and add on a repo without a manifest exit 1', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scn-upgrade-'));
  made.push(repo);
  for (const args of [['upgrade'], ['add', 'sql']]) {
    const run = cli(repo, ...args);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no \.plugin-manifest\.json: run apply first/);
  }
});

test('upgrade never touches a project-owned file', () => {
  const repo = freshRepo();
  mkdirSync(lib(repo, 'extra'), { recursive: true });
  const mine = {
    [lib(repo, 'hooks.mjs')]: 'export const mine = 1;\n',
    [lib(repo, 'project-exports.mjs')]: '',
    [lib(repo, 'project-api.md')]: '# mine\n',
    [lib(repo, '.gitignore')]: 'mine\n',
    [lib(repo, 'extra', 'own.mjs')]: '// own\n',
    [join(repo, SCN, 'README.md')]: 'mine\n',
    [join(repo, SCN, 'AUTHORING.md')]: 'mine\n',
    [join(repo, SCN, '_infra', 'up.sh')]: 'echo mine\n',
  };
  for (const [file, text] of Object.entries(mine)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
  const config = readFileSync(lib(repo, 'scenarios.config.json'), 'utf8').replace('{', '{ "mine": true,');
  writeFileSync(lib(repo, 'scenarios.config.json'), config);
  const pkg = readFileSync(lib(repo, 'package.json'), 'utf8');
  const owned = [...Object.keys(mine), lib(repo, 'scenarios.config.json'), lib(repo, 'package.json')];
  const before = Object.fromEntries(owned.map(f => [f, readFileSync(f, 'utf8')]));
  ageFile(repo, 'db.mjs');
  upgrade(repo, {}, seam());
  for (const f of owned) assert.equal(readFileSync(f, 'utf8'), before[f], f);
  assert.equal(readFileSync(lib(repo, 'package.json'), 'utf8'), pkg);
});

test('upgrade adds a dependency a newer plugin needs, keeps every project pin, reports it and reinstalls', () => {
  const repo = freshRepo(['browser']);
  // As if an older plugin had not needed yaml yet; the project pins playwright itself.
  const pkg = JSON.parse(readFileSync(lib(repo, 'package.json'), 'utf8'));
  delete pkg.dependencies.yaml;
  pkg.dependencies.playwright = '1.0.0';
  pkg.devDependencies = { left: '9.9.9' };
  writeFileSync(lib(repo, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const lines = [];
  const { run, ran } = seam();
  const result = upgrade(repo, {}, { run, out: l => lines.push(l) });
  const after = JSON.parse(readFileSync(lib(repo, 'package.json'), 'utf8'));
  assert.deepEqual(after.dependencies, { playwright: '1.0.0', yaml: '2.9.1' }, 'only the missing one is added');
  assert.deepEqual(after.devDependencies, { left: '9.9.9' });
  assert.deepEqual(result.npmAdded, { yaml: '2.9.1' });
  assert.ok(lines.some(l => /yaml@2\.9\.1/.test(l)), 'the addition is reported');
  assert.ok(ran.indexOf('npm install') >= 0 && ran.indexOf('npm install') < ran.indexOf('npm test'), 'install runs before verify');
  assert.ok(ran.includes('npx playwright install chromium'), 'the post-install commands run too, as add does');
});

test('upgrade with nothing to add leaves package.json alone and does not reinstall', () => {
  const repo = freshRepo();
  const pkg = JSON.parse(readFileSync(lib(repo, 'package.json'), 'utf8'));
  delete pkg.dependencies.yaml;
  pkg.devDependencies = { yaml: '2.9.1' };
  const text = JSON.stringify(pkg, null, 2) + '\n';
  writeFileSync(lib(repo, 'package.json'), text);
  const { run, out, ran } = seam();
  const result = upgrade(repo, {}, { run, out });
  assert.equal(readFileSync(lib(repo, 'package.json'), 'utf8'), text, 'a devDependencies pin counts');
  assert.deepEqual(result.npmAdded, {});
  assert.ok(!ran.includes('npm install'));
});

test('setup.mjs refuses an unknown flag and a repo that does not exist, with usage', () => {
  const repo = freshRepo();
  const flag = cli(repo, 'detect', '--jsn');
  assert.equal(flag.status, 64);
  assert.match(flag.stderr, /unknown flag: --jsn/);
  assert.match(flag.stderr, /usage: setup\.mjs detect/);
  const missing = spawnSync(process.execPath, [SETUP, 'detect', join(repo, 'no-such-dir')], { encoding: 'utf8' });
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /no such directory: .*no-such-dir/);
  assert.match(missing.stderr, /usage: setup\.mjs detect/);
  const file = spawnSync(process.execPath, [SETUP, 'detect', join(repo, 'artisan')], { encoding: 'utf8' });
  assert.equal(file.status, 64, 'a file is not a repo');
  assert.equal(cli(repo, 'detect', '--json').status, 0, 'a known flag still works');
});

test('upgrade reports a file the plugin no longer ships and leaves it', () => {
  const repo = freshRepo();
  writeFileSync(lib(repo, 'retired.mjs'), '// once shipped\n');
  writeManifestFiles(repo, m => { m.files['retired.mjs'] = sha(lib(repo, 'retired.mjs')); });
  const lines = [];
  const result = upgrade(repo, {}, { ...seam(), out: l => lines.push(l) });
  assert.deepEqual(result.dropped, ['retired.mjs']);
  assert.ok(existsSync(lib(repo, 'retired.mjs')));
  assert.ok(lines.some(l => /retired\.mjs/.test(l)));
});

test('add records the current plugin version and carries previousExports and kept forward', () => {
  const repo = freshRepo(['docker']);
  const exported = Object.values(loadCatalog(PLUGIN).core.exports).flat()[0];
  writeManifestFiles(repo, m => { m.version = '0.0.1'; m.previousExports = [exported]; m.kept = ['lint.mjs']; });
  add(repo, 'mysql', {}, seam());
  const manifest = readManifest(lib(repo));
  assert.equal(manifest.version, JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')).version);
  assert.notEqual(manifest.version, '0.0.1');
  assert.deepEqual(manifest.previousExports, [exported]);
  assert.deepEqual(manifest.kept, ['lint.mjs']);
});

test('add stops on a same-named project file and writes nothing', () => {
  const repo = freshRepo(['docker']);
  const mine = '// the project\'s own db helper\n';
  writeFileSync(lib(repo, 'db.mjs'), mine);
  const before = snapshot(join(repo, SCN));
  assert.throws(() => add(repo, 'mysql', {}, seam()), err => err.exitCode === 5
    && /db\.mjs/.test(err.message) && /^diff --git/m.test(err.message));
  assert.deepEqual(snapshot(join(repo, SCN)), before);
  const run = cli(repo, 'add', 'mysql');
  assert.equal(run.status, 5, run.stderr);
  assert.deepEqual(snapshot(join(repo, SCN)), before);
  assert.equal(cli(repo, 'add', 'mysql', '--take', 'db.mjs', '--keep', 'db.mjs').status, 64);

  const kept = add(repo, 'mysql', { keep: ['db.mjs'] }, seam());
  assert.deepEqual(kept.added.sort(), ['mysql', 'sql']);
  assert.equal(readFileSync(lib(repo, 'db.mjs'), 'utf8'), mine);
  const manifest = readManifest(lib(repo));
  assert.deepEqual(manifest.kept, ['db.mjs']);
  assert.equal(manifest.files['db.mjs'], sha(pluginFile('db.mjs')), 'the kept edit stays detectable');
  assert.ok(manifest.adapters.includes('mysql'));
});

test('add --take overwrites a same-named project file and records it', () => {
  const repo = freshRepo(['docker']);
  writeFileSync(lib(repo, 'db.mjs'), '// mine\n');
  add(repo, 'mysql', { take: ['db.mjs'] }, seam());
  assert.equal(sha(lib(repo, 'db.mjs')), sha(pluginFile('db.mjs')));
  const manifest = readManifest(lib(repo));
  assert.equal(manifest.files['db.mjs'], sha(pluginFile('db.mjs')));
  assert.equal(manifest.kept, undefined);
});
