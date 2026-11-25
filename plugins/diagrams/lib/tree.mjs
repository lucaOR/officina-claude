// Tree and org chart: a forest laid out top to bottom, joined by plain elbow lines with no arrowheads.
import { layout } from './layered.mjs';
import { textWidth, wrap, esc } from './text.mjs';
import { el, roundedPath, lines } from './svg.mjs';

const FONT = 13;
const LINE = 17;
const MAX_TEXT = 150;

export function tree(model) {
  const nodes = model.nodes.map(n => {
    const text = wrap(n.label, MAX_TEXT, FONT, true);
    const tw = Math.max(...text.map(l => textWidth(l, FONT, true)));
    return { id: n.id, text, w: Math.round(Math.max(96, tw + 32)), h: Math.max(44, text.length * LINE + 20) };
  });
  const out = layout({ nodes, edges: model.edges.map(e => ({ from: e.from, to: e.to, label: null })) }, { dir: 'TB' });

  const edgeSvg = out.edges.map(r => el('path', { class: 'dg-tree-edge', d: roundedPath(r.points) })).join('');
  const nodeSvg = model.nodes.map((n, i) => {
    const r = out.nodes[n.id];
    return el('g', { 'data-node-id': n.id, 'data-node-label': n.label, class: `dg-node t-${n.type}` },
      el('title', {}, esc(n.label)) + el('rect', { class: 'dg-shape', x: r.x, y: r.y, width: r.w, height: r.h, rx: 8 })
      + lines(r.x + r.w / 2, r.y + r.h / 2, nodes[i].text, 'dg-node-label', LINE, FONT));
  }).join('');

  return {
    width: out.width, height: out.height,
    body: edgeSvg + nodeSvg,
    nodes: model.nodes.map(n => n.id),
    boxes: model.nodes.map(n => { const { x, y, w, h } = out.nodes[n.id]; return { id: n.id, x, y, w, h }; }),
    desc: `Tree of ${model.nodes.length} nodes.`,
  };
}
