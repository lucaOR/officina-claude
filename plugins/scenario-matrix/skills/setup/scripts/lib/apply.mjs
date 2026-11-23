import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadCatalog, resolveAdapters, PLUGIN_ROOT } from './catalog.mjs';
import { adaptersModule, harnessApi, indexModule, parseProjectExports } from './generate.mjs';
import { sha256, writeManifest } from './manifest.mjs';
import { GENERATED, LIB_DIR, npmDependencies } from './plan.mjs';

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const putFile = (to, from) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };

export const pluginVersion = pluginRoot => readJson(join(pluginRoot, '.claude-plugin', 'plugin.json')).version;

// Copies plugin-owned files into a lib and returns { lib-relative path: sha256 of the written file }.
export function placeFiles(libDir, entries) {
  const files = {};
  for (const { path, from } of entries) {
    putFile(join(libDir, path), from);
    files[path] = sha256(join(libDir, path));
  }
  return files;
}

// Each chosen adapter's `config` goes under adapters.<name>; what the config already says wins.
export function mergeAdapterConfig(config, chosen) {
  const merged = { ...config, adapters: { ...config.adapters } };
  for (const a of chosen) merged.adapters[a.name] = { ...(a.config ?? {}), ...(merged.adapters[a.name] ?? {}) };
  return merged;
}

// The lib package.json: only missing dependencies are added, and every other key, pin and comment stays.
export function mergePackage(existing, npmAdd) {
  const dependencies = { ...(existing.dependencies ?? {}) };
  for (const [name, version] of Object.entries(npmAdd)) dependencies[name] ??= version;
  return { ...existing, dependencies };
}

export function newPackage(name, dependencies) {
  return { name, private: true, type: 'module', engines: { node: '>=20' }, scripts: { test: 'node --test test/*.test.mjs' }, dependencies };
}

// adapters.mjs, index.mjs and harness-api.md, from what the lib holds: the chosen adapters, the
// project's own exports and the project's own API page.
export function writeGenerated(libDir, { catalog, chosen, pluginRoot }) {
  const exportsFile = join(libDir, 'project-exports.mjs');
  const projectExports = existsSync(exportsFile) ? parseProjectExports(readFileSync(exportsFile, 'utf8')) : [];
  const apiFile = join(libDir, 'project-api.md');
  writeFileSync(join(libDir, 'adapters.mjs'), adaptersModule(chosen, catalog));
  writeFileSync(join(libDir, 'index.mjs'), indexModule({ core: catalog.core, chosen, projectExports }));
  writeFileSync(join(libDir, 'harness-api.md'), harnessApi({
    corePage: readFileSync(join(pluginRoot, 'reference', 'harness-api.md'), 'utf8'),
    chosen,
    projectPage: existsSync(apiFile) ? readFileSync(apiFile, 'utf8') : '',
  }));
  return [...GENERATED];
}

// The infra placeholders and the config key each one is wired to.
const INFRA_WIRING = { 'up.sh': ['lifecycle', 'up'], 'down.sh': ['lifecycle', 'down'], 'baseline.sh': ['reset', 'baseline'] };

function seededConfig(template, chosen, infra) {
  const config = mergeAdapterConfig(readJson(template), chosen);
  for (const { path } of infra) {
    const key = INFRA_WIRING[path.split('/').pop()];
    if (key) config[key[0]] = { ...config[key[0]], [key[1]]: `bash ${path.split('\\').join('/')}` };
  }
  return config;
}

// Writes a plan: the plugin-owned files, the seeded project files, the infra placeholders, the
// merged package.json, the generated files, and last the manifest. Returns the repo-relative paths written.
export function apply(repo, plan, { pluginRoot = PLUGIN_ROOT } = {}) {
  const catalog = loadCatalog(pluginRoot);
  const chosen = resolveAdapters(catalog, plan.adapters);
  const libDir = join(repo, LIB_DIR);
  const written = [];
  const abs = rel => join(repo, rel);
  const libRel = rel => relative(libDir, abs(rel)).split('\\').join('/');

  const owned = plan.write.filter(w => w.owner === 'plugin');
  const files = placeFiles(libDir, owned.map(w => ({ path: libRel(w.path), from: w.from })));
  written.push(...owned.map(w => w.path));

  for (const w of plan.write.filter(w => w.owner === 'project')) {
    if (w.kind === 'package') {
      const file = abs(w.path);
      const existing = existsSync(file) ? readJson(file) : null;
      if (existing && !Object.keys(plan.npmAdd).length) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeJson(file, existing ? mergePackage(existing, plan.npmAdd) : newPackage('scenarios-lib', npmDependencies(catalog, chosen)));
      written.push(w.path);
      continue;
    }
    if (existsSync(abs(w.path))) continue; // seeded once, never over a project's file
    if (w.kind === 'config') {
      mkdirSync(dirname(abs(w.path)), { recursive: true });
      writeJson(abs(w.path), seededConfig(w.from, chosen, plan.infra));
    } else putFile(abs(w.path), w.from);
    written.push(w.path);
  }

  for (const { path, from } of plan.infra) {
    if (existsSync(abs(path))) continue;
    putFile(abs(path), from);
    written.push(path);
  }

  const generated = writeGenerated(libDir, { catalog, chosen, pluginRoot });
  written.push(...generated.map(name => join(LIB_DIR, name)));
  writeManifest(libDir, { version: pluginVersion(pluginRoot), adapters: chosen.map(a => a.name), files, generated, previousExports: plan.previousExports });
  written.push(join(LIB_DIR, '.plugin-manifest.json'));
  return { written };
}
