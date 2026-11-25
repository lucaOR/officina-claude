// Timeline: events sit on a horizontal axis at their date; labels that would collide are stacked
// on further rows. Declared tracks become horizontal bands (decoration, not reported as boxes).
import { textWidth, wrap, esc } from './text.mjs';
import { el, lines } from './svg.mjs';

const FONT = 13;
const LINE = 17;
const MAX_TEXT = 150;
const PAD = 24;
const SPAN = 640; // axis length in px
const GAP = 12;
const ROW_GAP = 14;
const AXIS_Y = 36;
const WHEN_H = 14; // the date line above the label

export function timeline(model) {
  const days = model.events.map(e => e.day);
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  const gutter = model.tracks.length ? Math.max(...model.tracks.map(t => textWidth(t.label, 12, true))) + 28 : 0;
  const left = PAD + gutter;

  const items = model.events.map(e => {
    const text = wrap(e.label, MAX_TEXT, FONT, true);
    const tw = Math.max(textWidth(e.when, 11), ...text.map(l => textWidth(l, FONT, true)));
    const w = Math.round(Math.max(80, tw + 28));
    const h = text.length * LINE + WHEN_H + 20;
    const cx = hi === lo ? left + SPAN / 2 : left + ((e.day - lo) / (hi - lo)) * SPAN; // one shared date: centred
    return { e, text, w, h, cx, x: Math.max(left, cx - w / 2), y: 0 };
  });

  // Greedy rows per track: events in date order go on the first row whose last box ends before this one starts.
  const groups = model.tracks.length ? model.tracks.map(t => t.id) : [null];
  const order = items.map((_, i) => i).sort((a, b) => items[a].e.day - items[b].e.day || a - b);
  const inset = model.tracks.length ? 10 : 0;
  let y = AXIS_Y + 20;
  const bands = [];
  for (const g of groups) {
    const rows = [];
    for (const i of order.filter(i => items[i].e.track === g)) {
      const it = items[i];
      let r = rows.find(row => row.end + GAP <= it.x);
      if (!r) { r = { end: -Infinity, h: 0, items: [] }; rows.push(r); }
      r.items.push(it);
      r.end = it.x + it.w;
      r.h = Math.max(r.h, it.h);
    }
    const top = y;
    let ry = top + inset;
    for (const r of rows) { for (const it of r.items) it.y = ry; ry += r.h + ROW_GAP; }
    y = rows.length ? ry - ROW_GAP + inset : top + 2 * inset + 20; // an empty track keeps a slim band
    bands.push({ top, bottom: y });
    y += model.tracks.length ? 8 : 0;
  }

  const width = Math.ceil(Math.max(left + SPAN, ...items.map(it => it.x + it.w)) + PAD);
  const height = Math.ceil(y + PAD);

  const bandSvg = model.tracks.map((t, k) => el('g', { class: 'dg-lane' },
    el('rect', { x: PAD, y: bands[k].top, width: width - 2 * PAD, height: bands[k].bottom - bands[k].top, rx: 10 })
    + el('text', { x: PAD + 12, y: bands[k].top + 18 }, esc(t.label)))).join('');
  const axis = el('line', { class: 'dg-axis', x1: left, y1: AXIS_Y, x2: left + SPAN, y2: AXIS_Y });
  const stems = items.map(it => el('line', { class: 'dg-stem', x1: it.cx, y1: AXIS_Y, x2: it.cx, y2: it.y })).join('');
  const nodeSvg = items.map(it => {
    const { e } = it;
    return el('g', { 'data-node-id': e.id, 'data-node-label': e.label, class: `dg-node t-${e.type}` },
      el('title', {}, esc(`${e.when}: ${e.label}`)) + el('rect', { class: 'dg-shape', x: it.x, y: it.y, width: it.w, height: it.h, rx: 8 })
      + el('text', { class: 'dg-when', 'text-anchor': 'middle', x: it.x + it.w / 2, y: it.y + 16 }, esc(e.when))
      + lines(it.x + it.w / 2, it.y + WHEN_H + (it.h - WHEN_H) / 2, it.text, 'dg-node-label', LINE, FONT));
  }).join('');

  return {
    width, height,
    body: bandSvg + axis + stems + nodeSvg,
    nodes: model.events.map(e => e.id),
    boxes: items.map(it => ({ id: it.e.id, x: it.x, y: it.y, w: it.w, h: it.h })),
    desc: `Timeline of ${model.events.length} events.`,
  };
}
