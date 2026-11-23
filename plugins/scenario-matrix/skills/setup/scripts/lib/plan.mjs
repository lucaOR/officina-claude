import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { loadCatalog, resolveAdapters, PLUGIN_ROOT } from './catalog.mjs';

export const SCENARIOS_DIR = join('.claude', 'scenarios');
export const LIB_DIR = join(SCENARIOS_DIR, '_lib');
export const INFRA_DIR = join(SCENARIOS_DIR, '_infra');
export const GENERATED = ['adapters.mjs', 'index.mjs', 'harness-api.md'];
const INFRA_SCRIPTS = ['up.sh', 'down.sh', 'baseline.sh'];

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : [p];
  });
}

// Every plugin-owned file of the core and the chosen adapters, as lib-relative paths: the source
// files flat, and each test directory (support and fixtures too) flat under test/. Two sources that
// would write the same path are refused, naming both, because one would silently replace the other.
export function pluginFiles(catalog, chosen) {
  const byPath = new Map();
  const place = (path, from) => {
    if (byPath.has(path)) throw new Error(`two plugin files would be written to ${path}: ${byPath.get(path)} and ${from}`);
    byPath.set(path, from);
  };
  for (const src of [catalog.core, ...chosen]) {
    for (const f of src.files ?? []) place(basename(f), join(src.dir, f));
    const testDir = join(src.dir, 'test');
    for (const file of filesUnder(testDir)) place(join('test', relative(testDir, file)).split(sep).join('/'), file);
  }
  return [...byPath].map(([path, from]) => ({ path, from }));
}

// Core and adapter npm dependencies; the first source to name one decides its version.
export function npmDependencies(catalog, chosen) {
  const dependencies = {};
  for (const src of [catalog.core, ...chosen]) for (const [name, version] of Object.entries(src.npm ?? {})) dependencies[name] ??= version;
  return dependencies;
}

// The core and chosen adapter dependencies a project's lib package.json does not list yet, in
// either dependencies or devDependencies: a project's own pin, wherever it sits, is kept.
export function missingNpm(catalog, chosen, projectPackage) {
  const pinned = { ...(projectPackage.devDependencies ?? {}), ...(projectPackage.dependencies ?? {}) };
  const npmAdd = {};
  for (const [name, version] of Object.entries(npmDependencies(catalog, chosen))) {
    if (!pinned[name]) npmAdd[name] = version;
  }
  return npmAdd;
}

// Post-install commands in order, and the system packages of every distro as a deduplicated union.
export function installNeeds(chosen) {
  const postInstall = [];
  const systemPackages = {};
  for (const a of chosen) {
    for (const cmd of a.postInstall ?? []) if (!postInstall.includes(cmd)) postInstall.push(cmd);
    for (const [distro, pkgs] of Object.entries(a.systemPackages ?? {})) {
      const list = (systemPackages[distro] ??= []);
      for (const p of pkgs) if (!list.includes(p)) list.push(p);
    }
  }
  return { postInstall, systemPackages };
}

// Decides what a setup writes and returns it as data; apply.mjs does the writing. Paths are
// relative to the repo, and `from` is a file inside the plugin. `owner` says who owns the file once
// written: 'plugin' files are recorded in the manifest, 'project' files are seeded once and never
// overwritten. `kind` is 'copy' unless apply merges the content ('config', 'package').
export function plan(repo, { adapters, mode, pluginRoot = PLUGIN_ROOT }) {
  if (mode !== 'fresh') throw new Error(`mode ${mode} is not supported yet: only fresh is`);
  const catalog = loadCatalog(pluginRoot);
  const chosen = resolveAdapters(catalog, adapters);
  const templates = join(pluginRoot, 'runtime', 'templates');
  const exists = rel => existsSync(join(repo, rel));
  const lib = name => join(LIB_DIR, name);

  const write = pluginFiles(catalog, chosen).map(({ path, from }) => ({ path: lib(path), from, owner: 'plugin', kind: 'copy' }));
  const seed = (path, from, kind = 'copy') => { if (!exists(path)) write.push({ path, from: join(templates, from), owner: 'project', kind }); };
  seed(lib('hooks.mjs'), 'hooks.mjs');
  seed(lib('scenarios.config.json'), 'scenarios.config.json', 'config');
  seed(lib('project-exports.mjs'), 'project-exports.mjs');
  seed(lib('project-api.md'), 'project-api.md');
  seed(lib('.gitignore'), 'gitignore');
  seed(join(SCENARIOS_DIR, 'README.md'), 'README.md');
  seed(join(SCENARIOS_DIR, 'AUTHORING.md'), 'AUTHORING.md');
  write.push({ path: lib('package.json'), from: null, owner: 'project', kind: 'package' });

  const projectPackage = exists(lib('package.json')) ? JSON.parse(readFileSync(join(repo, lib('package.json')), 'utf8')) : {};
  const npmAdd = missingNpm(catalog, chosen, projectPackage);

  const infra = INFRA_SCRIPTS.filter(f => !exists(join(INFRA_DIR, f))).map(f => ({ path: join(INFRA_DIR, f), from: join(templates, 'infra', f) }));
  return {
    mode,
    adapters: chosen.map(a => a.name),
    write,
    replace: [],
    keep: [],
    generated: [...GENERATED],
    npmAdd,
    ...installNeeds(chosen),
    infra,
    projectExportLines: [],
    testsReplaced: [],
    skillMentions: [],
  };
}
