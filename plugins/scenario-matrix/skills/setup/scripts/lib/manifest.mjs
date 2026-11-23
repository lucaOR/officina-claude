import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const MANIFEST = '.plugin-manifest.json';

export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// The manifest records what the plugin owns in a lib: its version, the chosen adapters, the sha256
// of every plugin-owned file it wrote, and the names of the files it generated. An adopted harness
// also records `previousExports`, the names its old index.mjs exported, so regen can still compare, and `kept`, the plugin files an upgrade left edited on purpose.
export function readManifest(libDir) {
  const file = join(libDir, MANIFEST);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export function writeManifest(libDir, { version, adapters, files, generated, previousExports, kept }) {
  const manifest = { version, adapters, files, generated, ...(previousExports && { previousExports }), ...(kept?.length && { kept }) };
  writeFileSync(join(libDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}
