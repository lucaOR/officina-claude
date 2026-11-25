import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout } from '../lib/layered.mjs';
import { stylesheet } from '../lib/style.mjs';
import { assertClean } from './geometry.mjs';

const n = (id, group, w = 100, h = 44) => ({ id, w, h, ...(group ? { group } : {}) });
const e = (from, to) => ({ from, to, label: null });
const PAD = 8;

// Groups are declared in this order, and every lookup below goes by id, never by position.
const flat = {
  nodes: [n('a', 'net'), n('b', 'net'), n('c', 'data'), n('d', 'data')],
  edges: [e('a', 'b'), e('b', 'c'), e('c', 'd')],
  groups: [{ id: 'net' }, { id: 'data' }, { id: 'cloud' }],
};
const boxOf = (r, id) => r.groupBoxes.find(b => b.id === id);
const within = (inner, outer, pad = 0) => inner.x >= outer.x + pad && inner.y >= outer.y + pad
  && inner.x + inner.w <= outer.x + outer.w - pad && inner.y + inner.h <= outer.y + outer.h - pad;
const clean = (g, r) => {
  const parentOf = new Map(g.groups.map(gr => [gr.id, gr.parent]));
  assertClean({
    width: r.width, height: r.height,
    boxes: [
      ...g.nodes.map(nd => ({ id: nd.id, ...r.nodes[nd.id], parent: nd.group })),
      ...r.groupBoxes.map(b => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, parent: parentOf.get(b.id) })),
    ],
  });
};

test('groups: a group box contains its children with padding', () => {
  const r = layout(flat);
  for (const nd of flat.nodes) assert.ok(within(r.nodes[nd.id], boxOf(r, nd.group), PAD), `${nd.id} is not inside ${nd.group} with padding`);
  assert.deepEqual(r.groupBoxes.map(b => b.id), ['net', 'data', 'cloud'], 'boxes come in declaration order');
});

test('groups: sibling groups do not overlap, and the whole layout is clean', () => {
  const r = layout(flat);
  const [p, q] = [boxOf(r, 'net'), boxOf(r, 'data')];
  assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y);
  clean(flat, r);
});

test('groups: an edge across groups still ends on the inner node', () => {
  const r = layout(flat);
  const nodeC = r.nodes.c;
  const end = r.edges[1].points.at(-1); // b > c
  assert.equal(end.x, nodeC.x, 'the edge reaches the left side of c');
  assert.ok(end.y >= nodeC.y && end.y <= nodeC.y + nodeC.h);
  const start = r.edges[1].points[0];
  assert.equal(start.x, r.nodes.b.x + r.nodes.b.w, 'and leaves from the right side of b');
  assert.ok(start.y >= r.nodes.b.y && start.y <= r.nodes.b.y + r.nodes.b.h);
  for (const edge of r.edges) for (const p of edge.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('groups: layout is deterministic', () => {
  assert.deepEqual(layout(flat), layout(flat));
});

// cloud > vpc > node, with a sibling group beside the vpc and a plain node outside everything.
const deep = {
  nodes: [n('lb', 'vpc'), n('app', 'vpc'), n('db', 'store'), n('user')],
  edges: [e('user', 'lb'), e('lb', 'app'), e('app', 'db')],
  groups: [{ id: 'cloud' }, { id: 'vpc', parent: 'cloud' }, { id: 'store', parent: 'cloud' }],
};

test('groups: three levels nest, contain and stay clean', () => {
  const r = layout(deep);
  const [cloud, vpc, store] = ['cloud', 'vpc', 'store'].map(id => boxOf(r, id));
  assert.equal(cloud.parent, undefined);
  assert.equal(vpc.parent, 'cloud');
  assert.ok(within(vpc, cloud, PAD) && within(store, cloud, PAD));
  assert.ok(within(r.nodes.lb, vpc, PAD) && within(r.nodes.app, vpc, PAD) && within(r.nodes.db, store, PAD));
  assert.ok(!within(r.nodes.user, cloud), 'the plain node stays outside');
  clean(deep, r);
});

test('groups: an edge into a nested node and one out of it end on the node, not on a group border', () => {
  const r = layout(deep);
  const into = r.edges[0].points.at(-1); // user > lb, two groups deep
  assert.equal(into.x, r.nodes.lb.x);
  assert.ok(into.y >= r.nodes.lb.y && into.y <= r.nodes.lb.y + r.nodes.lb.h);
  const out = r.edges[2].points; // app > db, across the vpc and store groups
  assert.equal(out[0].x, r.nodes.app.x + r.nodes.app.w);
  assert.equal(out.at(-1).x, r.nodes.db.x);
  assert.ok(out.at(-1).y >= r.nodes.db.y && out.at(-1).y <= r.nodes.db.y + r.nodes.db.h);
  assert.ok(out.length >= 2 && out.every((p, i) => !i || p.x === out[i - 1].x || p.y === out[i - 1].y), 'edges stay orthogonal');
});

test('groups: a top-to-bottom layout nests the same way', () => {
  const r = layout(deep, { dir: 'TB' });
  assert.ok(within(r.nodes.lb, boxOf(r, 'vpc'), PAD));
  const into = r.edges[0].points.at(-1);
  assert.equal(into.y, r.nodes.lb.y);
  assert.ok(into.x >= r.nodes.lb.x && into.x <= r.nodes.lb.x + r.nodes.lb.w);
  clean(deep, r);
});

test('groups: an edge inside one group is routed within it', () => {
  const r = layout(deep);
  const inner = r.edges[1].points; // lb > app, both in vpc
  const vpc = boxOf(r, 'vpc');
  assert.ok(inner.every(p => p.x >= vpc.x && p.x <= vpc.x + vpc.w && p.y >= vpc.y && p.y <= vpc.y + vpc.h));
});

test('groups: an empty group gets a defined box of the minimum size', () => {
  const r = layout(flat);
  const cloud = boxOf(r, 'cloud');
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(cloud[k]), `cloud.${k} is ${cloud[k]}`);
  assert.ok(cloud.w >= 60 + 2 * 14 && cloud.h >= 20 + 24 + 2 * 14, `empty group is ${cloud.w}x${cloud.h}`);
  assert.ok(cloud.x + cloud.w <= r.width && cloud.y + cloud.h <= r.height);
  const alone = layout({ nodes: [], edges: [], groups: [{ id: 'only' }] });
  assert.ok(Number.isFinite(alone.width) && alone.width > 0 && alone.height > 0);
});

test('groups: a minimum width keeps room for the label', () => {
  const r = layout({ nodes: [n('a', 'g')], edges: [], groups: [{ id: 'g', minW: 300 }] });
  assert.ok(boxOf(r, 'g').w >= 300);
});

test('groups: a self loop on a grouped node stays inside the group', () => {
  const g = { nodes: [n('a', 'g'), n('b', 'g')], edges: [e('a', 'b'), { from: 'a', to: 'a', label: { w: 30, h: 16 } }], groups: [{ id: 'g' }] };
  const r = layout(g);
  assert.ok(within(r.nodes.a, boxOf(r, 'g'), PAD));
  clean(g, r);
});

test('groups: lanes and groups work together', () => {
  const g = { lanes: ['x', 'y'], nodes: [{ ...n('a', 'g'), lane: 'x' }, { ...n('b', 'g'), lane: 'x' }, { ...n('c'), lane: 'y' }], edges: [e('a', 'b'), e('b', 'c')], groups: [{ id: 'g' }] };
  const r = layout(g);
  assert.equal(r.lanes.length, 2);
  assert.ok(within(r.nodes.a, boxOf(r, 'g'), PAD));
  assert.ok(within(boxOf(r, 'g'), r.lanes[0]), 'the group box lies inside its lane band');
});

test('groups: a group whose members sit in different lanes throws', () => {
  const g = { lanes: ['x', 'y'], nodes: [{ ...n('a', 'g'), lane: 'x' }, { ...n('b', 'g'), lane: 'y' }], edges: [], groups: [{ id: 'g' }] };
  assert.throws(() => layout(g), /group "g" spans lanes "x" and "y"/);
  const missing = { lanes: ['x', 'y'], nodes: [{ ...n('a', 'g'), lane: 'x' }, n('b', 'g')], edges: [], groups: [{ id: 'g' }] };
  assert.throws(() => layout(missing), /group "g" spans lanes "x" and "null"/);
});

// A segment crosses a box when it enters the box's interior.
const crosses = (p, q, b) => Math.max(p.x, q.x) > b.x + 0.5 && Math.min(p.x, q.x) < b.x + b.w - 0.5
  && Math.max(p.y, q.y) > b.y + 0.5 && Math.min(p.y, q.y) < b.y + b.h - 0.5;
// Every edge must stay out of the node boxes it does not end at.
const assertNoEdgeThroughNode = (g, r) => {
  g.edges.forEach((ed, i) => {
    const pts = r.edges[i].points;
    for (const nd of g.nodes) {
      if (nd.id === ed.from || nd.id === ed.to) continue;
      for (let k = 1; k < pts.length; k++) assert.ok(!crosses(pts[k - 1], pts[k], r.nodes[nd.id]), `edge ${i} crosses node ${nd.id}`);
    }
  });
};
const chainG = (label = null) => ({ nodes: [n('a', 'g'), n('b', 'g'), n('c', 'g'), n('x')], edges: [e('a', 'b'), e('b', 'c'), { from: 'x', to: 'c', label }], groups: [{ id: 'g' }] });

test('groups: an edge into a group does not run through a sibling of its target', () => {
  const g = chainG();
  const r = layout(g);
  assertNoEdgeThroughNode(g, r);
  const last = r.edges[2].points.at(-1);
  const c = r.nodes.c;
  assert.ok(last.x >= c.x - 0.01 && last.x <= c.x + c.w + 0.01 && last.y >= c.y - 0.01 && last.y <= c.y + c.h + 0.01, 'the edge still ends on c');
  clean(g, r);
});

test('groups: the same holds in a top-to-bottom layout', () => {
  const g = chainG();
  assertNoEdgeThroughNode(g, layout(g, { dir: 'TB' }));
});

test('groups: no edge crosses a node in the flat and deep fixtures', () => {
  assertNoEdgeThroughNode(flat, layout(flat));
  const deepG = {
    nodes: [n('a', 'l3'), n('b', 'l3'), n('c', 'l1'), n('x')],
    edges: [e('a', 'b'), e('b', 'c'), e('x', 'a')],
    groups: [{ id: 'l1' }, { id: 'l2', parent: 'l1' }, { id: 'l3', parent: 'l2' }],
  };
  assertNoEdgeThroughNode(deepG, layout(deepG));
});

test('groups: a labelled edge into a group keeps its label inside the canvas and clear of nodes', () => {
  const g = chainG({ w: 40, h: 16 });
  const r = layout(g);
  const l = r.edges[2].label;
  assert.ok(l && l.x >= 0 && l.y >= 0 && l.x + l.w <= r.width && l.y + l.h <= r.height, 'label inside the canvas');
  for (const nd of g.nodes) {
    const b = r.nodes[nd.id];
    assert.ok(l.x + l.w <= b.x || l.x >= b.x + b.w || l.y + l.h <= b.y || l.y >= b.y + b.h, `label overlaps ${nd.id}`);
  }
  assertNoEdgeThroughNode(g, r);
});

test('groups: bad references throw a layout error', () => {
  const ok = { nodes: [n('a', 'g')], edges: [], groups: [{ id: 'g' }] };
  assert.throws(() => layout({ ...ok, nodes: [n('a', 'nope')] }), /^Error: layout: node "a" is in unknown group "nope"/);
  assert.throws(() => layout({ ...ok, groups: [{ id: 'g', parent: 'nope' }] }), /unknown parent "nope"/);
  assert.throws(() => layout({ ...ok, groups: [{ id: 'g' }, { id: 'g' }] }), /duplicate group "g"/);
  assert.throws(() => layout({ ...ok, groups: [{ id: 'a' }], nodes: [n('a')] }), /group "a" has the id of a node/);
  assert.throws(() => layout({ ...ok, groups: [{ id: 'p', parent: 'q' }, { id: 'q', parent: 'p' }] }), /nest in a cycle/);
  assert.throws(() => layout({ ...ok, edges: [e('a', 'zzz')] }), /unknown node "zzz"/);
});

test('groups: the stylesheet styles groups, and nested ones differently, through theme variables', () => {
  const css = stylesheet('.x');
  assert.match(css, /\.x \.dg-group rect\{[^}]*fill:var\(--dg-lane\)[^}]*stroke:var\(--dg-rule\)/);
  assert.match(css, /\.x \.dg-group text\{[^}]*fill:var\(--dg-muted\)/);
  assert.match(css, /\.x \.dg-group\.dg-group-nested rect\{[^}]*var\(--dg-panel\)/);
});
