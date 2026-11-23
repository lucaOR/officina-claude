import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadCatalog, resolveAdapters, PLUGIN_ROOT } from './catalog.mjs';
import { SetupError } from './errors.mjs';
import { regenAdopt } from './adopt.mjs';
import { mergeAdapterConfig, mergePackage, placeFiles, pluginVersion } from './apply.mjs';
import { defaultRun, install } from './install.mjs';
import { readManifest, sha256, writeManifest } from './manifest.mjs';
import { GENERATED, LIB_DIR, installNeeds, missingNpm, pluginFiles } from './plan.mjs';
import { verify } from './verify.mjs';

const NO_MANIFEST = 'no .plugin-manifest.json: run apply first';

// One unified diff per edited file, the plugin's version against the project's.
function diffOf(from, to) {
  return spawnSync('git', ['diff', '--no-index', '--no-color', '--', from, to], { encoding: 'utf8' }).stdout;
}

// The entries whose file is on disk with a sha256 other than the manifest's (a path the manifest
// does not list counts as edited). One that is in neither `take`, `keep` nor manifest.kept stops
// the run with exit 5, diffs included, so the caller has written nothing yet.
function classifyEdits(libDir, entries, manifest, { take, keep }) {
  const decided = new Set([...take, ...keep, ...(manifest.kept ?? [])]);
  const edited = entries.filter(({ path }) => existsSync(join(libDir, path)) && sha256(join(libDir, path)) !== manifest.files[path]);
  const undecided = edited.filter(e => !decided.has(e.path));
  if (undecided.length) {
    const diffs = undecided.map(({ path, from }) => diffOf(from, join(libDir, path)));
    throw new SetupError(`edited plugin files: ${undecided.map(u => u.path).join(', ')}\nrerun with --take <files> to use the plugin's version or --keep <files> to keep yours\n\n${diffs.join('\n')}`, 5);
  }
  return edited.map(e => e.path);
}

// Adds to the lib package.json the dependencies the chosen adapters need and it lists nowhere yet,
// and returns them. A project pin, in dependencies or devDependencies, is never changed or removed.
function mergeMissingNpm(libDir, catalog, chosen) {
  const packageFile = join(libDir, 'package.json');
  if (!existsSync(packageFile)) return {};
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  const npmAdd = missingNpm(catalog, chosen, pkg);
  if (Object.keys(npmAdd).length) writeFileSync(packageFile, JSON.stringify(mergePackage(pkg, npmAdd), null, 2) + '\n');
  return npmAdd;
}

// Refreshes the plugin-owned files from the plugin on disk. A file whose sha256 still matches the
// manifest is replaced. An edited file needs a decision: `take` overwrites it, `keep` leaves it (and
// remembers that in manifest.kept). Any undecided edit stops the run with exit 5 before a single write.
// Project-owned files are never touched, with one exception: an npm dependency the newer plugin
// needs and package.json lacks is added (only added), reported, and installed before the verify.
// The generated files are rebuilt.
export function upgrade(repo, { take = [], keep = [], pluginRoot = PLUGIN_ROOT } = {}, { run = defaultRun, out = console.log } = {}) {
  const libDir = join(repo, LIB_DIR);
  const manifest = readManifest(libDir);
  if (!manifest) throw new SetupError(NO_MANIFEST, 1);
  const catalog = loadCatalog(pluginRoot);
  const chosen = resolveAdapters(catalog, manifest.adapters);
  const entries = pluginFiles(catalog, chosen);
  const takes = new Set(take);
  const keeps = new Set(keep);

  const edited = classifyEdits(libDir, entries, manifest, { take, keep });
  const kept = edited.filter(p => !takes.has(p));
  const replace = entries.filter(e => !kept.includes(e.path));
  const files = placeFiles(libDir, replace);
  for (const p of kept) files[p] = manifest.files[p];
  // A path the plugin no longer ships stays on disk, and in the manifest while it is there.
  const shipped = new Set(entries.map(e => e.path));
  const dropped = Object.keys(manifest.files).filter(p => !shipped.has(p) && existsSync(join(libDir, p)));
  for (const p of dropped) files[p] = manifest.files[p];

  writeManifest(libDir, { version: pluginVersion(pluginRoot), adapters: manifest.adapters, files, generated: [...GENERATED], previousExports: manifest.previousExports, kept });
  regenAdopt(repo, { pluginRoot });
  for (const p of dropped) out(`no longer shipped by the plugin, left in place: ${p}`);
  const npmAdded = mergeMissingNpm(libDir, catalog, chosen);
  if (Object.keys(npmAdded).length) {
    out(`added to package.json, needed by this plugin version: ${Object.entries(npmAdded).map(([n, v]) => `${n}@${v}`).join(', ')}`);
    install(repo, installNeeds(chosen), { run, out });
  }
  const result = verify(repo, { live: false }, { run, out });
  return { replaced: replace.map(e => e.path), edited, kept, dropped, npmAdded, verify: result };
}

// Copies one more adapter, and any requirement the lib lacks, into an existing lib; merges only its
// missing config keys and npm dependencies; regenerates the generated files; then installs.
export function add(repo, adapter, { take = [], keep = [], pluginRoot = PLUGIN_ROOT } = {}, { run = defaultRun, out = console.log } = {}) {
  const libDir = join(repo, LIB_DIR);
  const manifest = readManifest(libDir);
  if (!manifest) throw new SetupError(NO_MANIFEST, 1);
  if (manifest.adapters.includes(adapter)) return { added: [], already: true };
  const catalog = loadCatalog(pluginRoot);
  const chosen = resolveAdapters(catalog, [...manifest.adapters, adapter]);
  const added = chosen.map(a => a.name).filter(n => !manifest.adapters.includes(n));

  // Only files the lib does not list yet are placed; one already on disk is a collision and needs a decision.
  const fresh = pluginFiles(catalog, chosen).filter(e => !(e.path in manifest.files));
  const collided = classifyEdits(libDir, fresh, manifest, { take, keep });
  const kept = [...new Set([...(manifest.kept ?? []).filter(p => !take.includes(p)), ...collided.filter(p => !take.includes(p))])];
  const left = fresh.filter(e => kept.includes(e.path));
  const files = { ...manifest.files, ...placeFiles(libDir, fresh.filter(e => !left.includes(e))) };
  for (const e of left) files[e.path] = sha256(e.from);

  const configFile = join(libDir, 'scenarios.config.json');
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    const merged = mergeAdapterConfig(config, chosen);
    if (JSON.stringify(merged) !== JSON.stringify(config)) writeFileSync(configFile, JSON.stringify(merged, null, 2) + '\n');
  }
  mergeMissingNpm(libDir, catalog, chosen);

  writeManifest(libDir, { version: pluginVersion(pluginRoot), adapters: chosen.map(a => a.name), files, generated: [...GENERATED], previousExports: manifest.previousExports, kept });
  regenAdopt(repo, { pluginRoot });
  install(repo, installNeeds(chosen), { run, out });
  return { added, already: false };
}
