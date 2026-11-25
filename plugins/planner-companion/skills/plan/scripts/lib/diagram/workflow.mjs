// Workflow: steps laid out left to right in rank order, in lane bands when lanes are declared.
// A long chain without lanes is laid out top to bottom instead, so it stays readable when scaled.
import { layout } from './layered.mjs';
import { textWidth, wrap, esc } from './text.mjs';
import { el, roundedPath, lines, plate, arrowRef, VARIANT_CLASS } from './svg.mjs';

const FONT = 13;
const LINE = 17;
const MAX_TEXT = 150;
const LABEL_FONT = 11;
const WIDE = 1000;

function shape(n, r) {
  if (!n.decision) return el('rect', { class: 'dg-shape', x: r.x, y: r.y, width: r.w, height: r.h, rx: 8 });
  const t = 14;
  const d = `M${r.x + t} ${r.y}H${r.x + r.w - t}L${r.x + r.w} ${r.y + r.h / 2}L${r.x + r.w - t} ${r.y + r.h}H${r.x + t}L${r.x} ${r.y + r.h / 2}Z`;
  return el('path', { class: 'dg-shape', d });
}

export function workflow(model, { p }) {
  const nodes = model.nodes.map(n => {
    const text = wrap(n.label, MAX_TEXT, FONT, true);
    const tw = Math.max(...text.map(l => textWidth(l, FONT, true)));
    const pad = n.decision ? 30 : 16;
    return { id: n.id, lane: n.lane, text, w: Math.round(Math.max(96, tw + pad * 2)), h: Math.max(44, text.length * LINE + 20) };
  });
  const edges = model.edges.map(e => ({
    from: e.from, to: e.to,
    label: e.label ? { w: Math.round(textWidth(e.label, LABEL_FONT) + 12), h: 18 } : null,
  }));
  const lanes = model.lanes.length ? model.lanes.map(l => l.id) : null;
  const graph = { nodes, edges, lanes };
  let out = layout(graph);
  if (!lanes && out.width > WIDE) {
    const tall = layout(graph, { dir: 'TB' });
    if (tall.width < out.width) out = tall;
  }

  // A lane is at least as wide as its label.
  const minWidth = Math.max(0, ...model.lanes.map(l => textWidth(l.label, 12, true) + 48));
  const width = Math.max(out.width, minWidth);
  const laneSvg = out.lanes.map((band, i) => {
    const label = model.lanes[i].label;
    return el('g', { class: 'dg-lane' }, el('rect', { x: band.x, y: band.y, width: band.w + width - out.width, height: band.h, rx: 10 })
      + el('text', { x: band.x + 12, y: band.y + 17 }, esc(label)));
  }).join('');

  const edgeSvg = out.edges.map((r, i) => {
    const v = model.edges[i].variant;
    return el('path', { class: `dg-edge ${VARIANT_CLASS(v)}`, d: roundedPath(r.points), 'marker-end': arrowRef(p, v) });
  }).join('');
  const labelSvg = out.edges.map((r, i) => (r.label ? plate(r.label, model.edges[i].label, `dg-elabel ${VARIANT_CLASS(model.edges[i].variant)}`, LABEL_FONT) : '')).join('');

  const nodeSvg = model.nodes.map((n, i) => {
    const r = out.nodes[n.id];
    const lane = model.lanes.find(l => l.id === n.lane);
    return el('g', {
      'data-node-id': n.id, 'data-node-label': n.label,
      class: `dg-node t-${n.type}${n.decision ? ' dg-decision' : ''}`,
    }, el('title', {}, esc(lane ? `${n.label} · ${lane.label}` : n.label)) + shape(n, r)
      + lines(r.x + r.w / 2, r.y + r.h / 2, nodes[i].text, 'dg-node-label', LINE, FONT));
  }).join('');

  return {
    width, height: out.height,
    body: laneSvg + edgeSvg + labelSvg + nodeSvg,
    nodes: model.nodes.map(n => n.id),
    boxes: model.nodes.map(n => { const { x, y, w, h } = out.nodes[n.id]; return { id: n.id, x, y, w, h }; }),
    desc: `Workflow of ${model.nodes.length} steps${model.lanes.length ? ` in ${model.lanes.length} lanes` : ''}.`,
  };
}
