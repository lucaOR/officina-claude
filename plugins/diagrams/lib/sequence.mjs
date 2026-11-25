// Sequence: actors across the top, one row per message, phases as bands behind their rows.
// Plain arithmetic, no graph layout: each gap between two lifelines grows until every
// message label between them fits.
import { textWidth, esc } from './text.mjs';
import { el, plate, arrowRef, VARIANT_CLASS } from './svg.mjs';

const ACTOR_FONT = 13;
const MSG_FONT = 12;
const BOX_H = 40;
const MARGIN = 16;
const INSET = 12; // between a band's edge and the outermost actor box
const LOOP = 28; // how far a self message reaches right
const TAB_FONT = 11;

export function sequence(model, { p }) {
  const actors = model.actors.map(a => ({ ...a, w: Math.round(Math.max(96, textWidth(a.label, ACTOR_FONT, true) + 32)) }));
  const at = new Map(actors.map((a, i) => [a.id, i]));
  const labelW = m => Math.round(textWidth(m.label, MSG_FONT) + 12);

  const gap = actors.slice(1).map((a, i) => (actors[i].w + a.w) / 2 + 24);
  let rightRoom = actors.at(-1).w / 2;
  const messages = model.messages.map(m => ({ ...m, i: at.get(m.from), j: at.get(m.to), w: labelW(m) }));
  for (const m of messages.filter(m => m.i === m.j)) {
    const need = LOOP + 8 + m.w + 8;
    if (m.i === actors.length - 1) rightRoom = Math.max(rightRoom, need);
    else gap[m.i] = Math.max(gap[m.i], need + 8);
  }
  for (const m of messages.filter(m => m.i !== m.j).sort((a, b) => Math.abs(a.i - a.j) - Math.abs(b.i - b.j))) {
    const [lo, hi] = [Math.min(m.i, m.j), Math.max(m.i, m.j)];
    const have = gap.slice(lo, hi).reduce((s, g) => s + g, 0);
    const need = m.w + 24;
    if (have < need) for (let k = lo; k < hi; k++) gap[k] += (need - have) / (hi - lo);
  }
  const cx = [MARGIN + INSET + actors[0].w / 2];
  gap.forEach((g, k) => cx.push(cx[k] + g));
  const tabW = ph => Math.round(textWidth(ph.label, TAB_FONT, true) + 16);
  const width = Math.max(cx.at(-1) + rightRoom + INSET + MARGIN, ...model.phases.map(ph => MARGIN * 2 + tabW(ph) + 20));

  // Rows.
  let y = MARGIN + BOX_H + 18;
  const bands = [];
  const rows = messages.map((m, k) => {
    const opening = model.phases.findIndex(ph => ph.first === k);
    if (opening >= 0) {
      if (bands.length) y += 10;
      bands.push({ phase: model.phases[opening], index: opening, top: y });
      y += 30;
    }
    const row = { m, y };
    y += m.i === m.j ? 44 : 38;
    if (model.phases.some(ph => ph.last === k)) {
      bands.at(-1).bottom = y + 2;
      y += 2;
    }
    return row;
  });
  const bottom = y + 8;
  const height = bottom + MARGIN;

  const bandSvg = bands.map(b => el('rect', { class: 'dg-band', x: MARGIN, y: b.top, width: width - MARGIN * 2, height: b.bottom - b.top, rx: 10 })).join('');
  const tabSvg = bands.map(b => el('g', { class: 'dg-phase-label', 'data-segment-id': b.index },
    el('rect', { x: MARGIN + 10, y: b.top + 8, width: tabW(b.phase), height: 18, rx: 9 })
    + el('text', { x: MARGIN + 18, y: b.top + 17 + TAB_FONT * 0.35 }, esc(b.phase.label)))).join('');
  const lifeSvg = actors.map((a, i) => el('line', { class: 'dg-life', x1: cx[i], y1: MARGIN + BOX_H, x2: cx[i], y2: bottom })).join('');
  const actorSvg = actors.map((a, i) => el('g', { 'data-node-id': a.id, 'data-node-label': a.label, class: `dg-node t-${a.type}` },
    el('title', {}, esc(a.label))
    + el('rect', { class: 'dg-shape', x: cx[i] - a.w / 2, y: MARGIN, width: a.w, height: BOX_H, rx: 8 })
    + el('text', { class: 'dg-node-label', x: cx[i], y: MARGIN + BOX_H / 2 + ACTOR_FONT * 0.35, 'text-anchor': 'middle' }, esc(a.label)))).join('');

  // Each message is a node too, so a page can link to it. A thin arrow is hard to point at, so
  // an unpainted rectangle over its row takes the pointer; it needs no stylesheet to stay invisible.
  const hit = (x, y, w, h) => el('rect', { class: 'dg-hit', x, y, width: w, height: h, fill: 'none', 'pointer-events': 'all' });
  const msgSvg = rows.map(({ m, y: top }) => {
    const cls = `dg-msg ${VARIANT_CLASS(m.variant)}`;
    const labelCls = `dg-elabel ${VARIANT_CLASS(m.variant)}`;
    const x0 = cx[m.i];
    let body;
    if (m.i === m.j) {
      const d = `M${x0} ${top + 8}H${x0 + LOOP}V${top + 30}H${x0 + 1}`;
      body = hit(x0 - 4, top + 2, LOOP + 8 + m.w + 8, 34)
        + el('path', { class: cls, d, 'marker-end': arrowRef(p, m.variant) })
        + plate({ x: x0 + LOOP + 8, y: top + 10, w: m.w, h: 18 }, m.label, labelCls, MSG_FONT);
    } else {
      const x1 = cx[m.j];
      const line = top + 26;
      body = hit(Math.min(x0, x1), top - 2, Math.abs(x1 - x0), 34)
        + el('path', { class: cls, d: `M${x0} ${line}H${x1}`, 'marker-end': arrowRef(p, m.variant) })
        + plate({ x: (x0 + x1) / 2 - m.w / 2, y: top, w: m.w, h: 18 }, m.label, labelCls, MSG_FONT);
    }
    return el('g', { 'data-node-id': m.id, 'data-node-label': m.label, class: 'dg-message' }, el('title', {}, esc(m.label)) + body);
  }).join('');

  return {
    width, height,
    body: bandSvg + lifeSvg + actorSvg + msgSvg + tabSvg,
    nodes: [...actors.map(a => a.id), ...messages.map(m => m.id)],
    boxes: actors.map((a, i) => ({ id: a.id, x: cx[i] - a.w / 2, y: MARGIN, w: a.w, h: BOX_H })),
    desc: `Sequence of ${messages.length} messages between ${actors.length} actors.`,
  };
}
