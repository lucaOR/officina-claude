import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layout } from '../lib/layered.mjs';

const box = (id, lane, w = 100, h = 44) => ({ id, w, h, lane });
const edge = (from, to, label = null) => ({ from, to, label });
// A string label stands for a label box sized like 7px per character by 16px.
const sized = l => (typeof l === 'string' ? { w: l.length * 7 + 8, h: 16 } : l);
const graph = (ids, pairs, extra = {}) => ({ nodes: ids.map(id => box(id)), edges: pairs.map(([a, b, l]) => edge(a, b, sized(l))), ...extra });

const inside = (p, r, eps = 0.01) => p.x > r.x + eps && p.x < r.x + r.w - eps && p.y > r.y + eps && p.y < r.y + r.h - eps;
const onBorder = (p, r) => {
  const inX = p.x >= r.x - 0.01 && p.x <= r.x + r.w + 0.01;
  const inY = p.y >= r.y - 0.01 && p.y <= r.y + r.h + 0.01;
  return (inY && (Math.abs(p.x - r.x) < 0.01 || Math.abs(p.x - r.x - r.w) < 0.01))
    || (inX && (Math.abs(p.y - r.y) < 0.01 || Math.abs(p.y - r.y - r.h) < 0.01));
};
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// A segment passes through a rectangle's interior when any sampled point is inside it.
function crossesRect(a, b, r) {
  for (let t = 0.02; t < 1; t += 0.02) if (inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, r, 0.5)) return true;
  return false;
}

function checkInvariants(g, out) {
  const rects = Object.entries(out.nodes);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(rects[i][1], rects[j][1]), `${rects[i][0]} overlaps ${rects[j][0]}`);
  }
  for (const [id, r] of rects) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= out.width && r.y + r.h <= out.height, `${id} is outside the canvas`);
  }
  out.edges.forEach((e, i) => {
    const { from, to } = g.edges[i];
    const pts = e.points;
    assert.ok(pts.length >= 2);
    assert.ok(onBorder(pts[0], out.nodes[from]), `edge ${from}>${to} does not start on ${from}`);
    assert.ok(onBorder(pts.at(-1), out.nodes[to]), `edge ${from}>${to} does not end on ${to}`);
    for (let k = 1; k < pts.length; k++) {
      const [a, b] = [pts[k - 1], pts[k]];
      assert.ok(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, `edge ${from}>${to} has a diagonal segment`);
      for (const [id, r] of rects) assert.ok(!crossesRect(a, b, r), `edge ${from}>${to} passes through ${id}`);
    }
    if (e.label) for (const [id, r] of rects) assert.ok(!overlap(e.label, r), `label of ${from}>${to} covers ${id}`);
  });
}

test('a chain runs left to right on one straight line', () => {
  const g = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
  const out = layout(g);
  checkInvariants(g, out);
  const { a, b, c } = out.nodes;
  assert.ok(a.x < b.x && b.x < c.x);
  assert.equal(a.y, b.y);
  assert.equal(b.y, c.y);
  assert.equal(out.edges[0].points.length, 2);
});

test('top-to-bottom puts later ranks lower', () => {
  const g = graph(['a', 'b'], [['a', 'b']]);
  const out = layout(g, { dir: 'TB' });
  checkInvariants(g, out);
  assert.ok(out.nodes.a.y + out.nodes.a.h <= out.nodes.b.y);
  assert.equal(out.nodes.a.x, out.nodes.b.x);
});

test('a fan-out of nine fits without overlaps', () => {
  const ids = ['hub', ...Array.from({ length: 9 }, (_, i) => `n${i}`)];
  const g = graph(ids, ids.slice(1).map(id => ['hub', id, 'go']));
  checkInvariants(g, layout(g));
});

test('a cycle spreads over ranks and its back edge still joins the nodes', () => {
  const g = graph(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a', 'retry']]);
  const out = layout(g);
  checkInvariants(g, out);
  const xs = new Set(Object.values(out.nodes).map(r => r.x));
  assert.equal(xs.size, 3);
  assert.equal(out.edges[2].reversed, true);
});

test('a long edge goes around the nodes it skips', () => {
  const g = graph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'd', 'skip']]);
  checkInvariants(g, layout(g));
});

test('ordering removes an avoidable crossing', () => {
  // Declared order puts d above c, so drawing in declared order would cross a>c and b>d.
  const g = graph(['a', 'b', 'd', 'c'], [['a', 'c'], ['b', 'd']]);
  const out = layout(g);
  checkInvariants(g, out);
  assert.equal(out.nodes.a.y < out.nodes.b.y, out.nodes.c.y < out.nodes.d.y);
});

test('a branch and merge keeps every edge clear of the nodes', () => {
  const g = graph(['s', 'q', 'y', 'n', 'end'], [['s', 'q'], ['q', 'y', 'yes'], ['q', 'n', 'no'], ['y', 'end'], ['n', 'end']]);
  checkInvariants(g, layout(g));
});

test('lanes are stacked bands in declared order and hold their nodes', () => {
  const g = {
    nodes: [box('build', 'prep'), box('test', 'prep'), box('deploy', 'ship'), box('verify', 'ship')],
    edges: [edge('build', 'test'), edge('test', 'deploy', { w: 40, h: 16 }), edge('deploy', 'verify')],
    lanes: ['prep', 'ship'],
  };
  const out = layout(g);
  checkInvariants(g, out);
  const [prep, ship] = out.lanes;
  assert.equal(prep.id, 'prep');
  assert.ok(prep.y + prep.h <= ship.y);
  for (const id of ['build', 'test']) assert.ok(out.nodes[id].y >= prep.y && out.nodes[id].y + out.nodes[id].h <= prep.y + prep.h);
  for (const id of ['deploy', 'verify']) assert.ok(out.nodes[id].y >= ship.y && out.nodes[id].y + out.nodes[id].h <= ship.y + ship.h);
});

test('a fixed port sets where the edge meets the node', () => {
  const g = { nodes: [box('a', null, 100, 100), box('b', null, 100, 100)], edges: [{ from: 'a', to: 'b', fromPort: 70, toPort: 30 }] };
  const out = layout(g);
  checkInvariants(g, out);
  assert.equal(out.edges[0].points[0].y, out.nodes.a.y + 70);
  assert.equal(out.edges[0].points.at(-1).y, out.nodes.b.y + 30);
});

test('a label gets room in the gap before its target', () => {
  const g = graph(['a', 'b'], [['a', 'b', { w: 120, h: 16 }]]);
  const out = layout(g);
  checkInvariants(g, out);
  assert.ok(out.nodes.b.x - (out.nodes.a.x + out.nodes.a.w) >= 120);
});

test('layout is deterministic', () => {
  const g = graph(['s', 'q', 'y', 'n', 'end'], [['s', 'q'], ['q', 'y'], ['q', 'n'], ['y', 'end'], ['n', 'end'], ['end', 's']]);
  assert.deepEqual(layout(g), layout(g));
});

test('a self loop takes the free incoming side, clear of the outgoing edges', () => {
  const g = { nodes: [box('cat', null, 120, 90), box('q')], edges: [{ from: 'cat', to: 'q', fromPort: 20 }, { from: 'cat', to: 'cat', fromPort: 20, toPort: 60, label: { w: 50, h: 16 } }] };
  const out = layout(g);
  checkInvariants(g, out);
  const loop = out.edges[1].points;
  assert.ok(loop.every(p => p.x <= out.nodes.cat.x), 'the loop is not on the left side');
  assert.ok(out.edges[1].label.x + out.edges[1].label.w <= out.nodes.cat.x);
});

// Recorded before nested groups were added: a graph without groups must lay out exactly as before.
test('layout without groups matches the recorded plain layouts', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/layered-plain.json', import.meta.url), 'utf8'));
  assert.ok(cases.length >= 4);
  for (const c of cases) assert.deepEqual(JSON.parse(JSON.stringify(layout(c.graph, c.options))), c.out, c.name);
  for (const c of cases) assert.equal(layout(c.graph, c.options).groupBoxes, undefined, `${c.name} grows no groupBoxes`);
});
