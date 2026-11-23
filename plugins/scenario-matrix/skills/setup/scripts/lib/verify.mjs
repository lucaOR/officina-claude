import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRun } from './install.mjs';
import { LIB_DIR, SCENARIOS_DIR } from './plan.mjs';

// Checks an installed lib: for each matrix its check, lint and plan, then that index.mjs imports
// (every scenario script imports it, so a kept lever naming an export a replaced file dropped, or a
// bad project-exports.mjs line, would fail every row), then the lib's own tests, and the selftest
// only with `live` (it needs the stack up). Prints a table and returns { rows, ok }.
export function verify(repo, { live = false } = {}, { run = defaultRun, out = console.log } = {}) {
  const scenarios = join(repo, SCENARIOS_DIR);
  const libDir = join(repo, LIB_DIR);
  const epics = existsSync(scenarios)
    ? readdirSync(scenarios).filter(f => f.endsWith('.yaml') && !f.startsWith('_')).map(f => f.slice(0, -'.yaml'.length)).sort()
    : [];
  const rows = [];
  const check = (label, command, args, cwd) => {
    const r = run(command, args, { cwd });
    rows.push({ check: label, result: r.status === 0 ? 'pass' : `fail (exit ${r.status})` });
  };

  if (!epics.length) rows.push({ check: 'matrices', result: 'none yet: nothing to check, lint or plan' });
  for (const epic of epics) {
    check(`check ${epic}`, 'node', ['_lib/check.mjs', `${epic}.yaml`], scenarios);
    check(`lint ${epic}`, 'node', ['_lib/lint.mjs', epic], scenarios);
    check(`plan ${epic}`, 'node', ['_lib/run.mjs', epic, '--plan'], scenarios);
  }
  check('import index.mjs', 'node', ['--input-type=module', '-e', "await import('./index.mjs')"], libDir);
  check('npm test', 'npm', ['test'], libDir);
  for (const epic of epics) {
    if (live) check(`selftest ${epic}`, 'node', ['_lib/selftest.mjs', epic], scenarios);
    else rows.push({ check: `selftest ${epic}`, result: 'skipped: needs the stack up, pass --live' });
  }
  if (!epics.length && !live) rows.push({ check: 'selftest', result: 'skipped: needs the stack up, pass --live' });

  const width = Math.max(...rows.map(r => r.check.length));
  for (const r of rows) out(`${r.check.padEnd(width)}  ${r.result}`);
  return { rows, ok: rows.every(r => r.result === 'pass' || r.result.startsWith('skipped') || r.result.startsWith('none')) };
}
