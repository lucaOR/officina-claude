#!/usr/bin/env node
// Dev only: builds a project-shaped tree with the core and the chosen adapters flat in
// <dest>/.claude/scenarios/_lib/, so the runtime tests can run outside an installed project.
import { copyFileSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, resolveAdapters } from '../skills/setup/scripts/lib/catalog.mjs';
import { mergeAdapterConfig, newPackage, placeFiles, pluginVersion, writeGenerated } from '../skills/setup/scripts/lib/apply.mjs';
import { npmDependencies, pluginFiles } from '../skills/setup/scripts/lib/plan.mjs';
import { writeManifest } from '../skills/setup/scripts/lib/manifest.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function assemble(dest, { adapters = 'all' } = {}) {
  const catalog = loadCatalog(PLUGIN);
  const names = adapters === 'all' ? [...catalog.adapters.keys()] : adapters === 'none' ? [] : adapters;
  const chosen = resolveAdapters(catalog, names);
  const repo = resolve(dest);
  const libDir = join(repo, '.claude', 'scenarios', '_lib');
  rmSync(libDir, { recursive: true, force: true });

  const files = placeFiles(libDir, pluginFiles(catalog, chosen));

  copyFileSync(join(PLUGIN, 'test', 'fixtures', 'assembled', 'hooks.mjs'), join(libDir, 'hooks.mjs'));
  const config = mergeAdapterConfig(JSON.parse(readFileSync(join(PLUGIN, 'test', 'fixtures', 'assembled', 'scenarios.config.json'), 'utf8')), chosen);
  writeFileSync(join(libDir, 'scenarios.config.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(libDir, 'project-exports.mjs'), "// project exports: only `export { a } from './x.mjs';` statements\nexport {};\n");
  const generated = writeGenerated(libDir, { catalog, chosen, pluginRoot: PLUGIN });
  writeFileSync(join(libDir, 'package.json'), JSON.stringify(newPackage('scenario-matrix-assembled', npmDependencies(catalog, chosen)), null, 2) + '\n');
  writeManifest(libDir, { version: pluginVersion(PLUGIN), adapters: chosen.map(a => a.name), files, generated });
  // The lib sits two directories below .claude, so it finds node_modules at the repo root.
  rmSync(join(repo, 'node_modules'), { recursive: true, force: true });
  symlinkSync(join(PLUGIN, 'node_modules'), join(repo, 'node_modules'), 'dir');
  return { repo, libDir };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dest = args.find(a => !a.startsWith('--'));
  const i = args.indexOf('--adapters');
  const v = i >= 0 ? args[i + 1] : 'all';
  if (!dest) { console.error('usage: assemble.mjs <dest> [--adapters all|none|a,b]'); process.exit(64); }
  const { libDir } = assemble(dest, { adapters: v === 'all' || v === 'none' ? v : v.split(',').filter(Boolean) });
  console.log(libDir);
}
