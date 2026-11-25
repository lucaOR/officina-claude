// Shared geometry check: boxes must stay on the canvas and must not overlap, except that a node
// may sit inside any of its ancestor containers (the whole `parent` chain, not only the direct one).
import assert from 'node:assert/strict';

export function assertClean({ boxes, width, height }) {
  const byId = new Map(boxes.map(b => [b.id, b]));
  const ancestors = b => {
    const out = new Set();
    for (let p = b.parent; p !== undefined && !out.has(p); p = byId.get(p)?.parent) out.add(p);
    return out;
  };
  for (const b of boxes) {
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= width && b.y + b.h <= height,
      `box ${b.id} is outside the ${width}x${height} canvas`);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (ancestors(a).has(b.id) || ancestors(b).has(a.id)) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `boxes ${a.id} and ${b.id} overlap`);
    }
  }
}

// A segment crosses a box when it enters the box's interior.
export const crosses = (p, q, b) => Math.max(p.x, q.x) > b.x + 0.5 && Math.min(p.x, q.x) < b.x + b.w - 0.5
  && Math.max(p.y, q.y) > b.y + 0.5 && Math.min(p.y, q.y) < b.y + b.h - 0.5;
// A point lies on the border of a box when it touches one side within the span of that side.
export const onBorder = (p, b) => ((Math.abs(p.x - b.x) < 0.6 || Math.abs(p.x - b.x - b.w) < 0.6) && p.y >= b.y - 0.6 && p.y <= b.y + b.h + 0.6)
  || ((Math.abs(p.y - b.y) < 0.6 || Math.abs(p.y - b.y - b.h) < 0.6) && p.x >= b.x - 0.6 && p.x <= b.x + b.w + 0.6);
// Layout form: every edge of graph g stays out of the nodes it does not end at.
export const assertNoEdgeThroughNode = (g, r) => {
  g.edges.forEach((ed, i) => {
    const pts = r.edges[i].points;
    for (const nd of g.nodes) {
      if (nd.id === ed.from || nd.id === ed.to) continue;
      for (let k = 1; k < pts.length; k++) assert.ok(!crosses(pts[k - 1], pts[k], r.nodes[nd.id]), `edge ${i} crosses node ${nd.id}`);
    }
  });
};
// Render form: the same check on the drawn paths of a spec, in row order of its "a > b" rows.
export const assertRenderedNoThrough = (spec, r) => {
  const paths = [...r.svg.matchAll(/<path class="dg-edge[^"]*" d="([^"]+)"/g)].map(m => m[1]);
  const links = spec.rows.filter(x => x[0].includes('>')).map(x => x[0].split('>').map(t => t.trim()));
  assert.equal(paths.length, links.length);
  paths.forEach((d, i) => {
    const pts = [...d.matchAll(/[MLQ]\s*(-?[\d.]+) (-?[\d.]+)/g)].map(m => ({ x: +m[1], y: +m[2] }));
    const [from, to] = links[i];
    for (const b of r.boxes) {
      if (b.id === from || b.id === to || !r.nodes.includes(b.id)) continue;
      pts.slice(1).forEach((q, k) => assert.ok(!crosses(pts[k], q, b), `${from} > ${to} crosses ${b.id}`));
    }
  });
};
