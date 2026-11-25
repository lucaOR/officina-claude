import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, TYPES } from '../lib/index.mjs';
import { assertClean, assertRenderedNoThrough } from './geometry.mjs';

const spec = { type: 'architecture', title: 'App', rows: [['group vpc', 'VPC'], ['group priv', 'Private subnet', 'vpc'], ['web', 'Web', 'frontend', 'vpc'], ['api', 'API', 'backend', 'priv'], ['db', 'DB', 'database', 'priv'], ['web > api', 'HTTPS'], ['api > db']] };
const bad = rows => () => render({ type: 'architecture', title: 't', rows });
const inside = (a, b) => a.x > b.x && a.y > b.y && a.x + a.w < b.x + b.w && a.y + a.h < b.y + b.h;

test('architecture: a nested group sits inside its parent', () => {
  const r = render(spec);
  const box = id => r.boxes.find(b => b.id === id);
  const inner = box('priv'), outer = box('vpc');
  assert.equal(inner.parent, 'vpc');
  assert.equal(outer.parent, undefined);
  assert.ok(inner.x > outer.x && inner.x + inner.w < outer.x + outer.w);
  assert.equal(box('api').parent, 'priv');
  assert.ok(inside(box('api'), inner) && inside(box('web'), outer));
  assertClean(r);
  assert.deepEqual(r.nodes, ['web', 'api', 'db']);
});
test('architecture: is registered last and deterministic', () => {
  assert.deepEqual(TYPES, ['sequence', 'workflow', 'erd', 'state', 'tree', 'timeline', 'architecture']);
  assert.equal(render(spec).svg, render(spec).svg);
});
test('architecture: three levels with a cross-group edge stay clean and end on the inner node', () => {
  const rows = [['group cloud', 'Cloud'], ['group vpc', 'VPC', 'cloud'], ['group priv', 'Private subnet', 'vpc'], ['user', 'User', 'external'], ['api', 'API', 'backend', 'priv'], ['cache', 'Cache', 'database', 'vpc'], ['user > api', 'calls'], ['api > cache']];
  const r = render({ type: 'architecture', title: 't', rows });
  assertClean(r);
  const box = id => r.boxes.find(b => b.id === id);
  assert.ok(inside(box('api'), box('priv')) && inside(box('priv'), box('vpc')) && inside(box('vpc'), box('cloud')));
  const d = [...r.svg.matchAll(/<path class="dg-edge[^"]*" d="([^"]+)"/g)][0][1];
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  const [ex, ey] = nums.slice(-2);
  const a = box('api');
  assert.ok(ex >= a.x - 0.01 && ex <= a.x + a.w + 0.01 && ey >= a.y - 0.01 && ey <= a.y + a.h + 0.01, 'the edge ends on api');
});
test('architecture: groups are drawn with a frame, label and parent-first order', () => {
  const { svg } = render(spec);
  assert.ok(svg.indexOf('data-group-id="vpc"') < svg.indexOf('data-group-id="priv"'));
  assert.match(svg, />Private subnet<\/text>/);
  assert.match(svg, /class="dg-group dg-group-nested"/);
});
test('architecture: the stylesheet draws groups dashed through theme variables', () => {
  const { css } = render(spec, { scope: '.x' });
  assert.match(css, /\.x \.dg-architecture \.dg-group rect\{[^}]*stroke:var\(--dg-line\)[^}]*stroke-dasharray:5 4/);
  assert.match(css, /\.x \.dg-group\.dg-group-nested rect\{/);
  assert.match(css, /\.x \.dg-group text\{[^}]*fill:var\(--dg-muted\)/);
});
test('architecture: labels, group labels and edge labels are escaped', () => {
  const { svg } = render({ type: 'architecture', title: 't', rows: [['group g', 'G <&> "q"'], ['a', '<b>&', 'backend', 'g'], ['c', 'C'], ['a > c', '<e>&']] });
  assert.match(svg, /G &lt;&amp;&gt; &quot;q&quot;|G &lt;&amp;&gt; "q"/);
  assert.match(svg, /&lt;b&gt;&amp;/);
  assert.match(svg, /&lt;e&gt;&amp;/);
  assert.doesNotMatch(svg, /<b>|<e>/);
});
test('architecture: a forward reference to a group is legal', () => {
  const r = render({ type: 'architecture', title: 't', rows: [['group a', 'A', 'b'], ['group b', 'B'], ['x', 'X', 'backend', 'a']] });
  assert.equal(r.boxes.find(b => b.id === 'a').parent, 'b');
  assertClean(r);
});
test('architecture: a group with an unknown parent names the row', () => assert.throws(bad([['group a', 'A', 'nope']]), /^Error: Row 1: unknown group "nope"/));
test('architecture: a group cannot be its own ancestor', () => {
  assert.throws(bad([['group a', 'A', 'b'], ['group b', 'B', 'a']]), /^Error: Row 2: .*cycle/);
  assert.throws(bad([['group a', 'A', 'a']]), /^Error: Row 1: .*cycle/);
});
test('architecture: a component in an unknown group names the row', () => assert.throws(bad([['a', 'A', 'backend', 'nope']]), /^Error: Row 1: unknown group "nope"/));
test('architecture: duplicate ids are rejected', () => {
  assert.throws(bad([['a', 'A'], ['a', 'B']]), /^Error: Row 2: .*"a" is declared twice/);
  assert.throws(bad([['group g', 'G'], ['group g', 'H']]), /^Error: Row 2: .*"g" is declared twice/);
});
test('architecture: a component id cannot clash with a group id', () => {
  assert.throws(bad([['group g', 'G'], ['g', 'X']]), /^Error: Row 2: .*"g".*group/);
  assert.throws(bad([['g', 'X'], ['group g', 'G']]), /^Error: Row 1: .*"g".*group/);
});
test('architecture: bad cell counts are rejected', () => {
  assert.throws(bad([['group g']]), /^Error: Row 1: a group row needs at least 2 cells/);
  assert.throws(bad([['group g', 'G', 'p', 'x']]), /^Error: Row 1: a group row has at most 3 cells/);
  assert.throws(bad([['a']]), /^Error: Row 1: a component row needs at least 2 cells/);
  assert.throws(bad([['a', 'A', 'backend', 'g', 'x']]), /^Error: Row 1: a component row has at most 4 cells/);
  assert.throws(bad([['a', 'A'], ['a > a', '', 'dashed', 'x']]), /^Error: Row 2: a connection row has at most 3 cells/);
});
test('architecture: an edge naming an unknown node names the row', () => assert.throws(bad([['a', 'A'], ['a > z']]), /^Error: Row 2: unknown node "z"/));
test('architecture: an edge cannot name a group', () => assert.throws(bad([['group g', 'G'], ['a', 'A'], ['a > g']]), /^Error: Row 3: unknown node "g"/));
test('architecture: bad type, bad id and a missing component are rejected', () => {
  assert.throws(bad([['a', 'A', 'nope']]), /^Error: Row 1: type "nope"/);
  assert.throws(bad([['group 1x', 'G']]), /^Error: Row 1: id "1x"/);
  assert.throws(bad([['group g', 'G']]), /at least one component/);
});

test('architecture: an edge into a group does not run through a node beside its target', () => {
  const s = { type: 'architecture', title: 'T', rows: [['group cloud', 'Cloud'], ['group vpc', 'VPC', 'cloud'], ['group edge', 'Edge'], ['web', 'Web', 'frontend', 'vpc'], ['api', 'API', 'backend', 'vpc'], ['cdn', 'CDN', 'cloud', 'edge'], ['db', 'DB', 'database', 'cloud'], ['web > api'], ['web > cdn'], ['cdn > db']] };
  assertRenderedNoThrough(s, render(s));
});
