// Checks that every publishable plugin packs cleanly: node tools/pack-check.mjs
// Runs `npm pack --dry-run --json` per plugin (nothing is written or published) and exits 1 when
// a name or version disagrees with plugin.json, a forbidden path would ship, the manifest is missing
// from the tarball, or a bin target is missing, unshipped or has no shebang.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = name => path.join(REPO, 'plugins', name);
// Published to npm.
export const plugins = ['diagrams', 'session', 'token-hygiene', 'planner-companion', 'knowledge'].map(at);
// Kept out of npm on purpose: must stay private.
export const privatePlugins = ['scenario-matrix'].map(at);

const FORBIDDEN = [/(^|\/)node_modules(\/|$)/, /(^|\/)__pycache__(\/|$)/, /(^|\/)\.project-terms$/, /(^|\/)\.env(\.|$)/, /\.log$/, /\.pyc$/];

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// The file paths npm would put in the tarball of the package in `dir`.
export function pack(dir) {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm pack failed in ${dir}: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout)[0].files.map(f => f.path);
}

export function checkPackage(dir) {
  const problems = [], warnings = [];
  const dirName = path.basename(dir);
  let pkg, man;
  try { pkg = readJson(path.join(dir, 'package.json')); } catch (e) { return { problems: [`package.json unreadable: ${e.message}`], warnings }; }
  try { man = readJson(path.join(dir, '.claude-plugin/plugin.json')); } catch { man = null; }
  if (pkg.name !== `@officina-claude/${dirName}`) problems.push(`name ${pkg.name} should be @officina-claude/${dirName}`);
  if (pkg.private) problems.push('package is private and cannot be published');
  if (man && pkg.version !== man.version) problems.push(`version ${pkg.version} differs from plugin.json ${man.version}`);
  let files;
  try { files = pack(dir); } catch (e) { return { problems: [...problems, e.message], warnings }; }
  for (const f of files) if (FORBIDDEN.some(re => re.test(f))) problems.push(`forbidden path in tarball: ${f}`);
  if (!files.includes('.claude-plugin/plugin.json')) problems.push('.claude-plugin/plugin.json is not in the tarball');
  const bins = typeof pkg.bin === 'string' ? { [dirName]: pkg.bin } : pkg.bin || {};
  for (const [cmd, target] of Object.entries(bins)) {
    const rel = path.posix.normalize(target);
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { problems.push(`bin ${cmd}: ${rel} does not exist`); continue; }
    if (!files.includes(rel)) problems.push(`bin ${cmd}: ${rel} is not in the tarball`);
    if (!fs.readFileSync(abs, 'utf8').startsWith('#!')) problems.push(`bin ${cmd}: ${rel} has no shebang line`);
  }
  if (!files.some(f => /^licen[sc]e(\.|$)/i.test(f))) warnings.push('no LICENSE file in the tarball (npm only picks one up from the package directory)');
  return { problems, warnings, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = false;
  for (const dir of plugins) {
    const { problems, warnings, files } = checkPackage(dir);
    const name = path.basename(dir);
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}${files ? ` (${files.length} files)` : ''}`);
    for (const p of problems) console.log(`     ${p}`);
    for (const w of warnings) console.log(`     warning: ${w}`);
    if (problems.length) failed = true;
  }
  for (const dir of privatePlugins) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg.private !== true) { failed = true; console.log(`FAIL ${path.basename(dir)}: must stay private`); }
    else console.log(`ok   ${path.basename(dir)} (private, not packed)`);
  }
  process.exit(failed ? 1 : 0);
}
