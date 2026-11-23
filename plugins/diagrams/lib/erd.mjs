// Entity-relationship: entities as tables, laid out with the "one" side to the left of the
// "many" side, joined at the field rows that reference each other, with crow's-foot ends.
import { layout } from './layered.mjs';
import { textWidth, esc } from './text.mjs';
import { el, roundedPath, plate } from './svg.mjs';

const HEAD = 30;
const ROW = 22;
const BOTTOM = 6;
const TITLE_FONT = 13;
const FIELD_FONT = 12;
const TYPE_FONT = 11;
const KEY_W = 22;
const KEY_H = 14;
const KEY_GAP = 3;
const LABEL_FONT = 11;
const WIDE = 1000;

const unit = (from, to) => {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
};
const at = (p, d, k, n = { x: 0, y: 0 }, m = 0) => `${Math.round((p.x + d.x * k + n.x * m) * 10) / 10} ${Math.round((p.y + d.y * k + n.y * m) * 10) / 10}`;

/** The crow's-foot mark for `card` where a line leaves the entity at `p` towards `q`. */
function cardMark(p, q, card) {
  const d = unit(p, q);
  const n = { x: -d.y, y: d.x };
  const d2 = card === 'one'
    ? `M${at(p, d, 10, n, 7)}L${at(p, d, 10, n, -7)}`
    : `M${at(p, d, 0, n, 7)}L${at(p, d, 14)}L${at(p, d, 0, n, -7)}M${at(p, d, 0)}L${at(p, d, 14)}`;
  return el('path', { class: `dg-card dg-${card}`, d: d2 });
}

export function erd(model) {
  const byId = new Map(model.entities.map(e => [e.id, e]));
  const rowOf = (entity, field) => HEAD + byId.get(entity).fields.findIndex(f => f.name === field) * ROW + ROW / 2;
  const boxes = model.entities.map(e => {
    const keyW = Math.max(0, ...e.fields.map(f => f.keys.length)) * (KEY_W + KEY_GAP);
    const rowW = Math.max(0, ...e.fields.map(f => 12 + keyW + textWidth(f.name, FIELD_FONT, f.keys.includes('pk')) + 20 + textWidth(f.type, TYPE_FONT) + 12));
    return {
      id: e.id, keyW,
      w: Math.round(Math.max(170, textWidth(e.label, TITLE_FONT, true) + 32, rowW)),
      h: HEAD + Math.max(1, e.fields.length) * ROW + BOTTOM,
    };
  });

  // Each relationship runs from its "one" end to its "many" end, so parents sit to the left.
  const rels = model.rels.map(r => {
    const flip = r.fromCard === 'many' && r.toCard === 'one';
    const [a, b] = flip ? [r.to, r.from] : [r.from, r.to];
    const cards = flip ? [r.toCard, r.fromCard] : [r.fromCard, r.toCard];
    let ports = [undefined, undefined];
    const inB = byId.get(b).fields.find(f => f.ref?.entity === a);
    const inA = byId.get(a).fields.find(f => f.ref?.entity === b);
    if (inB) ports = [rowOf(a, inB.ref.field), rowOf(b, inB.name)];
    else if (inA) ports = [rowOf(a, inA.name), rowOf(b, inA.ref.field)];
    return { from: a, to: b, cards, ports, label: r.label };
  });
  const options = { sharePorts: false, stub: 26, portGap: 14, loop: 30, nodeGap: 28, minGap: 70 };
  const edges = withPorts => rels.map(r => ({
    from: r.from, to: r.to,
    fromPort: withPorts ? r.ports[0] : undefined, toPort: withPorts ? r.ports[1] : undefined,
    label: r.label ? { w: Math.round(textWidth(r.label, LABEL_FONT) + 12), h: 18 } : null,
  }));
  let out = layout({ nodes: boxes, edges: edges(true) }, options);
  if (out.width > WIDE) {
    // Top to bottom, lines meet the entities' top and bottom, so field-row ports do not apply.
    const tall = layout({ nodes: boxes, edges: edges(false) }, { ...options, dir: 'TB' });
    if (tall.width < out.width) out = tall;
  }

  const relSvg = out.edges.map((r, i) => el('path', { class: 'dg-rel', d: roundedPath(r.points) })
    + cardMark(r.points[0], r.points[1], rels[i].cards[0])
    + cardMark(r.points.at(-1), r.points.at(-2), rels[i].cards[1])).join('');
  const labelSvg = out.edges.map((r, i) => (r.label ? plate(r.label, rels[i].label, 'dg-elabel', LABEL_FONT) : '')).join('');

  const entitySvg = model.entities.map((e, i) => {
    const { x, y, w, h } = out.nodes[e.id];
    const head = `M${x} ${y + HEAD}V${y + 8}Q${x} ${y} ${x + 8} ${y}H${x + w - 8}Q${x + w} ${y} ${x + w} ${y + 8}V${y + HEAD}Z`;
    const rows = e.fields.map((f, k) => {
      const top = y + HEAD + k * ROW;
      const base = top + ROW / 2 + FIELD_FONT * 0.35;
      const keys = f.keys.map((key, j) => el('g', { class: `dg-key k-${key}` },
        el('rect', { x: x + 10 + j * (KEY_W + KEY_GAP), y: top + (ROW - KEY_H) / 2, width: KEY_W, height: KEY_H, rx: 3 })
        + el('text', { x: x + 10 + j * (KEY_W + KEY_GAP) + KEY_W / 2, y: top + ROW / 2 + 3.2, 'text-anchor': 'middle' }, key.toUpperCase()))).join('');
      return (k % 2 ? el('rect', { class: 'dg-zebra', x: x + 1, y: top, width: w - 2, height: ROW }) : '') + keys
        + el('text', { class: `dg-field${f.keys.includes('pk') ? ' dg-pk' : ''}`, x: x + 12 + boxes[i].keyW, y: base }, esc(f.name))
        + el('text', { class: 'dg-ftype', x: x + w - 12, y: base, 'text-anchor': 'end' }, esc(f.type));
    }).join('');
    return el('g', { 'data-node-id': e.id, 'data-node-label': e.label, class: 'dg-node dg-entity t-database' },
      el('title', {}, esc(e.label))
      + el('rect', { class: 'dg-shape', x, y, width: w, height: h, rx: 8 })
      + el('path', { class: 'dg-head-band', d: head })
      + el('text', { class: 'dg-etitle', x: x + w / 2, y: y + HEAD / 2 + TITLE_FONT * 0.35, 'text-anchor': 'middle' }, esc(e.label))
      + rows
      + el('rect', { class: 'dg-outline', x, y, width: w, height: h, rx: 8 }));
  }).join('');

  return {
    width: out.width, height: out.height,
    body: relSvg + labelSvg + entitySvg,
    nodes: model.entities.map(e => e.id),
    desc: `Entity-relationship diagram of ${model.entities.length} entities and ${model.rels.length} relationships.`,
  };
}
