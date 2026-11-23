// Reset a scenario's environment in four phases. Adapters contribute steps
// (each { phase, name, run(reg, ctx) }), and the project supplies a baseline
// command in config or a hook. Core names no technology: what a step does is
// the adapter's business.
import { spawn } from 'node:child_process';
import { Blocked, Ko, Inconclusive } from './errors.mjs';
import { hook, contributions } from './ext.mjs';
import { config, repoPath } from './config.mjs';

export const PHASES = ['prepare', 'restore', 'probe', 'normalize'];

// Both pipes are drained. A piped stream with no reader blocks the child the
// moment it fills the ~64 KB pipe buffer, so a chatty baseline would hang
// forever. `stdio: 'ignore'` for stdout would also fix the hang, but the bytes
// are worth keeping: they are the only account of what the restore did when it
// fails.
//
// Blocked, not a plain Error: reset is the environment coming up, so its
// failure says nothing about the product (see errors.mjs).
function bash(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], cwd: repoPath('.') });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(new Blocked(`reset could not start bash: ${e.message}`)));
    child.on('close', code => code === 0
      ? resolve(out)
      : reject(new Blocked(`reset exited ${code}: ${err.trim() || out.trim()}`)));
  });
}

// Runs config().reset.baseline through bash from the project root. A null or
// empty baseline does nothing.
export async function defaultBaseline() {
  const cmd = config().reset?.baseline;
  if (!cmd) return;
  await bash(cmd);
}

export async function reset(reg, {
  steps = contributions('reset'),
  baseline = hook('reset.baseline', defaultBaseline),
} = {}) {
  try {
    for (const s of steps) {
      if (!PHASES.includes(s.phase)) {
        throw new Blocked(`reset step ${s.owner}/${s.name} has unknown phase ${s.phase}`);
      }
    }
    const ctx = {};
    for (const phase of PHASES) {
      // The baseline is the first thing the restore phase does, even when no
      // adapter contributes a restore step.
      if (phase === 'restore') await baseline({ reg });
      // Filter keeps adapter order within a phase.
      for (const s of steps.filter(x => x.phase === phase)) await s.run(reg, ctx);
    }
  } catch (err) {
    // Already-typed throws pass through untouched, so a Ko a step raises
    // deliberately still counts as one. An untyped rejection would classify as
    // KO and a whole matrix would read as product bugs.
    if (err instanceof Blocked || err instanceof Ko || err instanceof Inconclusive) throw err;
    throw new Blocked(`reset failed: ${err?.message ?? String(err)}`);
  }
}
