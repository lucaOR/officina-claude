import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeDemoTranscripts } from './transcripts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(root, 'plugins', 'token-hygiene', 'hooks', 'record-session-metrics.js');
const BUILDER = path.join(root, 'plugins', 'token-hygiene', 'skills', 'token-dashboard', 'scripts', 'build-dashboard.mjs');

function run(script, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, input: '{}' });
  if (r.status !== 0) throw new Error(`${path.basename(script)} failed (${r.status}): ${r.stdout}${r.stderr}`);
}

export async function buildDemoDashboard(workDir) {
  // HOME is always the work dir's own, so neither child can reach the real ~/.claude/metrics.
  const home = path.join(workDir, 'home');
  const env = { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: '/demo/bookshop' };
  for (const k of ['METRICS_SUFFIX', 'METRICS_DIR', 'METRICS_RESCAN']) delete env[k];

  writeDemoTranscripts(path.join(home, '.claude', 'projects', '-demo-bookshop'));
  run(HOOK, [], env);

  const metrics = path.join(home, '.claude', 'metrics');
  const out = path.join(workDir, 'dashboard.html');
  run(BUILDER, ['--dir', metrics, '--out', out], env);
  if (!fs.existsSync(out)) throw new Error('the dashboard builder wrote no file');
  return out;
}
