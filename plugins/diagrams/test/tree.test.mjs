import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, TYPES } from '../lib/index.mjs';
import { assertClean } from './geometry.mjs';

const rows = [['ceo', 'CEO', 'focus'], ['cto', 'CTO'], ['cfo', 'CFO'], ['dev', 'Dev'], ['ceo > cto'], ['ceo > cfo'], ['cto > dev']];
const bad = r => () => render({ type: 'tree', title: 't', rows: r });

test('tree: children sit below their parent', () => {
  const r = render({ type: 'tree', title: 'Org', rows });
  const y = id => r.boxes.find(b => b.id === id).y;
  assert.ok(y('cto') > y('ceo') && y('dev') > y('cto'));
  assertClean(r);
  assert.deepEqual(r.nodes, ['ceo', 'cto', 'cfo', 'dev']);
  assert.equal(render({ type: 'tree', title: 'Org', rows }).svg, r.svg);
});
test('tree: edges have no arrowheads', () => {
  const { svg } = render({ type: 'tree', title: 'Org', rows });
  assert.equal((svg.match(/class="dg-tree-edge"/g) || []).length, 3);
  assert.doesNotMatch(svg.replace(/<defs>.*<\/defs>/, ''), /marker-end/);
});
test('tree: a forest of two roots renders cleanly', () => {
  assertClean(render({ type: 'tree', title: 'f', rows: [['a', 'A'], ['b', 'B'], ['c', 'C'], ['a > c']] }));
});
test('tree: the stylesheet styles the edge class', () => {
  const { css } = render({ type: 'tree', title: 'Org', rows });
  assert.match(css, /\.dg-tree-edge[^{]*\{[^}]*fill:none[^}]*stroke:var\(--dg-line\)/);
});
test('tree: labels are escaped', () => {
  const { svg } = render({ type: 'tree', title: 't', rows: [['a', '<b>&']] });
  assert.doesNotMatch(svg, /<b>/);
});
test('tree: is registered after state', () => assert.deepEqual(TYPES.slice(0, 5), ['sequence', 'workflow', 'erd', 'state', 'tree']));
test('tree: a second parent is rejected', () => assert.throws(bad([...rows, ['cfo > dev']]), /^Error: Row 8: dev already has a parent/));
test('tree: a cycle is rejected', () => assert.throws(bad([['a', 'A'], ['b', 'B'], ['a > b'], ['b > a']]), /^Error: Row 4: .*cycle/));
test('tree: a self edge is a cycle', () => assert.throws(bad([['a', 'A'], ['a > a']]), /^Error: Row 2: .*cycle/));
test('tree: an unknown node names the row', () => assert.throws(bad([['a', 'A'], ['a > z']]), /^Error: Row 2: unknown node "z"/));
test('tree: a tree needs a node', () => assert.throws(bad([['a > b']]), /at least one node/));
