// Architecture: components in nested groups (dashed frames), connections routed by the layered layout.
// A group may sit in another group; a connection may cross group borders and ends on the component.
import { layout } from './layered.mjs';
import { textWidth, wrap, esc } from './text.mjs';
import { el, roundedPath, lines, plate, arrowRef, groupFrames, VARIANT_CLASS } from './svg.mjs';

const FONT = 13;
const LINE = 17;
const MAX_TEXT = 150;
const LABEL_FONT = 11;
const WIDE = 1000;
// Layout ids of groups carry a prefix so they can never meet a component id; component ids cannot hold a colon.
const gid = id => `group:${id}`;
const bare = id => id.slice('group:'.length);

export function architecture(model, { p }) {
  const nodes = model.nodes.map(n => {
    const text = wrap(n.label, MAX_TEXT, FONT, true);
    const tw = Math.max(...text.map(l => textWidth(l, FONT, true)));
    return { id: n.id, text, ...(n.group ? { group: gid(n.group) } : {}), w: Math.round(Math.max(96, tw + 32)), h: Math.max(44, text.length * LINE + 20) };
  });
  const edges = model.edges.map(e => ({
    from: e.from, to: e.to,
    label: e.label ? { w: Math.round(textWidth(e.label, LABEL_FONT) + 12), h: 18 } : null,
  }));
  const groups = model.groups.map(g => ({ id: gid(g.id), ...(g.parent ? { parent: gid(g.parent) } : {}), minW: Math.round(textWidth(g.label, 12, true) + 36) }));
  const graph = { nodes, edges, groups };
  let out = layout(graph);
  if (out.width > WIDE) {
    const tall = layout(graph, { dir: 'TB' });
    if (tall.width < out.width) out = tall;
  }

  const groupBoxes = (out.groupBoxes || []).map(b => ({ ...b, id: bare(b.id), ...(b.parent ? { parent: bare(b.parent) } : {}) }));
  const label = new Map(model.groups.map(g => [g.id, g.label]));
  const groupSvg = groupFrames(groupBoxes, id => label.get(id));

  const edgeSvg = out.edges.map((r, i) => {
    const v = model.edges[i].variant;
    return el('path', { class: `dg-edge ${VARIANT_CLASS(v)}`, d: roundedPath(r.points), 'marker-end': arrowRef(p, v) });
  }).join('');
  const labelSvg = out.edges.map((r, i) => (r.label ? plate(r.label, model.edges[i].label, `dg-elabel ${VARIANT_CLASS(model.edges[i].variant)}`, LABEL_FONT) : '')).join('');

  const nodeSvg = model.nodes.map((n, i) => {
    const r = out.nodes[n.id];
    return el('g', { 'data-node-id': n.id, 'data-node-label': n.label, class: `dg-node t-${n.type}` },
      el('title', {}, esc(n.label)) + el('rect', { class: 'dg-shape', x: r.x, y: r.y, width: r.w, height: r.h, rx: 8 })
      + lines(r.x + r.w / 2, r.y + r.h / 2, nodes[i].text, 'dg-node-label', LINE, FONT));
  }).join('');

  return {
    width: out.width, height: out.height,
    body: groupSvg + edgeSvg + labelSvg + nodeSvg,
    nodes: model.nodes.map(n => n.id),
    boxes: [
      ...model.nodes.map(n => { const { x, y, w, h } = out.nodes[n.id]; return { id: n.id, x, y, w, h, ...(n.group ? { parent: n.group } : {}) }; }),
      ...groupBoxes,
    ],
    desc: `Architecture of ${model.nodes.length} components in ${model.groups.length} groups.`,
  };
}
