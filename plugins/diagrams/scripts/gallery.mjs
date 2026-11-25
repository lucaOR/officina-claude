#!/usr/bin/env node
// Builds the gallery from the json examples in skills/diagram/reference/rows.md: examples/<kind>.json,
// examples/<kind>.svg and the block of README.md between the gallery markers.
//   node scripts/gallery.mjs          write the files
//   node scripts/gallery.mjs --check  write nothing; exit 1 and list every file that would change
// Every path resolves from this file, so the working directory does not matter.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES } from '../lib/rows.mjs';
import { renderStandalone } from '../lib/standalone.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rowsFile = path.join(root, 'skills', 'diagram', 'reference', 'rows.md');
const readmeFile = path.join(root, 'README.md');
const OPEN = '<!-- gallery -->';
const CLOSE = '<!-- /gallery -->';

const blocks = [...fs.readFileSync(rowsFile, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]);
const specs = blocks.map(b => JSON.parse(b));
if (specs.map(s => s.type).join() !== TYPES.join()) throw new Error('rows.md must hold one json example per kind, in the order of TYPES');

// The alt text is plain prose, so brackets and line breaks cannot break the markdown image.
const alt = s => String(s.title).replace(/[\[\]\r\n]+/g, ' ');

const gallery = [OPEN, ...specs.flatMap((spec, i) => [
  '',
  `#### ${spec.type}`,
  '',
  `![${alt(spec)}](examples/${spec.type}.svg)`,
  '',
  `Spec: [\`examples/${spec.type}.json\`](examples/${spec.type}.json)`,
]), '', CLOSE].join('\n');

const expected = new Map();
specs.forEach((spec, i) => {
  expected.set(`examples/${spec.type}.json`, `${blocks[i].trimEnd()}\n`);
  expected.set(`examples/${spec.type}.svg`, `${renderStandalone(spec).svg}\n`);
});

const readme = fs.readFileSync(readmeFile, 'utf8');
const from = readme.indexOf(OPEN);
const to = readme.indexOf(CLOSE);
if (from < 0 || to < from) throw new Error(`README.md needs ${OPEN} and ${CLOSE} markers`);
expected.set('README.md', readme.slice(0, from) + gallery + readme.slice(to + CLOSE.length));

const read = rel => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return undefined; } };
const differs = [...expected].filter(([rel, text]) => read(rel) !== text).map(([rel]) => rel);
const stale = fs.existsSync(path.join(root, 'examples'))
  ? fs.readdirSync(path.join(root, 'examples')).map(f => `examples/${f}`).filter(rel => !expected.has(rel))
  : [];

if (process.argv.includes('--check')) {
  const bad = [...differs, ...stale];
  if (bad.length) {
    process.stdout.write(`gallery out of date:\n${bad.map(f => `  ${f}`).join('\n')}\nrun: node scripts/gallery.mjs\n`);
    process.exit(1);
  }
  process.exit(0);
}

fs.mkdirSync(path.join(root, 'examples'), { recursive: true });
for (const rel of stale) fs.rmSync(path.join(root, rel));
for (const rel of differs) fs.writeFileSync(path.join(root, rel), expected.get(rel));
process.stdout.write(`gallery: ${differs.length} file(s) written, ${stale.length} removed\n`);
