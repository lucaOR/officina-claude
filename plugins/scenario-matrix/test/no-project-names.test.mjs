import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS_DIR = join(PLUGIN, 'runtime', 'adapters');

// Project terms are never allowed in a scanned file. They name private projects,
// so they are not published: they come from a gitignored file,
// one term per line (`#` starts a comment), at $PROJECT_TERMS_FILE or else
// `.project-terms` at the repo root. Without that file, the project-term test is skipped.
// A technology's terms are allowed in its own adapter and in every adapter that
// requires it, transitively.
const TERMS_FILE = process.env.PROJECT_TERMS_FILE || join(PLUGIN, '..', '..', '.project-terms');
const PROJECT_TERMS = existsSync(TERMS_FILE)
  ? readFileSync(TERMS_FILE, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
  : null;

const DENYLIST = {
  project: PROJECT_TERMS || [],
  tech: {
    docker: ['docker'],
    sql: ['sql'],
    mysql: ['mysql', 'mariadb'],
    postgres: ['postgres', 'psql'],
    laravel: ['laravel', 'artisan', 'tinker', 'php'],
    sanctum: ['sanctum'],
    browser: ['playwright', 'chromium'],
    mailpit: ['mailpit'],
  },
  // Laravel Sanctum's own name contains Laravel, and sanctum does not require the laravel adapter.
  extraAllowance: { sanctum: ['laravel'] },
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (t) => new RegExp(`\\b${esc(t)}\\b`, 'i');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (file) => relative(PLUGIN, file).split(sep).join('/');
const inTestDir = (file) => rel(file).split('/').includes('test');
const adapterNames = () => readdirSync(ADAPTERS_DIR).filter((n) => existsSync(join(ADAPTERS_DIR, n, 'adapter.json')));
const requiresOf = (name) => JSON.parse(readFileSync(join(ADAPTERS_DIR, name, 'adapter.json'), 'utf8')).requires;

function allowedTech(name) {
  const techs = new Set();
  const visit = (n) => {
    if (techs.has(n)) return;
    techs.add(n);
    for (const extra of DENYLIST.extraAllowance[n] || []) techs.add(extra);
    requiresOf(n).forEach(visit);
  };
  visit(name);
  return techs;
}

// Every shipped file in scope, tagged with the adapter that owns it (null when none does).
function scopedFiles() {
  const files = [];
  for (const d of ['runtime/core', 'runtime/templates', 'skills', 'reference']) {
    for (const file of walk(join(PLUGIN, d))) files.push({ file, adapter: null });
  }
  for (const adapter of adapterNames()) {
    for (const file of walk(join(ADAPTERS_DIR, adapter))) files.push({ file, adapter });
  }
  return files;
}

// Lines of the scoped files that hold one of the terms chosen by `termsFor(adapter, file)`.
function scan(termsFor, keep = () => true) {
  const found = [];
  for (const entry of scopedFiles().filter(keep)) {
    const res = termsFor(entry).map((t) => [t, termRe(t)]);
    if (!res.length) continue;
    readFileSync(entry.file, 'utf8').split('\n').forEach((line, i) => {
      for (const [t, re] of res) if (re.test(line)) found.push(`${rel(entry.file)}:${i + 1} ${t}: ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
}

const projectTerms = () => DENYLIST.project;
const techTermsFor = ({ adapter, file }) => {
  if (inTestDir(file)) return [];
  const allowed = adapter ? allowedTech(adapter) : new Set();
  return Object.entries(DENYLIST.tech).filter(([tech]) => !allowed.has(tech)).flatMap(([, terms]) => terms);
};

const ownedByAdapter = ({ adapter }) => adapter !== null;

test('no plugin-owned file names a project', { skip: PROJECT_TERMS ? false : `no project terms file at ${TERMS_FILE}` }, () => {
  assert.deepEqual(scan(projectTerms), []);
});

test('core and templates name no technology', () => {
  assert.deepEqual(scan(techTermsFor, (e) => !ownedByAdapter(e)), []);
});

test('each adapter names only its own technology and the ones it requires', () => {
  assert.deepEqual(scan(techTermsFor, ownedByAdapter), []);
});

test('no plugin-owned file carries a source-project path header', () => {
  const bad = scopedFiles()
    .filter(({ file }) => /^\/\/ \.claude\/scenarios\/_lib\//.test(readFileSync(file, 'utf8').split('\n')[0]))
    .map(({ file }) => rel(file));
  assert.deepEqual(bad, []);
});
