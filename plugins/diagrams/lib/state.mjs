// State machine: rounded states, a dot for the initial marker, a double ring for the final one,
// and transitions routed by the layered layout. A transition may return to its own state.
import { layout } from './layered.mjs';
import { textWidth, wrap, esc } from './text.mjs';
import { el, roundedPath, lines, plate, arrowRef, VARIANT_CLASS } from './svg.mjs';

const FONT = 13;
const LINE = 17;
const MAX_TEXT = 150;
const LABEL_FONT = 11;
const WIDE = 1000;
const DOT = 16;
const RING = 24;

export function state(model, { p }) {
  const nodes = [
    ...model.markers.map(m => ({ id: m.id, w: m.kind === 'initial' ? DOT : RING, h: m.kind === 'initial' ? DOT : RING })),
    ...model.states.map(s => {
      const text = wrap(s.label, MAX_TEXT, FONT, true);
      const tw = Math.max(...text.map(l => textWidth(l, FONT, true)));
      return { id: s.id, text, w: Math.round(Math.max(88, tw + 32)), h: Math.max(40, text.length * LINE + 18) };
    }),
  ];
  const edges = model.transitions.map(t => ({
    from: t.from, to: t.to,
    label: t.label ? { w: Math.round(textWidth(t.label, LABEL_FONT) + 12), h: 18 } : null,
  }));
  const graph = { nodes, edges };
  let out = layout(graph);
  if (out.width > WIDE) {
    const tall = layout(graph, { dir: 'TB' });
    if (tall.width < out.width) out = tall;
  }

  const edgeSvg = out.edges.map((r, i) => {
    const v = model.transitions[i].variant;
    return el('path', { class: `dg-edge ${VARIANT_CLASS(v)}`, d: roundedPath(r.points), 'marker-end': arrowRef(p, v) });
  }).join('');
  const labelSvg = out.edges.map((r, i) => (r.label ? plate(r.label, model.transitions[i].label, `dg-elabel ${VARIANT_CLASS(model.transitions[i].variant)}`, LABEL_FONT) : '')).join('');

  const markerSvg = model.markers.map(m => {
    const { x, y, w, h } = out.nodes[m.id];
    const cx = x + w / 2;
    const cy = y + h / 2;
    const shape = m.kind === 'initial'
      ? el('circle', { class: 'dg-initial', cx, cy, r: w / 2 })
      : el('g', { class: 'dg-final' }, el('circle', { class: 'dg-final-ring', cx, cy, r: w / 2 - 1 }) + el('circle', { class: 'dg-final-dot', cx, cy, r: w / 2 - 6 }));
    return el('g', { 'data-node-id': m.id, 'data-node-label': m.kind, class: 'dg-node dg-marker' }, el('title', {}, m.kind) + shape);
  }).join('');

  const stateSvg = model.states.map(s => {
    const r = out.nodes[s.id];
    const text = nodes.find(n => n.id === s.id).text;
    return el('g', { 'data-node-id': s.id, 'data-node-label': s.label, class: `dg-node dg-state t-${s.type}` },
      el('title', {}, esc(s.label)) + el('rect', { class: 'dg-shape', x: r.x, y: r.y, width: r.w, height: r.h, rx: 14 })
      + lines(r.x + r.w / 2, r.y + r.h / 2, text, 'dg-node-label', LINE, FONT));
  }).join('');

  const ids = model.order;
  return {
    width: out.width, height: out.height,
    body: edgeSvg + labelSvg + markerSvg + stateSvg,
    nodes: ids,
    boxes: ids.map(id => { const { x, y, w, h } = out.nodes[id]; return { id, x, y, w, h }; }),
    desc: `State diagram of ${model.states.length} states and ${model.transitions.length} transitions.`,
  };
}
