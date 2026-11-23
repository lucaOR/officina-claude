import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(root, 'plugins', 'planner-companion', 'skills', 'plan', 'scripts', 'planning.mjs');
const SRC = path.join(root, '.github', 'assets', 'src');

function planning(workDir, args) {
  const r = spawnSync(process.execPath, [CLI, ...args.map(String)], {
    encoding: 'utf8',
    cwd: workDir,
    env: { ...process.env, HOME: path.join(workDir, 'home'), XDG_STATE_HOME: path.join(workDir, 'state') },
  });
  if (r.status !== 0) throw new Error(`planning ${args[0]} failed (${r.status}): ${r.stdout}${r.stderr}`);
  return r.stdout;
}

export async function buildDemoPlan(workDir) {
  const plan = JSON.parse(fs.readFileSync(path.join(SRC, 'plan.json'), 'utf8'));
  const thread = JSON.parse(fs.readFileSync(path.join(SRC, 'plan-thread.json'), 'utf8'));
  fs.mkdirSync(workDir, { recursive: true });

  const dir = planning(workDir, ['init', 'bookshop-checkout', '--title', plan.title, '--date', '2026-11-02', '--project', workDir]).trim();

  const skip = new Set(['decisions', 'tasks', 'scenarios', 'slug']);
  const set = Object.fromEntries(Object.entries(plan).filter(([k]) => !skip.has(k)));
  const patch = path.join(workDir, 'plan-patch.json');
  fs.writeFileSync(patch, JSON.stringify({ set, upsert: [...plan.decisions, ...plan.tasks, ...plan.scenarios] }));
  planning(workDir, ['apply', dir, patch, '--kind', 'author']);

  const asked = JSON.parse(planning(workDir, ['ask', dir, 'comment', thread.target, thread.question]));
  planning(workDir, ['answer', dir, asked.question.id, '--text', thread.answer]);

  const out = path.join(workDir, 'plan.html');
  planning(workDir, ['render', dir, '--out', out]);
  return out;
}
