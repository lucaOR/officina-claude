// Layered layout for small directed graphs, after the Sugiyama method:
//   1. break cycles by reversing the edges a depth-first search finds going back,
//   2. rank nodes by longest path, then pull each source next to its nearest successor,
//   3. add one dummy node per rank that a long edge crosses,
//   4. order each rank with barycenter sweeps, keeping the order with the fewest crossings,
//   5. place nodes across the ranks by averaging their neighbours, packed without overlap,
//   6. route every edge orthogonally, turning on a track in the gap between two ranks.
// The ideas follow dagre and d3-dag (both MIT); no code is taken from them.
//
// The layout works on two axes: the rank axis, along which edges flow, and the order axis
// across it. 'LR' maps rank to x and order to y; 'TB' maps rank to y and order to x.
// Lanes are bands along the rank axis that each hold their own nodes.
// Groups nest: each is laid out on its own, then stands as one node in its parent's layout (see layout()).

const DEFAULTS = {
  dir: 'LR',
  nodeGap: 24, // between two nodes of a rank
  dummyGap: 10, // between two long edges passing through a rank
  stub: 14, // straight run out of a node before an edge may turn
  trackGap: 10, // between two parallel turning tracks in a gap
  labelPad: 6,
  minGap: 44, // smallest gap between two ranks
  laneHeader: 26,
  lanePad: 14,
  laneGap: 10,
  margin: 12,
  portGap: 10, // between spread ports on one side
  sharePorts: true, // forward edges on one side leave or arrive at one shared port
  loop: 18, // how far a self loop reaches out
  sweeps: 8,
  groupPad: 14, // between a group's border and what it holds
  groupHeader: 24, // room for a group's label above its content
  groupMin: { w: 60, h: 20 }, // smallest content area, so an empty group still has a body
};

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const range = (from, to) => (from <= to ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : Array.from({ length: from - to + 1 }, (_, i) => from - i));

// Positions closest to `desired` (weighted least squares) that keep each pair at least
// `gaps[i]` apart, in order: isotonic regression by pool-adjacent-violators on the
// gap-shifted targets. A light weight lets that position give way to heavier ones.
function pack(desired, gaps, weights) {
  const offset = [0];
  for (let i = 1; i < desired.length; i++) offset[i] = offset[i - 1] + gaps[i - 1];
  const blocks = [];
  const level = b => b.sum / b.weight;
  desired.forEach((d, i) => {
    blocks.push({ sum: (d - offset[i]) * weights[i], weight: weights[i], n: 1 });
    while (blocks.length > 1 && level(blocks.at(-2)) > level(blocks.at(-1))) {
      const last = blocks.pop();
      blocks.at(-1).sum += last.sum;
      blocks.at(-1).weight += last.weight;
      blocks.at(-1).n += last.n;
    }
  });
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(level(b) + offset[out.length]);
  return out;
}

const DUMMY_WEIGHT = 0.25;
const weight = v => (v.real ? 1 : DUMMY_WEIGHT);
const overlaps = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

function layoutFlat(g, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const LR = o.dir !== 'TB';
  const hasLanes = !!g.lanes?.length;
  const laneIds = hasLanes ? g.lanes : [null];
  const laneOf = id => Math.max(0, laneIds.indexOf(id ?? null));

  // ---- vertices and edges ----------------------------------------------------------------------
  const V = g.nodes.map((n, idx) => ({
    id: n.id, idx, real: true, rs: LR ? n.w : n.h, os: LR ? n.h : n.w, w: n.w, h: n.h,
    lane: laneOf(n.lane), rank: 0, pos: 0, c: 0, ins: [], outs: [],
  }));
  const byId = new Map(V.map(v => [v.id, v]));
  const E = g.edges.map((e, i) => ({
    i, u: byId.get(e.from), v: byId.get(e.to), label: e.label || null,
    fromPort: e.fromPort, toPort: e.toPort, rev: false, self: e.from === e.to,
  }));
  const L = E.filter(e => !e.self);

  // 1. cycles
  const state = new Map();
  const dfs = v => {
    state.set(v, 1);
    for (const e of L) {
      if (e.u !== v) continue;
      if (state.get(e.v) === 1) e.rev = true;
      else if (!state.get(e.v)) dfs(e.v);
    }
    state.set(v, 2);
  };
  for (const v of V) if (!state.get(v)) dfs(v);
  for (const e of L) [e.a, e.b] = e.rev ? [e.v, e.u] : [e.u, e.v];

  // 2. ranks
  const indegree = new Map(V.map(v => [v, 0]));
  for (const e of L) indegree.set(e.b, indegree.get(e.b) + 1);
  const topo = [];
  const ready = V.filter(v => !indegree.get(v));
  while (ready.length) {
    const v = ready.shift();
    topo.push(v);
    for (const e of L) {
      if (e.a !== v) continue;
      indegree.set(e.b, indegree.get(e.b) - 1);
      if (!indegree.get(e.b)) { ready.push(e.b); ready.sort((x, y) => x.idx - y.idx); }
    }
  }
  for (const v of topo) for (const e of L) if (e.a === v) e.b.rank = Math.max(e.b.rank, v.rank + 1);
  for (const v of [...topo].reverse()) {
    const outs = L.filter(e => e.a === v);
    if (outs.length && !L.some(e => e.b === v)) v.rank = Math.min(...outs.map(e => e.b.rank)) - 1;
  }
  const used = [...new Set(V.map(v => v.rank))].sort((x, y) => x - y);
  for (const v of V) v.rank = used.indexOf(v.rank);
  const maxRank = used.length - 1;

  // 3. dummies
  for (const e of L) {
    e.chain = [e.a];
    for (let r = e.a.rank + 1; r < e.b.rank; r++) {
      const d = { id: null, real: false, rs: 0, os: 0, lane: e.a.lane, rank: r, pos: 0, c: 0, ins: [], outs: [] };
      V.push(d);
      e.chain.push(d);
    }
    e.chain.push(e.b);
    e.hops = e.chain.slice(1).map((b, k) => ({ e, a: e.chain[k], b, last: k === e.chain.length - 2 }));
    for (const h of e.hops) { h.a.outs.push(h); h.b.ins.push(h); }
  }

  // 4. order
  let ranks = Array.from({ length: maxRank + 1 }, () => []);
  const seen = new Set();
  const visit = v => {
    if (seen.has(v)) return;
    seen.add(v);
    ranks[v.rank].push(v);
    for (const h of v.outs) visit(h.b);
  };
  for (const v of V.filter(v => v.real).sort((x, y) => x.rank - y.rank || x.idx - y.idx)) visit(v);
  const settle = () => ranks.forEach(rank => rank.forEach((v, i) => { v.pos = i; }));
  const sortRank = (rank, key) => rank.sort((x, y) => x.lane - y.lane || key(x) - key(y) || x.pos - y.pos);
  ranks.forEach(rank => { settle(); sortRank(rank, () => 0); });
  settle();
  const crossings = () => {
    let n = 0;
    for (const rank of ranks) {
      const hops = rank.flatMap(v => v.outs);
      for (let i = 0; i < hops.length; i++) {
        for (let j = i + 1; j < hops.length; j++) if ((hops[i].a.pos - hops[j].a.pos) * (hops[i].b.pos - hops[j].b.pos) < 0) n++;
      }
    }
    return n;
  };
  let best = crossings();
  let bestRanks = ranks.map(rank => [...rank]);
  for (let it = 0; it < o.sweeps && best > 0; it++) {
    const down = it % 2 === 0;
    for (const r of down ? range(1, maxRank) : range(maxRank - 1, 0)) {
      if (r < 0 || r > maxRank) continue;
      const bary = new Map(ranks[r].map(v => {
        const nb = down ? v.ins.map(h => h.a) : v.outs.map(h => h.b);
        return [v, nb.length ? mean(nb.map(n => n.pos)) : v.pos];
      }));
      sortRank(ranks[r], v => bary.get(v));
      ranks[r].forEach((v, i) => { v.pos = i; });
    }
    const n = crossings();
    if (n < best) { best = n; bestRanks = ranks.map(rank => [...rank]); }
  }
  ranks = bestRanks;
  settle();

  // 5. order-axis positions, per lane
  const sep = (x, y) => (x.os + y.os) / 2 + (x.real && y.real ? o.nodeGap : x.real || y.real ? o.nodeGap / 2 : o.dummyGap);
  const groups = ranks.map(rank => {
    const byLane = new Map();
    for (const v of rank) {
      if (!byLane.has(v.lane)) byLane.set(v.lane, []);
      byLane.get(v.lane).push(v);
    }
    return [...byLane.values()];
  });
  for (const rankGroups of groups) {
    for (const grp of rankGroups) grp.forEach((v, i) => { v.c = i ? grp[i - 1].c + sep(grp[i - 1], v) : 0; });
  }
  for (let it = 0; it < 12; it++) {
    for (const r of it % 2 ? range(maxRank, 0) : range(0, maxRank)) {
      for (const grp of groups[r]) {
        const desired = grp.map(v => {
          const nb = [...v.ins.map(h => h.a), ...v.outs.map(h => h.b)].filter(n => n.lane === v.lane);
          if (!nb.length) return v.c;
          const total = nb.reduce((s, n) => s + weight(n), 0);
          return nb.reduce((s, n) => s + n.c * weight(n), 0) / total;
        });
        const placed = pack(desired, grp.slice(1).map((v, i) => sep(grp[i], v)), grp.map(weight));
        grp.forEach((v, i) => { v.c = placed[i]; });
      }
    }
  }
  // Whether `v` can move to `c` without coming closer to a neighbour than the packing allows.
  const fitsAt = (v, c) => {
    const grp = groups[v.rank].find(gr => gr.includes(v));
    const i = grp.indexOf(v);
    return (i === 0 || c - grp[i - 1].c >= sep(grp[i - 1], v)) && (i === grp.length - 1 || grp[i + 1].c - c >= sep(v, grp[i + 1]));
  };
  // A small jog between two neighbours reads as a mistake: snap them onto one line, moving
  // whichever of the two is not already in line with another neighbour. Long edges passing
  // through the rank give way; other nodes do not.
  const moveTo = (v, c) => {
    const grp = groups[v.rank].find(gr => gr.includes(v));
    const placed = pack(grp.map(n => (n === v ? c : n.c)), grp.slice(1).map((n, i) => sep(grp[i], n)), grp.map(n => (n === v ? 1e3 : weight(n))));
    if (grp.some((n, i) => (n === v ? Math.abs(placed[i] - c) : n.real ? Math.abs(placed[i] - n.c) : 0) > 0.5)) return false;
    grp.forEach((n, i) => { n.c = placed[i]; });
    return true;
  };
  const inLine = (v, except) => [...v.ins.map(h => h.a), ...v.outs.map(h => h.b)]
    .some(n => n !== except && n.real && n.lane === v.lane && Math.abs(n.c - v.c) < 0.5);
  for (let pass = 0; pass < 3; pass++) {
    for (const h of ranks.flatMap(rank => rank.flatMap(v => v.outs))) {
      const { a, b } = h;
      const jog = Math.abs(a.c - b.c);
      if (!a.real || !b.real || a.lane !== b.lane || jog < 0.5 || jog > 16) continue;
      const movedB = !inLine(b, a) && moveTo(b, a.c);
      if (!movedB && !inLine(a, b)) moveTo(a, b.c);
    }
  }

  // A long edge reads best straight: move its dummies onto one line where the packing allows.
  for (const e of L) {
    const dummies = e.chain.filter(v => !v.real);
    if (!dummies.length) continue;
    const ends = [e.a, e.b].filter(v => v.lane === dummies[0].lane).map(v => v.c);
    const target = [...ends, Math.round(mean(dummies.map(d => d.c)))].find(c => dummies.every(d => fitsAt(d, c)));
    if (target !== undefined) for (const d of dummies) d.c = target;
  }
  const header = hasLanes ? o.laneHeader : 0;
  const lanePad = hasLanes ? o.lanePad : 0;
  let cursor = o.margin;
  const laneBands = laneIds.map((id, l) => {
    const members = V.filter(v => v.lane === l);
    const lo = members.length ? Math.min(...members.map(v => v.c - v.os / 2)) : 0;
    const hi = members.length ? Math.max(...members.map(v => v.c + v.os / 2)) : 0;
    const start = cursor;
    for (const v of members) v.o = Math.round(v.c + start + header + lanePad - lo);
    const size = header + lanePad * 2 + (hi - lo);
    cursor += size + o.laneGap;
    return { id, start, size };
  });
  const orderExtent = cursor - o.laneGap + o.margin;

  // 6. ports: where each hop meets its end vertices, on the order axis
  const fixedPort = (h, end) => {
    const first = h.e.chain[0] === h.a && end === 'a';
    const lastEnd = h.last && end === 'b';
    if (!first && !lastEnd) return undefined;
    const drawnFrom = (end === 'a') !== h.e.rev; // this end is the edge's drawn source
    return drawnFrom ? h.e.fromPort : h.e.toPort;
  };
  for (const v of V) {
    if (!v.real) {
      for (const h of v.ins) h.pb = v.o;
      for (const h of v.outs) h.pa = v.o;
      continue;
    }
    for (const [hops, end, partner] of [[v.outs, 'a', h => h.b], [v.ins, 'b', h => h.a]]) {
      const key = end === 'a' ? 'pa' : 'pb';
      const loose = [];
      for (const h of hops) {
        const fixed = fixedPort(h, end);
        if (fixed !== undefined) h[key] = Math.round(v.o - v.os / 2 + fixed);
        else loose.push(h);
      }
      const shared = o.sharePorts ? loose.filter(h => !h.e.rev) : [];
      const units = [...(shared.length ? [shared] : []), ...loose.filter(h => !shared.includes(h)).map(h => [h])];
      units.sort((x, y) => mean(x.map(h => partner(h).o)) - mean(y.map(h => partner(h).o)) || x[0].e.i - y[0].e.i);
      const inset = Math.min(8, v.os / 4);
      const spacing = units.length > 1 ? Math.min(o.portGap, (v.os - 2 * inset) / (units.length - 1)) : 0;
      // A loose port keeps clear of the fixed ports on its side: it takes the free slot
      // nearest to where an even spread would put it.
      const taken = hops.filter(h => !loose.includes(h)).map(h => h[key]);
      const lo = v.o - v.os / 2 + inset;
      const hi = v.o + v.os / 2 - inset;
      // The shared port keeps the centre, so a chain of forward edges stays straight.
      const ideals = new Map(units.map((unit, k) => [unit, unit === shared && units.length > 1 ? v.o : v.o + (k - (units.length - 1) / 2) * spacing]));
      if (shared.length) units.sort((x, y) => (y === shared) - (x === shared));
      units.forEach(unit => {
        const ideal = ideals.get(unit);
        let slot = ideal;
        if (taken.some(t => Math.abs(t - ideal) < o.portGap)) {
          const free = [];
          for (let s = lo; s <= hi; s += o.portGap / 2) if (!taken.some(t => Math.abs(t - s) < o.portGap)) free.push(s);
          if (free.length) slot = free.reduce((best, s) => (Math.abs(s - ideal) < Math.abs(best - ideal) ? s : best));
        }
        taken.push(slot);
        for (const h of unit) h[key] = Math.round(slot);
      });
    }
  }

  // A self loop reaches out of the node and back in, on its incoming side when no edge arrives
  // there, and on its outgoing side otherwise.
  const selves = E.filter(e => e.self).map(e => {
    const v = e.u;
    const p1 = Math.round(v.o - v.os / 2 + (e.fromPort ?? v.os * 0.25));
    const p2 = Math.round(v.o - v.os / 2 + (e.toPort ?? v.os * 0.75));
    return { e, v, p1, p2, side: !v.ins.length && v.outs.length ? 'in' : 'out' };
  });
  const labelExtent = l => (LR ? l.w : l.h);
  const loopRoom = side => range(0, maxRank).map(r => Math.max(0, ...selves.filter(s => s.v.rank === r && s.side === side)
    .map(s => o.loop + (s.e.label ? o.labelPad * 2 + labelExtent(s.e.label) : o.labelPad))));
  const roomOut = loopRoom('out');
  const roomIn = loopRoom('in');

  // Tracks: a hop whose ends differ on the order axis turns on a track in its gap. Hops that
  // leave one shared port share a track, so a fan-out reads as one trunk.
  const gaps = range(0, Math.max(0, maxRank - 1)).map(r => {
    if (r >= maxRank) return null;
    const turning = ranks[r].flatMap(v => v.outs).filter(h => Math.abs(h.pa - h.pb) > 0.5);
    const buses = [];
    for (const h of turning) {
      const bus = buses.find(b => b.a === h.a && b.p === h.pa);
      if (bus) bus.hops.push(h);
      else buses.push({ a: h.a, p: h.pa, hops: [h] });
    }
    for (const b of buses) {
      b.qs = b.hops.map(h => h.pb);
      b.lo = Math.min(b.p, ...b.qs);
      b.hi = Math.max(b.p, ...b.qs);
    }
    const within = (x, b) => x > b.lo + 0.5 && x < b.hi - 0.5;
    // Cost of putting bus i on a track nearer the source than bus j: each crossing counts 1,
    // and an end of i on the line where j starts counts 2, since the two would run together.
    const cost = (i, j) => i.qs.filter(q => within(q, j)).length + (within(j.p, i) ? 1 : 0)
      + 2 * i.qs.filter(q => Math.abs(q - j.p) < 0.5).length;
    buses.sort((i, j) => cost(i, j) - cost(j, i) || i.p - j.p || i.lo - j.lo);
    buses.forEach((b, k) => {
      b.track = 0;
      for (const prev of buses.slice(0, k)) if (prev.lo < b.hi + 4 && b.lo < prev.hi + 4) b.track = Math.max(b.track, prev.track + 1);
      for (const h of b.hops) h.track = b.track;
    });
    const tracks = buses.length ? Math.max(...buses.map(b => b.track)) + 1 : 0;
    const labels = L.filter(e => e.label && e.b.rank === r + 1).map(e => labelExtent(e.label));
    const labelZone = labels.length ? Math.max(...labels) + o.labelPad * 2 : 0;
    // Loops on the next rank's incoming side share the end of the gap with the labels, which sit
    // beside other nodes, but not with the tracks.
    const lead = Math.max(o.stub, roomOut[r] + o.trackGap);
    const size = Math.max(o.minGap, lead + Math.max(0, tracks - 1) * o.trackGap + Math.max(labelZone + o.stub, roomIn[r + 1] + o.trackGap));
    return { lead, tracks, labelZone, size };
  });

  // Rank-axis positions.
  const rankSize = ranks.map(rank => Math.max(0, ...rank.filter(v => v.real).map(v => v.rs)));
  const rankStart = [];
  let along = o.margin + lanePad + roomIn[0];
  for (let r = 0; r <= maxRank; r++) {
    rankStart[r] = along;
    along += rankSize[r] + (r < maxRank ? gaps[r].size : roomOut[r]);
  }
  const rankExtent = along + lanePad + o.margin;
  const centre = v => rankStart[v.rank] + rankSize[v.rank] / 2;
  const outBorder = v => (v.real ? centre(v) + v.rs / 2 : rankStart[v.rank] + rankSize[v.rank]);
  const inBorder = v => (v.real ? centre(v) - v.rs / 2 : rankStart[v.rank]);
  const gapEnd = r => rankStart[r + 1];
  const trackAt = (r, t) => rankStart[r] + rankSize[r] + gaps[r].lead + t * o.trackGap;

  // ---- output ----------------------------------------------------------------------------------
  const point = (r, q) => (LR ? { x: r, y: q } : { x: q, y: r });
  const tidy = pts => {
    const out = [];
    for (const p of pts) {
      if (out.length && out.at(-1).x === p.x && out.at(-1).y === p.y) continue;
      if (out.length >= 2) {
        const [a, b] = [out.at(-2), out.at(-1)];
        if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop();
      }
      out.push(p);
    }
    return out;
  };

  const edges = E.map(e => {
    if (e.self) {
      const s = selves.find(x => x.e === e);
      const out = s.side === 'out' ? 1 : -1;
      const r0 = out > 0 ? outBorder(s.v) : inBorder(s.v);
      const r1 = r0 + out * o.loop;
      const pts = [point(r0, s.p1), point(r1, s.p1), point(r1, s.p2), point(r0, s.p2)];
      const label = e.label && box(r1 + out * (o.labelPad + labelExtent(e.label) / 2), (s.p1 + s.p2) / 2, e.label);
      return { points: pts, label, reversed: false };
    }
    const pts = [];
    for (const h of e.hops) {
      const ra = outBorder(h.a);
      const rb = inBorder(h.b);
      pts.push(point(ra, h.pa));
      if (Math.abs(h.pa - h.pb) > 0.5) {
        const t = trackAt(h.a.rank, h.track);
        pts.push(point(t, h.pa), point(t, h.pb));
      }
      pts.push(point(rb, h.pb));
    }
    let label = null;
    if (e.label) {
      const last = e.hops.at(-1);
      const gap = gaps[last.a.rank];
      const zoneEnd = gapEnd(last.a.rank) - o.stub;
      label = box(zoneEnd - gap.labelZone / 2, last.pb, e.label);
    }
    const tidied = tidy(pts);
    return { points: e.rev ? tidied.reverse() : tidied, label, reversed: e.rev };
  });

  function box(r, q, size) {
    const c = point(r, q);
    return { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h };
  }

  const nodes = {};
  for (const v of V) {
    if (!v.real) continue;
    const c = point(centre(v), v.o);
    nodes[v.id] = { x: c.x - v.w / 2, y: c.y - v.h / 2, w: v.w, h: v.h };
  }
  const lanes = hasLanes ? laneBands.map(b => {
    const a = point(o.margin, b.start);
    const z = point(rankExtent - o.margin, b.start + b.size);
    return { id: b.id, x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y };
  }) : [];
  // A label that would cover a node or an earlier label moves to the middle of the longest
  // free straight run of its own edge.
  const nodeRects = Object.values(nodes);
  const placed = [];
  for (const out of edges) {
    if (!out.label) continue;
    const { w, h } = out.label;
    const runs = out.points.slice(1).map((b, k) => [out.points[k], b])
      .filter(([a, b]) => (LR ? a.y === b.y : a.x === b.x))
      .map(([a, b]) => ({ a, b, len: Math.abs(LR ? b.x - a.x : b.y - a.y) }))
      .filter(s => s.len >= (LR ? w : h) + 2 * o.labelPad)
      .sort((s, t) => t.len - s.len);
    const candidates = [out.label, ...runs.map(s => ({ x: (s.a.x + s.b.x) / 2 - w / 2, y: (s.a.y + s.b.y) / 2 - h / 2, w, h }))];
    out.label = candidates.find(c => !nodeRects.some(r => overlaps(c, r)) && !placed.some(p => overlaps(c, p, 2))) || out.label;
    placed.push(out.label);
  }

  const size = point(rankExtent, orderExtent);
  return { width: size.x, height: size.y, nodes, edges, lanes };
}

const tidyPoints = pts => {
  const out = [];
  for (const p of pts) {
    if (out.length && out.at(-1).x === p.x && out.at(-1).y === p.y) continue;
    if (out.length >= 2) {
      const [a, b] = [out.at(-2), out.at(-1)];
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop();
    }
    out.push(p);
  }
  return out;
};

/**
 * Layered layout with optional nested groups. `g.groups` is `{id, parent?, minW?}[]` and a node
 * may name its group in `node.group`. Without groups this is the flat layout, unchanged. With
 * them the result also holds `groupBoxes`, `{id, x, y, w, h, parent?}[]` in declaration order.
 *
 * Bottom-up: a group is laid out as a graph of its own children, and its bounding box plus
 * padding becomes one node of its parent's layout. An edge between nodes of different groups is
 * routed at the level of their lowest common ancestor, between the two child items there. It
 * leaves or enters the item at the order-axis position of the inner node, then runs straight
 * on to that node's side, so it ends on the node and not on the group border.
 *
 * An empty group takes the minimum content area (`groupMin`) plus padding and header.
 * A bad reference throws `layout: ...`.
 */
export function layout(g, options = {}) {
  if (!g.groups?.length && !g.nodes.some(n => n.group != null)) return layoutFlat(g, options);
  const o = { ...DEFAULTS, ...options };
  const LR = o.dir !== 'TB';
  const groups = g.groups || [];
  const gById = new Map();
  for (const gr of groups) {
    if (gById.has(gr.id)) throw new Error(`layout: duplicate group "${gr.id}"`);
    gById.set(gr.id, gr);
  }
  const nById = new Map(g.nodes.map(n => [n.id, n]));
  for (const gr of groups) {
    if (nById.has(gr.id)) throw new Error(`layout: group "${gr.id}" has the id of a node`);
    if (gr.parent != null && !gById.has(gr.parent)) throw new Error(`layout: group "${gr.id}" has unknown parent "${gr.parent}"`);
  }
  const chainOfGroup = id => {
    const out = [];
    for (let c = id; c != null; c = gById.get(c).parent) {
      if (out.includes(c)) throw new Error(`layout: groups nest in a cycle at "${c}"`);
      out.unshift(c);
    }
    return out;
  };
  for (const gr of groups) chainOfGroup(gr.id);
  for (const n of g.nodes) if (n.group != null && !gById.has(n.group)) throw new Error(`layout: node "${n.id}" is in unknown group "${n.group}"`);
  for (const e of g.edges) {
    for (const end of [e.from, e.to]) if (!nById.has(end)) throw new Error(`layout: edge refers to unknown node "${end}"`);
  }
  const chain = nodeId => chainOfGroup(nById.get(nodeId).group ?? null);

  const kids = new Map([[null, { nodes: [], groups: [] }], ...groups.map(gr => [gr.id, { nodes: [], groups: [] }])]);
  for (const n of g.nodes) kids.get(n.group ?? null).nodes.push(n);
  for (const gr of groups) kids.get(gr.parent ?? null).groups.push(gr);

  // The level an edge is routed at: the deepest group holding both ends.
  const levelEdges = new Map();
  g.edges.forEach((e, i) => {
    const [ca, cb] = [chain(e.from), chain(e.to)];
    let k = 0;
    while (k < ca.length && k < cb.length && ca[k] === cb[k]) k++;
    const level = k ? ca[k - 1] : null;
    if (!levelEdges.has(level)) levelEdges.set(level, []);
    levelEdges.get(level).push(i);
  });

  const key = id => `\0group:${id}`;
  const shift = (r, dx, dy) => ({ ...r, x: r.x + dx, y: r.y + dy });
  const laneOfGroup = id => g.nodes.find(n => n.lane != null && chain(n.id).includes(id))?.lane;

  // Everything a level returns is in the frame of its own box: pos holds its nodes, boxes its
  // inner groups, edges the edges routed at this level and below.
  const build = id => {
    const root = id === null;
    const depth = root ? 0 : chainOfGroup(id).length;
    const own = kids.get(id);
    const subs = new Map(own.groups.map(gr => [gr.id, build(gr.id)]));
    const items = [
      ...own.nodes.map(n => ({ id: n.id, w: n.w, h: n.h, lane: n.lane })),
      ...own.groups.map(gr => ({ id: key(gr.id), w: subs.get(gr.id).w, h: subs.get(gr.id).h, lane: laneOfGroup(gr.id) })),
    ];
    const mine = levelEdges.get(id) || [];
    // The item at this level holding a node, and where the node sits on the order axis within it.
    const endOf = nodeId => {
      const c = chain(nodeId);
      if (c.length <= depth) return { item: nodeId };
      const r = subs.get(c[depth]).pos.get(nodeId);
      return { item: key(c[depth]), inner: r, port: LR ? r.y + r.h / 2 : r.x + r.w / 2 };
    };
    const ends = mine.map(i => [endOf(g.edges[i].from), endOf(g.edges[i].to)]);
    const flatEdges = mine.map((i, k) => {
      const e = g.edges[i];
      const [a, b] = ends[k];
      return { from: a.item, to: b.item, label: e.label, fromPort: a.port ?? e.fromPort, toPort: b.port ?? e.toPort };
    });
    const out = items.length
      ? layoutFlat({ nodes: items, edges: flatEdges, lanes: root ? g.lanes : undefined }, root ? options : { ...options, margin: 0 })
      : { width: 0, height: 0, nodes: {}, edges: [], lanes: [] };

    const pad = root ? 0 : o.groupPad;
    const [ox, oy] = root ? [0, 0] : [pad, o.groupHeader + pad];
    const inner = { w: Math.max(out.width, root ? 0 : o.groupMin.w), h: Math.max(out.height, root ? 0 : o.groupMin.h) };
    const minW = root ? 0 : gById.get(id).minW ?? 0;
    const result = {
      w: root ? out.width : Math.max(inner.w + 2 * pad, minW),
      h: root ? out.height : inner.h + oy + pad,
      lanes: out.lanes,
      pos: new Map(), boxes: [], edges: [],
    };
    for (const n of own.nodes) result.pos.set(n.id, shift(out.nodes[n.id], ox, oy));
    for (const gr of own.groups) {
      const item = out.nodes[key(gr.id)];
      const sub = subs.get(gr.id);
      const [dx, dy] = [item.x + ox, item.y + oy];
      result.boxes.push({ id: gr.id, x: dx, y: dy, w: item.w, h: item.h, ...(root ? {} : { parent: id }) });
      for (const [nid, r] of sub.pos) result.pos.set(nid, shift(r, dx, dy));
      for (const b of sub.boxes) result.boxes.push(shift(b, dx, dy));
      for (const e of sub.edges) result.edges.push({ ...e, points: e.points.map(p => shift(p, dx, dy)), label: e.label && shift(e.label, dx, dy) });
    }
    mine.forEach((i, k) => {
      const r = out.edges[k];
      const pts = r.points;
      // Past the item's border, straight on to the side of the inner node that faces it.
      const reach = (p, end) => {
        if (!end.inner) return [];
        const item = out.nodes[end.item];
        const at = shift(end.inner, item.x, item.y);
        return [LR ? { x: p.x <= item.x + 0.01 ? at.x : at.x + at.w, y: p.y } : { x: p.x, y: p.y <= item.y + 0.01 ? at.y : at.y + at.h }];
      };
      const full = tidyPoints([...reach(pts[0], ends[k][0]), ...pts, ...reach(pts.at(-1), ends[k][1])]);
      result.edges.push({ idx: i, points: full.map(p => shift(p, ox, oy)), label: r.label && shift(r.label, ox, oy), reversed: r.reversed });
    });
    return result;
  };

  const top = build(null);
  const nodes = {};
  for (const n of g.nodes) nodes[n.id] = top.pos.get(n.id);
  const boxOf = new Map(top.boxes.map(b => [b.id, b]));
  return {
    width: top.w, height: top.h, nodes,
    edges: [...top.edges].sort((a, b) => a.idx - b.idx).map(({ points, label, reversed }) => ({ points, label, reversed })),
    lanes: top.lanes,
    groupBoxes: groups.map(gr => boxOf.get(gr.id)),
  };
}
