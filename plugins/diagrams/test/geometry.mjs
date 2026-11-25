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
