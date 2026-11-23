// A project's hooks.mjs may import the runtime's own modules (a lint rule reusing lint.mjs's
// scanner, a login op calling the http client). ext.mjs imports hooks.mjs statically, so such an
// import puts the runtime module in an import cycle with hooks.mjs, and a CLI module that awaited at
// its top level inside that cycle never finished loading. This drives the CLIs in an assembled lib
// whose hooks.mjs imports lint.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assemble } from '../dev/assemble.mjs';

const HOOKS = `import { stripComments } from './lint.mjs';
export const lint = {
  rules: () => [{
    id: 'cycle-probe', owner: 'project', kind: 'source',
    check: source => (stripComments(source).code.includes('CYCLE_PROBE') ? ['cycle probe rule ran'] : []),
  }],
};
`;

const MATRIX = `epic: probe
infra:
  env_registry:
    hosts: { app: app.test }
scenarios:
  - id: A-01
    behaviour: probe row
`;

function cycleLib(t) {
  const dest = mkdtempSync(join(tmpdir(), 'scn-hooks-cycle-'));
  t.after(() => rmSync(dest, { recursive: true, force: true }));
  const { repo, libDir } = assemble(dest, { adapters: 'none' });
  writeFileSync(join(libDir, 'hooks.mjs'), HOOKS);
  const matrices = join(dest, 'matrices');
  mkdirSync(matrices);
  writeFileSync(join(matrices, 'probe.yaml'), MATRIX);
  const scripts = join(repo, '.claude', 'scenarios', '_scripts', 'probe');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'A-01.mjs'), '#!/usr/bin/env node\nconst CYCLE_PROBE = 1;\n');
  const cli = (file, args) => spawnSync(process.execPath, [join(libDir, file), ...args], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, SCN_MATRIX_DIR: matrices },
  });
  return { cli };
}

test('the hash CLI finishes when the project hooks import lint.mjs', (t) => {
  const r = cycleLib(t).cli('hash.mjs', ['probe', 'A-01']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^[0-9a-f]{12}$/);
});

test('the lint CLI finishes when the project hooks import lint.mjs, and runs the project rule', (t) => {
  const r = cycleLib(t).cli('lint.mjs', ['probe']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /A-01: cycle probe rule ran/);
});
