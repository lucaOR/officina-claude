// Keeps planner-companion's copy of the diagrams renderer in step with plugins/diagrams/lib.
//   node tools/sync-diagram.mjs           regenerate the copy
//   node tools/sync-diagram.mjs --check   exit 1 when the copy differs from the source
// Both also keep reference/diagram-rows.md a byte copy of the diagrams plugin's rows.md.
// Options --source=<dir> --target=<dir> --rows-source=<file> --rows-target=<file>; defaults are the real paths.
// The copy is generated: never edit it. GENERATED.json records a hash of the contents (not a git SHA).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = path.join(REPO, 'plugins/diagrams/lib');
export const TARGET = path.join(REPO, 'plugins/planner-companion/skills/plan/scripts/lib/diagram');
export const DOC_SOURCE = path.join(REPO, 'plugins/diagrams/skills/diagram/reference/rows.md');
export const DOC_TARGET = path.join(REPO, 'plugins/planner-companion/skills/plan/reference/diagram-rows.md');
export const MANIFEST = 'GENERATED.json';

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const mjsFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(f => f.endsWith('.mjs')).sort();

function manifestText(source) {
  const files = {};
  for (const f of mjsFiles(source)) files[f] = sha(fs.readFileSync(path.join(source, f)));
  const hash = sha(Object.entries(files).map(([f, h]) => `${f} ${h}\n`).join(''));
  return JSON.stringify({ generated: 'by tools/sync-diagram.mjs from plugins/diagrams/lib; do not edit; verify with node tools/sync-diagram.mjs --check', sha256: hash, files }, null, 2) + '\n';
}

function assertSource(source) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`source directory not found: ${source}`);
  if (!mjsFiles(source).length) throw new Error(`source directory has no .mjs files: ${source}`);
}

/** Rewrites `target` so it holds exactly the source's .mjs files and a manifest. Throws, touching nothing, on a bad source or a target that is not a generated copy. */
export function sync(source = SOURCE, target = TARGET) {
  assertSource(source);
  const isLink = fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink();
  if (!isLink && fs.existsSync(target) && fs.readdirSync(target).length && !fs.existsSync(path.join(target, MANIFEST))) {
    throw new Error(`refusing to replace ${target}: it is not empty and has no ${MANIFEST}`);
  }
  const tmp = `${target}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const f of mjsFiles(source)) fs.copyFileSync(path.join(source, f), path.join(tmp, f));
  fs.writeFileSync(path.join(tmp, MANIFEST), manifestText(source));
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(tmp, target);
}

/** Copies the rows reference byte for byte (a header would break the byte check). */
export function syncDoc(source = DOC_SOURCE, target = DOC_TARGET) {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`source file not found: ${source}`);
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

/** @returns {string[]} one problem per drifted, missing or stale file; empty when in step. Throws on a missing source. */
export function check(source = SOURCE, target = TARGET) {
  assertSource(source);
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

/** @returns {string[]} a problem when the copied file is a link, missing or not byte-identical */
export function checkDoc(source = DOC_SOURCE, target = DOC_TARGET) {
  if (!fs.existsSync(source)) throw new Error(`source file not found: ${source}`);
  const name = path.basename(target);
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return [`${name}: is a symlink, must be a real copy`];
  if (!fs.existsSync(target)) return [`${name}: missing from the copy`];
  return fs.readFileSync(source).equals(fs.readFileSync(target)) ? [] : [`${name}: differs from the source`];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => path.resolve(process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt);
  const [source, target] = [arg('source', SOURCE), arg('target', TARGET)];
  const [docSource, docTarget] = [arg('rows-source', DOC_SOURCE), arg('rows-target', DOC_TARGET)];
  try {
    if (process.argv.includes('--check')) {
      const problems = [...check(source, target), ...checkDoc(docSource, docTarget)];
      if (problems.length) {
        console.error(`planner-companion's generated diagram files have drifted:\n${problems.map(p => `  ${p}`).join('\n')}\nrun: node tools/sync-diagram.mjs`);
        process.exit(1);
      }
      console.log('generated diagram files are in step with plugins/diagrams');
    } else {
      sync(source, target);
      syncDoc(docSource, docTarget);
      console.log(`synced ${mjsFiles(source).length} files to ${path.relative(REPO, target)} and the rows reference to ${path.relative(REPO, docTarget)}`);
    }
  } catch (e) {
    console.error(`sync-diagram: ${e.message}`);
    process.exit(2);
  }
}
