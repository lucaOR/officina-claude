import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCatalog, resolveAdapters, PLUGIN_ROOT } from './catalog.mjs';
import { parseProjectExports } from './generate.mjs';
import { mergeAdapterConfig, apply, writeGenerated } from './apply.mjs';
import { SetupError } from './errors.mjs';
import { readManifest } from './manifest.mjs';
import { GENERATED, LIB_DIR, SCENARIOS_DIR, installNeeds, missingNpm, pluginFiles } from './plan.mjs';

// The grep from the spec: files that still name the old skills by their bare names.
const OLD_SKILLS = '/scenario-matrix\\b|/scenario-run\\b|skills/scenario-(matrix|run)/';
const NOT_OURS = new Set(['.plugin-manifest.json', ...GENERATED]);
const posix = path => path.split(sep).join('/');

// Adopt stops with a SetupError: exit 3 for a dirty or git-less scenarios dir, 4 for old exports
// that nothing provides.
export const AdoptError = SetupError;

// Lib-relative POSIX paths of every file in the lib, except installed packages.
function libFiles(libDir, rel = '') {
  return readdirSync(join(libDir, rel), { withFileTypes: true }).flatMap(e => {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (!e.isDirectory()) return [path];
    return e.name === 'node_modules' ? [] : libFiles(libDir, path);
  });
}

// The export statements of the old index.mjs as { line (verbatim), names, from (lib-relative file) }.
function oldExports(indexFile) {
  if (!existsSync(indexFile)) return [];
  return readFileSync(indexFile, 'utf8').split('\n').flatMap((line, i) => {
    if (!/^\s*export\b/.test(line)) return [];
    let parsed;
    try { parsed = parseProjectExports(line); } catch {
      throw new Error(`old index.mjs:${i + 1}: adopt reads only "export { a, b as c } from './x.mjs';" lines: ${line.trim()}`);
    }
    return parsed.length ? [{ line, names: parsed.map(p => p.name), from: parsed[0].from.replace(/^\.\//, '') }] : [];
  });
}

function skillMentions(repo) {
  const run = spawnSync('grep', ['-rlE', OLD_SKILLS, '--exclude-dir=node_modules', '--exclude-dir=vendor', '--exclude-dir=.git', '.'], { cwd: repo, encoding: 'utf8' });
  return run.stdout.split('\n').filter(Boolean).map(f => f.replace(/^\.\//, '')).filter(f => !f.startsWith(`${posix(LIB_DIR)}/`)).sort();
}

// Classifies every file of the existing lib: replaced (its name is a core or chosen adapter file),
// generated, or kept. Returns the Plan that applyAdopt writes, plus `previousExports`, the names
// the old index.mjs exported. Nothing is written here.
export function planAdopt(repo, { adapters, pluginRoot = PLUGIN_ROOT }) {
  const catalog = loadCatalog(pluginRoot);
  const chosen = resolveAdapters(catalog, adapters);
  const templates = join(pluginRoot, 'runtime', 'templates');
  const libDir = join(repo, LIB_DIR);
  const lib = name => join(LIB_DIR, name);
  const owned = pluginFiles(catalog, chosen);
  const ownedNames = new Set(owned.map(f => f.path));
  const existing = libFiles(libDir).filter(f => !NOT_OURS.has(f));
  const kept = existing.filter(f => !ownedNames.has(f));

  const old = oldExports(join(libDir, 'index.mjs'));
  const moved = old.filter(e => kept.includes(e.from)).map(e => e.line);
  if (moved.length && existsSync(join(libDir, 'project-exports.mjs'))) {
    throw new Error('project-exports.mjs already exists and the old index.mjs has export lines to move into it: merge them by hand, then run setup.mjs regen');
  }

  // Project files are seeded only when absent; the config is always listed because applyAdopt merges into an existing one.
  const write = owned.map(({ path, from }) => ({ path: lib(path), from, owner: 'plugin', kind: 'copy' }));
  const seed = (name, from, kind = 'copy') => {
    if (kind === 'config' || !existsSync(join(libDir, name))) write.push({ path: lib(name), from: join(templates, from), owner: 'project', kind });
  };
  seed('hooks.mjs', 'hooks.mjs');
  seed('scenarios.config.json', 'scenarios.config.json', 'config');
  seed('project-exports.mjs', 'project-exports.mjs');
  seed('project-api.md', 'project-api.md');
  write.push({ path: lib('package.json'), from: null, owner: 'project', kind: 'package' });

  const packageFile = join(libDir, 'package.json');
  const projectPackage = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : {};
  return {
    mode: 'adopt',
    adapters: chosen.map(a => a.name),
    write,
    replace: existing.filter(f => ownedNames.has(f)).map(lib),
    keep: kept.map(lib),
    generated: [...GENERATED],
    npmAdd: missingNpm(catalog, chosen, projectPackage),
    ...installNeeds(chosen),
    infra: [],
    projectExportLines: moved,
    testsReplaced: existing.filter(f => ownedNames.has(f) && f.startsWith('test/')).map(lib),
    skillMentions: skillMentions(repo),
    previousExports: old.flatMap(e => e.names),
  };
}

// Throws exit 4 naming every old export that neither the generated index nor project-exports provides.
function checkExports(libDir, chosen, catalog, previous) {
  const provided = new Set([catalog.core, ...chosen].flatMap(src => Object.values(src.exports ?? {}).flat()));
  const exportsFile = join(libDir, 'project-exports.mjs');
  if (existsSync(exportsFile)) for (const p of parseProjectExports(readFileSync(exportsFile, 'utf8'))) provided.add(p.name);
  const missing = previous.filter(name => !provided.has(name));
  if (missing.length) {
    throw new AdoptError(`the old index.mjs exported names that nothing provides now: ${missing.join(', ')}. Add each to project-exports.mjs (or to hooks), then run setup.mjs regen.`, 4);
  }
}

// Writes the plan in place. Exit 3 before any write unless `.claude/scenarios` is clean in git;
// exit 4 after the writes when an old export name is no longer provided.
export function applyAdopt(repo, plan, { pluginRoot = PLUGIN_ROOT } = {}) {
  const status = spawnSync('git', ['status', '--porcelain', '--', SCENARIOS_DIR], { cwd: repo, encoding: 'utf8' });
  if (status.status !== 0) throw new AdoptError('adopt needs git: the swap is reverted with git checkout, and this is not a git repo', 3);
  if (status.stdout.trim()) {
    throw new AdoptError(`uncommitted changes under ${SCENARIOS_DIR}: commit or stash them first, so the swap is one reviewable diff\n${status.stdout.trimEnd()}`, 3);
  }

  const catalog = loadCatalog(pluginRoot);
  const chosen = resolveAdapters(catalog, plan.adapters);
  const libDir = join(repo, LIB_DIR);
  const extra = [];
  if (plan.projectExportLines.length) {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, 'project-exports.mjs'), plan.projectExportLines.join('\n') + '\n');
    extra.push(join(LIB_DIR, 'project-exports.mjs'));
  }
  const configFile = join(libDir, 'scenarios.config.json');
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const merged = mergeAdapterConfig(config, chosen);
    if (JSON.stringify(merged) !== JSON.stringify(config)) {
      writeFileSync(configFile, JSON.stringify(merged, null, 2) + '\n');
      extra.push(join(LIB_DIR, 'scenarios.config.json'));
    }
  }

  const { written } = apply(repo, plan, { pluginRoot });
  checkExports(libDir, chosen, catalog, plan.previousExports);
  return { written: [...extra, ...written] };
}

// Regenerates the generated files for the manifest's adapters and reruns the export comparison
// against the names the adopted index.mjs used to export.
export function regenAdopt(repo, { pluginRoot = PLUGIN_ROOT } = {}) {
  const libDir = join(repo, LIB_DIR);
  const manifest = readManifest(libDir);
  if (!manifest) throw new Error('no .plugin-manifest.json: run apply first');
  const catalog = loadCatalog(pluginRoot);
  const chosen = resolveAdapters(catalog, manifest.adapters);
  writeGenerated(libDir, { catalog, chosen, pluginRoot });
  checkExports(libDir, chosen, catalog, manifest.previousExports ?? []);
}
