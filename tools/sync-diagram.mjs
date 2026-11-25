// Keeps planner-companion's copy of the diagrams renderer in step with plugins/diagrams/lib.
//   node tools/sync-diagram.mjs           regenerate the copy
//   node tools/sync-diagram.mjs --check   exit 1 when the copy differs from the source
// Both take --source=<dir> and --target=<dir>; the defaults are the real directories.
// The copy is generated: never edit it. GENERATED.json records a hash of the contents (not a git SHA).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(REPO, 'plugins/diagrams/lib');
export const TARGET = path.join(REPO, 'plugins/planner-companion/skills/plan/scripts/lib/diagram');
export const MANIFEST = 'GENERATED.json';

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mjsFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.endsWith('.mjs')).sort();

function manifestText(source) {
  const files = {};
  for (const f of mjsFiles(source)) files[f] = sha(fs.readFileSync(path.join(source, f)));
  const hash = sha(Object.entries(files).map(([f, h]) => `${f} ${h}\n`).join(''));
  return JSON.stringify({ generated: 'by tools/sync-diagram.mjs from plugins/diagrams/lib; do not edit', sha256: hash, files }, null, 2) + '\n';
}

/** Rewrites `target` so it holds exactly the source's .mjs files and a manifest. */
export function sync(source = SOURCE, target = TARGET) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const f of mjsFiles(source)) fs.copyFileSync(path.join(source, f), path.join(target, f));
  fs.writeFileSync(path.join(target, MANIFEST), manifestText(source));
}

/** @returns {string[]} one problem per drifted, missing or stale file; empty when in step */
export function check(source = SOURCE, target = TARGET) {
  const problems = [];
  const want = mjsFiles(source);
  const have = mjsFiles(target);
  for (const f of want) {
    if (!have.includes(f)) problems.push(`${f}: missing from the copy`);
    else if (!fs.readFileSync(path.join(source, f)).equals(fs.readFileSync(path.join(target, f)))) problems.push(`${f}: differs from the source`);
  }
  for (const f of have) if (!want.includes(f)) problems.push(`${f}: stale, not in the source`);
  const mf = path.join(target, MANIFEST);
  if (!fs.existsSync(mf)) problems.push(`${MANIFEST}: missing`);
  else if (fs.readFileSync(mf, 'utf8') !== manifestText(source)) problems.push(`${MANIFEST}: does not match the source hash`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const [source, target] = [path.resolve(arg('source') ?? SOURCE), path.resolve(arg('target') ?? TARGET)];
  if (process.argv.includes('--check')) {
    const problems = check(source, target);
    if (problems.length) {
      console.error(`planner-companion's diagram copy has drifted:\n${problems.map(p => `  ${p}`).join('\n')}\nrun: node tools/sync-diagram.mjs`);
      process.exit(1);
    }
    console.log('diagram copy is in step with plugins/diagrams/lib');
  } else {
    sync(source, target);
    console.log(`synced ${mjsFiles(source).length} files to ${path.relative(REPO, target)}`);
  }
}
