import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planAdopt, applyAdopt } from '../adopt.mjs';
import { readManifest } from '../manifest.mjs';
import { detect } from '../detect.mjs';
import { loadCatalog } from '../catalog.mjs';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const FIXTURE = join(PLUGIN, 'test', 'fixtures', 'repos', 'small-harness');
const SETUP = join(PLUGIN, 'skills', 'setup', 'scripts', 'setup.mjs');
const SCN = join('.claude', 'scenarios');
const LIB = join(SCN, '_lib');
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (repo, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
const cli = (repo, ...args) => spawnSync(process.execPath, [SETUP, args[0], repo, ...args.slice(1)], { encoding: 'utf8' });

const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

// A copy of small-harness; `extra` maps repo-relative paths to contents added before the one commit.
function adoptRepo(extra = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'scn-adopt-'));
  made.push(repo);
  cpSync(FIXTURE, repo, { recursive: true });
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  if (!existsSync(join(repo, 'node_modules'))) symlinkSync(join(PLUGIN, 'node_modules'), join(repo, 'node_modules'), 'dir');
  git(repo, 'init', '-q');
  writeFileSync(join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'old harness');
  return repo;
}
const lib = (repo, ...p) => join(repo, LIB, ...p);
const adopt = repo => applyAdopt(repo, planAdopt(repo, { adapters: ['sql'] }));
const snapshot = dir => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => [join(e.parentPath, e.name), sha(join(e.parentPath, e.name))]));
const OLD_INDEX = "export { sql } from './db.mjs';\nexport { widget } from './widgets.mjs';\n";

test('adopt refuses a dirty scenarios dir and writes nothing', () => {
  const repo = adoptRepo();
  writeFileSync(join(repo, SCN, 'wip.yaml'), 'epic: wip\n');
  const before = snapshot(join(repo, SCN));
  assert.throws(() => adopt(repo), err => err.exitCode === 3 && /uncommitted/.test(err.message));
  assert.deepEqual(snapshot(join(repo, SCN)), before);
  const run = cli(repo, 'apply', '--adapters', 'sql');
  assert.equal(run.status, 3, run.stderr);
  assert.deepEqual(snapshot(join(repo, SCN)), before);
});

test('adopt refuses a repo that is not under git, because the revert path is git checkout', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scn-adopt-'));
  made.push(repo);
  cpSync(FIXTURE, repo, { recursive: true });
  assert.throws(() => adopt(repo), err => err.exitCode === 3 && /needs git/.test(err.message));
});

test('adopt replaces same-name files and keeps every other file byte for byte', async () => {
  const repo = adoptRepo();
  const before = snapshot(join(repo, SCN));
  const p = planAdopt(repo, { adapters: ['sql'] });
  assert.deepEqual(p.replace, [join(LIB, 'db.mjs')]);
  assert.ok(p.keep.includes(join(LIB, 'widgets.mjs')));
  assert.ok(!p.keep.includes(join(LIB, 'db.mjs')));
  applyAdopt(repo, p);
  const after = snapshot(join(repo, SCN));
  assert.notEqual(after[lib(repo, 'db.mjs')], before[lib(repo, 'db.mjs')], 'db.mjs is the plugin copy now');
  for (const f of [lib(repo, 'widgets.mjs'), join(repo, SCN, 'notes.yaml'), join(repo, SCN, '_scripts', 'notes', 'A-01.mjs')]) {
    assert.equal(after[f], before[f], f);
  }
  const manifest = readManifest(lib(repo));
  assert.equal(manifest.files['db.mjs'], after[lib(repo, 'db.mjs')]);
  assert.ok(!('widgets.mjs' in manifest.files));
  assert.equal(detect(repo, loadCatalog(PLUGIN)).mode, 'upgrade');
  const mod = await import(pathToFileURL(lib(repo, 'index.mjs')).href);
  assert.equal(typeof mod.sql, 'function', 'sql still resolves');
  assert.equal(typeof mod.widget, 'function', 'widget still resolves');
});

test('old index export lines naming project files move verbatim to project-exports.mjs', () => {
  const repo = adoptRepo({ [join(LIB, 'index.mjs')]: "export { sql } from './db.mjs';\nexport {   widget  } from './widgets.mjs';\n" });
  const p = planAdopt(repo, { adapters: ['sql'] });
  assert.deepEqual(p.projectExportLines, ["export {   widget  } from './widgets.mjs';"]);
  applyAdopt(repo, p);
  assert.equal(readFileSync(lib(repo, 'project-exports.mjs'), 'utf8'), "export {   widget  } from './widgets.mjs';\n");
  assert.match(readFileSync(lib(repo, 'index.mjs'), 'utf8'), /export \* from '\.\/project-exports\.mjs';/);
});

test('a name the old index exported that nothing exports now stops with exit 4 naming it', () => {
  const repo = adoptRepo({ [join(LIB, 'index.mjs')]: `${OLD_INDEX}export { gone, vanished } from './db.mjs';\n` });
  assert.throws(() => adopt(repo), err => err.exitCode === 4 && /gone/.test(err.message) && /vanished/.test(err.message) && !/\bsql\b/.test(err.message));
  assert.ok(existsSync(lib(repo, 'adapters.mjs')), 'the rest of the plan was written before the stop');
  assert.deepEqual(readManifest(lib(repo)).previousExports.sort(), ['gone', 'sql', 'vanished', 'widget']);
});

test('package.json is merged', () => {
  const before = { '//': 'pinned on purpose', name: 'scenario-lib', private: true, type: 'module', dependencies: { left: '1.0.0' } };
  const repo = adoptRepo({ [join(LIB, 'package.json')]: JSON.stringify(before, null, 2) + '\n' });
  const p = planAdopt(repo, { adapters: ['sql'] });
  assert.deepEqual(p.npmAdd, { yaml: '2.9.1' });
  applyAdopt(repo, p);
  const after = JSON.parse(readFileSync(lib(repo, 'package.json'), 'utf8'));
  assert.deepEqual(after, { ...before, dependencies: { left: '1.0.0', yaml: '2.9.1' } });
  assert.deepEqual(Object.keys(after), Object.keys(before));
});

test('README.md and AUTHORING.md are untouched', () => {
  const docs = {
    [join(SCN, 'README.md')]: 'mine\n', [join(SCN, 'AUTHORING.md')]: 'method\n',
    [join(LIB, 'AUTHORING.md')]: 'lib method\n', [join(LIB, '.gitignore')]: 'mine\n',
  };
  const repo = adoptRepo(docs);
  const before = snapshot(join(repo, SCN));
  adopt(repo);
  const after = snapshot(join(repo, SCN));
  for (const rel of [...Object.keys(docs), join(LIB, 'README.md')]) assert.equal(after[join(repo, rel)], before[join(repo, rel)], rel);
});

test('files naming the old skills are listed, not edited', () => {
  const mention = { '.claude/skills/scenario-run/SKILL.md': 'run it with /scenario-run\n', 'backlog.yaml': 'see skills/scenario-matrix/ for the method\n' };
  const repo = adoptRepo({
    ...mention,
    [join(LIB, 'notes.md')]: 'uses /scenario-matrix here\n',
    'node_modules/dep/x.md': '/scenario-run\n',
    'docs/unrelated.md': 'a /scenario-runner is not the skill\n',
  });
  const p = planAdopt(repo, { adapters: ['sql'] });
  assert.deepEqual(p.skillMentions, ['.claude/skills/scenario-run/SKILL.md', 'backlog.yaml']);
  applyAdopt(repo, p);
  for (const [path, text] of Object.entries(mention)) assert.equal(readFileSync(join(repo, path), 'utf8'), text);
});

test('same-name tests are listed as replaced', () => {
  const repo = adoptRepo({ [join(LIB, 'test', 'run.test.mjs')]: '// project cases\n', [join(LIB, 'test', 'mine.test.mjs')]: '// mine\n' });
  const p = planAdopt(repo, { adapters: ['sql'] });
  assert.deepEqual(p.testsReplaced, [join(LIB, 'test', 'run.test.mjs')]);
  assert.ok(p.keep.includes(join(LIB, 'test', 'mine.test.mjs')));
  applyAdopt(repo, p);
  assert.equal(readFileSync(lib(repo, 'test', 'mine.test.mjs'), 'utf8'), '// mine\n');
  assert.notEqual(readFileSync(lib(repo, 'test', 'run.test.mjs'), 'utf8'), '// project cases\n');
});

test('regen after adding the missing export exits 0', async () => {
  const repo = adoptRepo({ [join(LIB, 'index.mjs')]: `${OLD_INDEX}export { gone } from './db.mjs';\n` });
  const run = cli(repo, 'apply', '--adapters', 'sql');
  assert.equal(run.status, 4, run.stderr);
  assert.match(run.stderr, /gone/);
  assert.equal(cli(repo, 'regen').status, 4, 'still missing');
  writeFileSync(lib(repo, 'widgets.mjs'), 'export const widget = () => ({});\nexport const gone = () => 0;\n');
  writeFileSync(lib(repo, 'project-exports.mjs'), "export { widget, gone } from './widgets.mjs';\n");
  const regen = cli(repo, 'regen');
  assert.equal(regen.status, 0, regen.stderr);
  const mod = await import(pathToFileURL(lib(repo, 'index.mjs')).href);
  assert.equal(typeof mod.gone, 'function', 'the name resolves through the regenerated index');
});
