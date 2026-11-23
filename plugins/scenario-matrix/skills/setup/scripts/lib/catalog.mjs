import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The plugin root, found from this file: skills/setup/scripts/lib is four levels below it.
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// The catalog is the plugin's runtime/ tree: core.json plus one adapter.json per adapter directory.
export function loadCatalog(pluginRoot) {
  const runtime = join(pluginRoot, 'runtime');
  const coreDir = join(runtime, 'core');
  const core = { ...readJson(join(coreDir, 'core.json')), dir: coreDir };
  const adapters = new Map();
  const adaptersDir = join(runtime, 'adapters');
  if (existsSync(adaptersDir)) {
    for (const entry of readdirSync(adaptersDir, { withFileTypes: true }).filter(e => e.isDirectory()).sort((x, y) => x.name.localeCompare(y.name))) {
      const dir = join(adaptersDir, entry.name);
      if (!existsSync(join(dir, 'adapter.json'))) continue;
      const adapter = readJson(join(dir, 'adapter.json'));
      // The catalog is keyed by directory and the generated files use `name`, so the two must agree.
      if (adapter.name !== entry.name) {
        throw new Error(`runtime/adapters/${entry.name}/adapter.json names "${adapter.name}": an adapter's name must equal its directory`);
      }
      adapters.set(entry.name, { ...adapter, dir });
    }
  }
  return { core, adapters };
}

// Adds missing requires transitively, then orders them so a requirement precedes its dependants.
// Ties break alphabetically, which keeps the generated files stable.
export function resolveAdapters(catalog, names) {
  const { adapters } = catalog;
  const want = new Set();
  const visit = name => {
    if (want.has(name)) return;
    if (!adapters.has(name)) throw new Error(`unknown adapter: ${name} (catalog: ${[...adapters.keys()].sort().join(', ')})`);
    want.add(name);
    for (const req of adapters.get(name).requires ?? []) visit(req);
  };
  names.forEach(visit);
  const ordered = [];
  const done = new Set();
  while (ordered.length < want.size) {
    const ready = [...want].filter(n => !done.has(n) && (adapters.get(n).requires ?? []).every(r => done.has(r))).sort();
    if (!ready.length) throw new Error(`adapter requires form a cycle: ${[...want].filter(n => !done.has(n)).sort().join(', ')}`);
    done.add(ready[0]);
    ordered.push(adapters.get(ready[0]));
  }
  return ordered;
}
