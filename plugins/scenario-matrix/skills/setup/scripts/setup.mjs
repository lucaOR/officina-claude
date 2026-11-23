#!/usr/bin/env node
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCatalog, resolveAdapters, PLUGIN_ROOT } from './lib/catalog.mjs';
import { detect } from './lib/detect.mjs';
import { plan, installNeeds, LIB_DIR } from './lib/plan.mjs';
import { apply } from './lib/apply.mjs';
import { planAdopt, applyAdopt, regenAdopt } from './lib/adopt.mjs';
import { install } from './lib/install.mjs';
import { verify } from './lib/verify.mjs';
import { upgrade, add } from './lib/upgrade.mjs';
import { readManifest } from './lib/manifest.mjs';
import { SetupError } from './lib/errors.mjs';

const USAGE = [
  'usage: setup.mjs detect <repo> [--json]',
  '       setup.mjs plan <repo> --adapters a,b [--json]',
  '       setup.mjs apply <repo> --adapters a,b [--json]',
  '       setup.mjs regen <repo>',
  '       setup.mjs install <repo>',
  '       setup.mjs verify <repo> [--live]',
  '       setup.mjs upgrade <repo> [--take f,g] [--keep f,g]',
  '       setup.mjs add <repo> <adapter> [--take f,g] [--keep f,g]',
].join('\n');

function printTable(found) {
  console.log(`mode: ${found.mode}`);
  for (const { name, evidence } of found.adapters) {
    const first = evidence[0];
    console.log(`  ${name.padEnd(10)} ${first.file ?? '-'}${first.line ? `:${first.line}` : ''}  (${first.signal})`);
  }
  const { harness } = found.assets;
  console.log(`assets: ${harness.libFiles.length} lib files, ${harness.matrices.length} matrices, ${harness.scripts.length} scripts, ${harness.infra.length} infra files, ${found.assets.compose.length} compose files, ${found.assets.makeTargets.length} make targets, ${found.assets.scripts.length} runnable scripts, login state ${found.assets.loginState ?? 'none'}`);
}

// `--adapters a,b` and `--json` among the positional arguments. An unknown flag, or a repo that is
// not a directory, is a usage error (64): taken as the repo, a typo would inventory nothing.
function parseArgs(args) {
  const flags = { json: false, live: false, adapters: null, take: [], keep: [] };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') flags.json = true;
    else if (args[i] === '--live') flags.live = true;
    else if (args[i] === '--adapters') flags.adapters = (args[++i] ?? '').split(',').filter(Boolean);
    else if (args[i] === '--take') flags.take = (args[++i] ?? '').split(',').filter(Boolean);
    else if (args[i] === '--keep') flags.keep = (args[++i] ?? '').split(',').filter(Boolean);
    else if (args[i].startsWith('-')) throw new SetupError(`unknown flag: ${args[i]}\n${USAGE}`, 64);
    else positional.push(args[i]);
  }
  const repo = positional[0] ? resolve(positional[0]) : null;
  if (repo && !isDirectory(repo)) throw new SetupError(`no such directory: ${repo}\n${USAGE}`, 64);
  return { flags, repo, adapter: positional[1] };
}

const isDirectory = path => { try { return statSync(path).isDirectory(); } catch { return false; } };

// The plan the setup skill shows, in the mode the repo is in.
function planFor(repo, adapters) {
  const { mode } = detect(repo, loadCatalog(PLUGIN_ROOT));
  return mode === 'adopt' ? planAdopt(repo, { adapters }) : plan(repo, { adapters, mode });
}

function printPlan(p) {
  console.log(`mode: ${p.mode}`);
  console.log(`adapters: ${p.adapters.join(', ') || 'none'}`);
  console.log(`write: ${p.write.length} files, ${p.infra.length} infra files, generated ${p.generated.join(', ')}`);
  console.log(`npm: ${Object.entries(p.npmAdd).map(([n, v]) => `${n}@${v}`).join(', ') || 'nothing to add'}`);
  console.log(`post-install: ${p.postInstall.join('; ') || 'none'}`);
  for (const [distro, pkgs] of Object.entries(p.systemPackages)) console.log(`system packages (${distro}): ${pkgs.join(' ')}`);
  if (p.mode !== 'adopt') return;
  const list = (label, items) => console.log(`${label}: ${items.join(', ') || 'none'}`);
  list('replace', p.replace);
  list('keep', p.keep);
  list('tests replaced', p.testsReplaced);
  list('export lines moved to project-exports.mjs', p.projectExportLines);
  list('files naming the old skills (not edited)', p.skillMentions);
}

// A path in both --take and --keep is a usage error.
function conflicting(flags) {
  const both = flags.take.filter(p => flags.keep.includes(p));
  if (both.length) console.error(`in both --take and --keep: ${both.join(', ')}`);
  return both.length > 0;
}

const missingArgs = (repo, flags) => !repo || !flags.adapters;

const commands = {
  detect(args) {
    const { flags, repo } = parseArgs(args);
    if (!repo) { console.error(USAGE); return 64; }
    const found = detect(repo, loadCatalog(PLUGIN_ROOT));
    if (flags.json) console.log(JSON.stringify(found, null, 2));
    else printTable(found);
    return 0;
  },
  plan(args) {
    const { flags, repo } = parseArgs(args);
    if (missingArgs(repo, flags)) { console.error(USAGE); return 64; }
    const p = planFor(repo, flags.adapters);
    if (flags.json) console.log(JSON.stringify(p, null, 2));
    else printPlan(p);
    return 0;
  },
  apply(args) {
    const { flags, repo } = parseArgs(args);
    if (missingArgs(repo, flags)) { console.error(USAGE); return 64; }
    const p = planFor(repo, flags.adapters);
    const result = (p.mode === 'adopt' ? applyAdopt : apply)(repo, p);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`wrote ${result.written.length} files`);
    return 0;
  },
  regen(args) {
    const { repo } = parseArgs(args);
    if (!repo) { console.error(USAGE); return 64; }
    regenAdopt(repo);
    console.log('regenerated; every old export is provided');
    return 0;
  },
  install(args) {
    const { repo } = parseArgs(args);
    if (!repo) { console.error(USAGE); return 64; }
    const manifest = readManifest(join(repo, LIB_DIR));
    if (!manifest) { console.error('no .plugin-manifest.json: run apply first'); return 1; }
    const catalog = loadCatalog(PLUGIN_ROOT);
    install(repo, installNeeds(resolveAdapters(catalog, manifest.adapters)));
    return 0;
  },
  verify(args) {
    const { flags, repo } = parseArgs(args);
    if (!repo) { console.error(USAGE); return 64; }
    return verify(repo, { live: flags.live }).ok ? 0 : 1;
  },
  upgrade(args) {
    const { flags, repo } = parseArgs(args);
    if (!repo) { console.error(USAGE); return 64; }
    if (conflicting(flags)) return 64;
    const result = upgrade(repo, { take: flags.take, keep: flags.keep });
    const added = Object.entries(result.npmAdded).map(([n, v]) => `${n}@${v}`).join(', ') || 'none';
    console.log(`replaced ${result.replaced.length} files, kept ${result.kept.length} edited: ${result.kept.join(', ') || 'none'}; npm dependencies added: ${added}`);
    return result.verify.ok ? 0 : 1;
  },
  add(args) {
    const { flags, repo, adapter } = parseArgs(args);
    if (!repo || !adapter) { console.error(USAGE); return 64; }
    if (conflicting(flags)) return 64;
    const result = add(repo, adapter, { take: flags.take, keep: flags.keep });
    console.log(result.already ? `${adapter} is already installed` : `added ${result.added.join(', ')}`);
    return 0;
  },
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.error(USAGE);
  process.exit(64);
}
try {
  process.exit(commands[command](args));
} catch (err) {
  console.error(err.message);
  process.exit(err.exitCode ?? 1);
}
