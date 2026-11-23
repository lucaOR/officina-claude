import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPyYamlParity, parseMatrixText, readMatrix } from '../matrix.mjs';
import { Blocked } from '../errors.mjs';

test('matrix parse matches PyYAML on YAML 1.1 scalars', () => {
  const src = 'a: y\nb: n\nc: on\nd: 0777\ne: 1:20\nf: 0x1f\ng: 1_000\nh: .5\ni: ~\nj: Off\nk: 0b101\n'
    + 'l: 190:20:30.15\nm: NO\nbase: &b {x: 1}\nmerged: {<<: *b, y: 2}\ndup: 1\ndup: 2\n';
  // PyYAML 6.0.1 safe_load, 2026-11-20
  assert.deepEqual(parseMatrixText(src), { a: 'y', b: 'n', c: true, d: 511, e: 80, f: 31, g: 1000, h: 0.5,
    i: null, j: false, k: 5, l: 685230.15, m: false, base: { x: 1 }, merged: { x: 1, y: 2 }, dup: 2 });
});
test('y and n stay strings as mapping keys', () =>
  assert.deepEqual(parseMatrixText('y: 1\nn: 2\n'), { y: 1, n: 2 }));
test('an unquoted date fails naming its path', () =>
  assert.throws(() => parseMatrixText('scenarios:\n  - id: A\n    verified: 2026-11-20\n'),
    e => e instanceof Blocked && /scenarios\[0\]\.verified/.test(e.message)));
test('ids that look like exponents stay strings, as in PyYAML', () =>
  assert.deepEqual(parseMatrixText('a: E-01\nb: 92e487916021\nc: 1.5e+3\nd: 1e3\n'),
    { a: 'E-01', b: '92e487916021', c: 1500, d: '1e3' }));
test('a missing file is Blocked', () =>
  assert.throws(() => readMatrix('/nonexistent/x.yaml'), e => e instanceof Blocked && /matrix not found/.test(e.message)));

// matrix.mjs checks itself at import with a known input, because it depends on yaml 2.9.1 internals
// and a project's own older or newer yaml pin could silently change every compiled_from hash.
test('the PyYAML parity self-check passes with the installed yaml', () => assert.doesNotThrow(() => assertPyYamlParity()));
test('the PyYAML parity self-check is Blocked when a parser reads an id differently', () => {
  assert.throws(() => assertPyYamlParity(() => ({ a: 'E-01', b: true })),
    e => e instanceof Blocked && /yaml/.test(e.message) && /2\.9\.1/.test(e.message));
  assert.throws(() => assertPyYamlParity(() => ({ a: Number.NaN, b: 'y' })), Blocked);
  assert.throws(() => assertPyYamlParity(() => { throw new Error('parser broke'); }), e => e instanceof Blocked && /parser broke/.test(e.message));
});
