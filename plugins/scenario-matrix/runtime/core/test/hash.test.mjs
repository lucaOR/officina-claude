import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { compiledFrom, canonical } from '../hash.mjs';

const row = {
  id: 'B-06', behaviour: 'dup tie-break', reach: 'browser',
  env: { region: 'north', app: 'web' },
  setup: [{ seed: { target: 'accounts', rows: 2 } }],
  expected: 'second row skipped', status: 'verified', last_run: '2026-07-21 OK',
};

test('the hash ignores fields that are not behavioural', () => {
  const a = compiledFrom(row);
  const b = compiledFrom({ ...row, status: 'drift', last_run: '2026-07-29 KO', bug_ref: 'BUG-1' });
  assert.equal(a, b);
});

test('the hash changes when expected changes', () => {
  assert.notEqual(compiledFrom(row), compiledFrom({ ...row, expected: 'second row imported' }));
});

test('canonical output is key-order independent', () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

const CLI = join(import.meta.dirname, '..', 'hash.mjs');
const FIXTURES = join(import.meta.dirname, 'fixtures');
const run = args => execFileSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', stdio: 'pipe', env: { ...process.env, SCN_MATRIX_DIR: FIXTURES },
});

test('the CLI prints the hash of a fixture row', () => {
  assert.equal(run(['neutral-registry', 'A-01']).trim(), '04863aac6839');
});

test('the CLI exits 2 and names the problem on a missing argument', () => {
  try {
    run(['neutral-registry']);
    assert.fail('expected a non-zero exit');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /usage: hash\.mjs <epic> <id>/);
  }
});

test('the CLI exits 2 on an id that is not in the matrix', () => {
  try {
    run(['neutral-registry', 'ZZ-99']);
    assert.fail('expected a non-zero exit');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /ZZ-99/);
  }
});
