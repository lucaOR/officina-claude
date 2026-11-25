import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { basename } from 'node:path';
import { REPO, plugins, privatePlugins, readJson, pack, checkPackage } from './pack-check.mjs';

// A throwaway copy of a real package; the real ones are never mutated.
function tempCopy(dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-'));
  made.push(tmp);
  const to = path.join(tmp, basename(dir));
  fs.cpSync(dir, to, { recursive: true, filter: src => !src.includes('node_modules') });
  return to;
}
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const edit = (dir, file, fn) => {
  const p = path.join(dir, file);
  fs.writeFileSync(p, JSON.stringify(fn(readJson(p)), null, 2));
};

test('each plugin package matches its manifest and ships nothing private', () => {
  assert.equal(plugins.length, 5);
  for (const dir of plugins) {
    const pkg = readJson(`${dir}/package.json`), man = readJson(`${dir}/.claude-plugin/plugin.json`);
    assert.equal(pkg.name, `@officina-claude/${basename(dir)}`);
    assert.equal(pkg.version, man.version);
    assert.equal(pkg.publishConfig.access, 'public');
    const files = pack(dir);
    for (const f of files) assert.doesNotMatch(f, /node_modules|__pycache__|\.project-terms|\.env|\.log$/);
    assert.ok(files.includes('.claude-plugin/plugin.json'));
    assert.deepEqual(checkPackage(dir).problems, []);
  }
});

const marketplace = readJson(path.join(REPO, '.claude-plugin/marketplace.json'));

test('marketplace, plugin.json and package.json agree on every publishable version', () => {
  const skipped = [];
  for (const p of marketplace.plugins) {
    const dir = path.join(REPO, 'plugins', p.name);
    const pkgFile = path.join(dir, 'package.json');
    const pkg = fs.existsSync(pkgFile) ? readJson(pkgFile) : null;
    if (!pkg || pkg.private) { skipped.push(p.name); continue; } // private plugins are never published
    const man = readJson(path.join(dir, '.claude-plugin/plugin.json'));
    assert.equal(p.version, man.version, `${p.name}: marketplace vs plugin.json`);
    assert.equal(pkg.version, man.version, `${p.name}: package.json vs plugin.json`);
  }
  assert.deepEqual(skipped, ['scenario-matrix']);
});

test('a plugin CHANGELOG tops out at the released plugin version', () => {
  let checked = 0;
  for (const p of marketplace.plugins) {
    const file = path.join(REPO, 'plugins', p.name, 'CHANGELOG.md');
    if (!fs.existsSync(file)) continue;
    const top = /^## \[(\d+\.\d+\.\d+)\]/m.exec(fs.readFileSync(file, 'utf8'));
    assert.ok(top, `${p.name}: no released heading`);
    assert.equal(top[1], readJson(path.join(REPO, 'plugins', p.name, '.claude-plugin/plugin.json')).version, `${p.name}: CHANGELOG top`);
    checked++;
  }
  assert.ok(checked >= 1);
});

test('the marketplace description of diagrams names every renderer kind', async () => {
  const { TYPES } = await import(path.join(REPO, 'plugins/diagrams/lib/index.mjs'));
  const desc = marketplace.plugins.find(p => p.name === 'diagrams').description.toLowerCase();
  const word = { erd: 'entity-relationship' };
  for (const t of TYPES) assert.ok(desc.includes(word[t] ?? t), `description misses ${t}`);
});

test('the diagrams package exposes the diagram command', () => {
  assert.equal(readJson(path.join(REPO, 'plugins/diagrams/package.json')).bin.diagram, 'bin/diagram.mjs');
});

test('scenario-matrix stays private so it cannot be published by accident', () => {
  assert.deepEqual(privatePlugins.map(d => basename(d)), ['scenario-matrix']);
  for (const dir of privatePlugins) assert.equal(readJson(`${dir}/package.json`).private, true);
  assert.ok(!plugins.some(d => basename(d) === 'scenario-matrix'));
});

test('the diagrams tarball carries what the command and the README need', () => {
  const files = pack(path.join(REPO, 'plugins/diagrams'));
  for (const f of ['bin/diagram.mjs', 'lib/index.mjs', 'README.md', 'CHANGELOG.md']) assert.ok(files.includes(f), f);
  assert.ok(!files.some(f => /^(test|scripts)\//.test(f)));
});

test('a name that disagrees with the directory fails', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/token-hygiene'));
  edit(dir, 'package.json', p => ({ ...p, name: '@officina-claude/other' }));
  assert.match(checkPackage(dir).problems.join('\n'), /name/);
});

test('a version that disagrees with plugin.json fails', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/token-hygiene'));
  edit(dir, 'package.json', p => ({ ...p, version: '9.9.9' }));
  assert.match(checkPackage(dir).problems.join('\n'), /version/);
});

test('forbidden paths in the tarball fail', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/token-hygiene'));
  fs.mkdirSync(path.join(dir, 'extra/__pycache__'), { recursive: true });
  for (const f of ['.project-terms', '.env', 'run.log', '__pycache__/x.pyc']) fs.writeFileSync(path.join(dir, 'extra', f), 'x');
  edit(dir, 'package.json', p => ({ ...p, files: [...p.files, 'extra'] }));
  const problems = checkPackage(dir).problems.join('\n');
  for (const f of ['.project-terms', '.env', 'run.log', '__pycache__']) assert.match(problems, new RegExp(f.replaceAll('.', '\\.')));
});

test('a fixtures directory in the tarball fails', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/token-hygiene'));
  fs.mkdirSync(path.join(dir, 'extra/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extra/fixtures/a.json'), '{}');
  edit(dir, 'package.json', p => ({ ...p, files: [...p.files, 'extra'] }));
  assert.match(checkPackage(dir).problems.join('\n'), /forbidden path.*extra\/fixtures\/a\.json/);
});

test('a key file in the tarball fails and is named', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/token-hygiene'));
  fs.mkdirSync(path.join(dir, 'extra'));
  for (const f of ['server.pem', 'id_rsa', 'credentials.json']) fs.writeFileSync(path.join(dir, 'extra', f), 'x');
  edit(dir, 'package.json', p => ({ ...p, files: [...p.files, 'extra'] }));
  const problems = checkPackage(dir).problems.join('\n');
  for (const f of ['server\\.pem', 'id_rsa', 'credentials\\.json']) assert.match(problems, new RegExp(`forbidden path.*${f}`));
});

test('Python test files in the tarball fail', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/token-hygiene'));
  edit(dir, 'package.json', p => ({ ...p, files: p.files.filter(f => f !== '!**/test_*.py') }));
  assert.match(checkPackage(dir).problems.join('\n'), /forbidden path.*test_[^/]*\.py/);
});

test('a changed bin value fails', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/diagrams'));
  edit(dir, 'package.json', p => ({ ...p, bin: { diagram: 'bin/other.mjs' } }));
  assert.match(checkPackage(dir).problems.join('\n'), /bin is/);
});

test('a missing manifest in the tarball fails', () => {
  const dir = tempCopy(path.join(REPO, 'plugins/token-hygiene'));
  edit(dir, 'package.json', p => ({ ...p, files: p.files.filter(f => f !== '.claude-plugin') }));
  assert.match(checkPackage(dir).problems.join('\n'), /plugin\.json/);
});

test('bin targets must exist and start with a shebang', () => {
  const missing = tempCopy(path.join(REPO, 'plugins/diagrams'));
  fs.rmSync(path.join(missing, 'bin/diagram.mjs'));
  assert.match(checkPackage(missing).problems.join('\n'), /bin/);
  const noShebang = tempCopy(path.join(REPO, 'plugins/diagrams'));
  fs.writeFileSync(path.join(noShebang, 'bin/diagram.mjs'), 'console.log(1);\n');
  assert.match(checkPackage(noShebang).problems.join('\n'), /shebang/);
});

test('the CLI exits 0 on the real packages', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools/pack-check.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
