import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const QUERY = fileURLToPath(new URL('../query.mjs', import.meta.url));
const MATRIX = `epic: demo
perimeter: { in: [a], out: [b] }
scenarios:
  - id: H-1
    behaviour: first
    status: open
  - id: H-10
    behaviour: |
      tenth
      of many
    status: verified
  - id: H-2
    behaviour: second
    status: drift
`;

function run(args, matrix = MATRIX) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-query-'));
  try {
    if (matrix !== null) writeFileSync(join(dir, 'demo.yaml'), matrix);
    const r = spawnSync(process.execPath, [QUERY, ...args], { encoding: 'utf8', env: { ...process.env, SCN_MATRIX_DIR: dir } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('an exact id beats a prefix', () => {
  const r = run(['demo', 'h-1']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'id: H-1\nbehaviour: first\nstatus: open\n');
});

test('a prefix selects a family', () => {
  const family = run(['demo', 'H', '--list']);
  assert.equal(family.out.trim().split('\n').length, 3);
  const multi = run(['demo', 'H-2', '--json']);
  assert.deepEqual(JSON.parse(multi.out).map(s => s.id), ['H-2']);
  assert.match(run(['demo', 'H-']).out, /^- id: H-1\n/);
});

test('--list pads id to 8 and status to 12', () => {
  const r = run(['demo', 'H-10', '--list']);
  assert.equal(r.out, `${'H-10'.padEnd(8)} ${'verified'.padEnd(12)} tenth of many \n`);
});

test('multiline strings print as literal blocks', () => {
  assert.match(run(['demo', 'H-10']).out, /behaviour: \|-?\n {2}tenth\n {2}of many\n/);
});

test('--infra omits scenarios', () => {
  const r = run(['demo', '--infra']);
  assert.equal(r.out, 'epic: demo\nperimeter:\n  in:\n    - a\n  out:\n    - b\n');
});

test('no match exits 1 and lists the ids', () => {
  const r = run(['demo', 'Z']);
  assert.equal(r.code, 1);
  assert.equal(r.err, "no scenario matching 'Z'. Available ids: H-1, H-10, H-2\n");
});

test('a missing matrix exits 2', () => {
  assert.equal(run(['demo'], null).code, 2);
  assert.equal(run(['demo'], '- a\n- b\n').code, 2);
});

test('--json prints an array', () => {
  const r = run(['demo', 'H-2', '--json']);
  assert.deepEqual(JSON.parse(r.out), [{ id: 'H-2', behaviour: 'second', status: 'drift' }]);
  assert.equal(JSON.parse(run(['demo', '--json', '--list']).out).length, 3);
  assert.deepEqual(Object.keys(JSON.parse(run(['demo', '--infra', '--json']).out)), ['epic', 'perimeter']);
});
