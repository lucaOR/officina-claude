// SVG string helpers shared by the three renderers.
import { esc } from './text.mjs';

export const VARIANT_CLASS = v => `v-${v}`;
export const num = n => String(Math.round(n * 10) / 10);

/** ` name="value"` pairs, skipping null, undefined and false. */
export function attrs(a) {
  return Object.entries(a).filter(([, v]) => v !== null && v !== undefined && v !== false)
    .map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? num(v) : v)}"`).join('');
}
export const el = (tag, a, body) => (body === undefined ? `<${tag}${attrs(a)}/>` : `<${tag}${attrs(a)}>${body}</${tag}>`);

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const toward = (from, to, d) => {
  const len = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * d) / len, y: from.y + ((to.y - from.y) * d) / len };
};
const pt = p => `${num(p.x)} ${num(p.y)}`;

/** A polyline through `points`, its corners rounded by up to `radius`. */
export function roundedPath(points, radius = 6) {
  let d = `M${pt(points[0])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, dist(a, b) / 2, dist(b, c) / 2);
    d += ` L${pt(toward(b, a, r))} Q${pt(b)} ${pt(toward(b, c, r))}`;
  }
  return `${d} L${pt(points.at(-1))}`;
}

/** Centred text, one tspan per line, its block centred on `cy`. */
export function lines(cx, cy, list, cls, lineHeight, size) {
  const first = cy - ((list.length - 1) * lineHeight) / 2 + size * 0.35;
  const spans = list.map((line, i) => el('tspan', { x: cx, y: first + i * lineHeight }, esc(line))).join('');
  return el('text', { class: cls, 'text-anchor': 'middle' }, spans);
}

/** A label on a plate that masks the line under it. */
export function plate(box, text, cls, size) {
  return el('g', { class: cls }, el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 4 })
    + el('text', { x: box.x + box.w / 2, y: box.y + box.h / 2 + size * 0.35, 'text-anchor': 'middle' }, esc(text)));
}

/**
 * Group frames, outermost first so an inner frame draws over its parent. `boxes` are the layout's
 * group boxes (`parent` set when nested) and `label(id)` gives the plain text of a title.
 */
export function groupFrames(boxes, label) {
  const depth = b => { let n = 0; for (let p = b.parent; p !== undefined; p = boxes.find(x => x.id === p)?.parent) n++; return n; };
  return [...boxes].sort((a, b) => depth(a) - depth(b)).map(b => el('g', { class: `dg-group${b.parent === undefined ? '' : ' dg-group-nested'}`, 'data-group-id': b.id },
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10 }) + el('text', { x: b.x + 12, y: b.y + 17 }, esc(label(b.id))))).join('');
}

const ARROW_VARIANTS = ['default', 'emphasis', 'security', 'dashed'];
export const arrowRef = (p, variant) => `url(#${p}${variant === 'return' ? 'open' : `arrow-${variant}`})`;

function markers(p) {
  const marker = (id, body) => el('marker', {
    id: `${p}${id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9,
    markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse',
  }, body);
  return ARROW_VARIANTS.map(v => marker(`arrow-${v}`, el('path', { d: 'M0 0L10 5L0 10z', class: `dg-head ${VARIANT_CLASS(v)}` })))
    .join('') + marker('open', el('path', { d: 'M1 1L9 5L1 9', class: 'dg-open' }));
}

/** The root element, with an accessible title and description and the arrow markers. */
export function root({ p, type, title, desc, width, height, body }) {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  return `<svg${attrs({
    xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${w} ${h}`, width: w, height: h,
    role: 'img', 'aria-labelledby': `${p}title ${p}desc`, class: `dg dg-${type}`,
  })}>${el('title', { id: `${p}title` }, esc(title))}${el('desc', { id: `${p}desc` }, esc(desc))}`
    + `<defs>${markers(p)}</defs>${body}</svg>`;
}
