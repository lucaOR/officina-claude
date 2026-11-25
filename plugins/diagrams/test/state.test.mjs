import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, TYPES } from '../lib/index.mjs';
import { assertClean } from './geometry.mjs';

const spec = { type: 'state', title: 'Order', rows: [['initial s0'], ['new', 'New'], ['paid', 'Paid', 'backend'], ['done', 'Shipped'], ['final f0'], ['s0 > new'], ['new > paid', 'pay'], ['paid > paid', 'retry', 'dashed'], ['paid > done', 'ship'], ['done > f0']] };
const bad = rows => () => render({ type: 'state', title: 't', rows });

test('state: markers are drawn as a dot and a double ring', () => {
  const { svg } = render(spec);
  assert.match(svg, /class="dg-initial"/);
  assert.match(svg, /class="dg-final"/);
});
test('state: layout is clean and deterministic', () => {
  const r = render(spec);
  assertClean(r);
  assert.deepEqual(r.nodes, ['s0', 'new', 'paid', 'done', 'f0']);
  assert.ok(r.boxes.some(b => b.id === 's0') && r.boxes.some(b => b.id === 'f0'));
  assert.equal(render(spec).svg, r.svg);
});
test('state: a self-loop is drawn as a path with its label', () => {
  const { svg } = render(spec);
  assert.equal((svg.match(/class="dg-edge /g) || []).length, 5);
  assert.match(svg, /retry/);
});
test('state: is registered after erd', () => assert.deepEqual(TYPES.slice(0, 4), ['sequence', 'workflow', 'erd', 'state']));
test('state: a transition to an unknown state names the row', () => assert.throws(bad([['a', 'A'], ['a > b']]), /^Error: Row 2: unknown state "b"/));
test('state: bad rows name the row', () => {
  assert.throws(bad([['a', 'A'], ['a', 'B']]), /^Error: Row 2: state "a" is declared twice/);
  assert.throws(bad([['a', 'A'], ['final f'], ['f > a']]), /^Error: Row 3: final marker "f" cannot/);
  assert.throws(bad([['a', 'A'], ['initial i'], ['a > i']]), /^Error: Row 3: initial marker "i" cannot/);
  assert.throws(bad([['a']]), /^Error: Row 1: a state row needs at least 2 cells/);
  assert.throws(bad([['initial i']]), /a state diagram needs at least one state/);
});
