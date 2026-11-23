// The diagram stylesheet, every rule scoped under one selector. Colours follow the system
// colour scheme, and take the host page's --ink, --muted and --panel when it defines them.

const TYPES = {
  frontend: ['#0891b2', '#22d3ee'],
  backend: ['#059669', '#34d399'],
  database: ['#7c3aed', '#a78bfa'],
  cloud: ['#d97706', '#fbbf24'],
  security: ['#e11d48', '#fb7185'],
  messagebus: ['#ea580c', '#fb923c'],
  external: ['#64748b', '#94a3b8'],
};
const THEME = {
  ink: ['var(--ink, #1d1d1f)', 'var(--ink, #ececee)'],
  muted: ['var(--muted, #5b6474)', 'var(--muted, #9c9ca4)'],
  panel: ['var(--panel, #fff)', 'var(--panel, #1e1e21)'],
  line: ['#64748b', '#94a3b8'],
  lane: ['rgba(100, 116, 139, .06)', 'rgba(148, 163, 184, .06)'],
  rule: ['#cbd5e1', '#3b4250'],
  emphasis: ['#059669', '#34d399'],
  security: ['#e11d48', '#fb7185'],
  dashed: ['#7c3aed', '#a78bfa'],
};

const vars = scheme => [
  ...Object.entries(THEME).map(([k, v]) => `--dg-${k}:${v[scheme]}`),
  ...Object.entries(TYPES).map(([k, v]) => `--dg-${k}:${v[scheme]}`),
].join(';');

const RULES = [
  ['.dg', 'display:block;max-width:100%;height:auto;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif'],
  ['.dg text', 'fill:var(--dg-ink)'],
  ...Object.keys(TYPES).map(t => [`.t-${t}`, `--dg-t:var(--dg-${t})`]),
  ['.dg-node .dg-shape', 'fill:color-mix(in srgb, var(--dg-t) 12%, var(--dg-panel));stroke:var(--dg-t);stroke-width:1.5'],
  ['.dg-node-label', 'font-size:13px;font-weight:600'],
  ['.dg-lane rect', 'fill:var(--dg-lane);stroke:var(--dg-rule)'],
  ['.dg-lane text', 'fill:var(--dg-muted);font-size:12px;font-weight:600'],
  ['.dg-edge, .dg-msg, .dg-rel', 'fill:none;stroke:var(--dg-line);stroke-width:1.5'],
  ['.dg-edge.v-emphasis, .dg-msg.v-emphasis', 'stroke:var(--dg-emphasis);stroke-width:2'],
  ['.dg-edge.v-security, .dg-msg.v-security', 'stroke:var(--dg-security);stroke-dasharray:6 4'],
  ['.dg-edge.v-dashed, .dg-msg.v-dashed', 'stroke:var(--dg-dashed);stroke-dasharray:4 4'],
  ['.dg-msg.v-return', 'stroke-dasharray:4 4'],
  ['.dg-head', 'fill:var(--dg-line)'],
  ['.dg-head.v-emphasis', 'fill:var(--dg-emphasis)'],
  ['.dg-head.v-security', 'fill:var(--dg-security)'],
  ['.dg-head.v-dashed', 'fill:var(--dg-dashed)'],
  ['.dg-open', 'fill:none;stroke:var(--dg-line);stroke-width:1.5'],
  ['.dg-elabel rect', 'fill:var(--dg-panel);stroke:var(--dg-rule);stroke-width:.75'],
  ['.dg-elabel text', 'fill:var(--dg-muted);font-size:11px'],
  ['.dg-elabel.v-emphasis text', 'fill:var(--dg-emphasis)'],
  ['.dg-elabel.v-security text', 'fill:var(--dg-security)'],
  ['.dg-elabel.v-dashed text', 'fill:var(--dg-dashed)'],
  ['.dg-life', 'stroke:var(--dg-rule);stroke-dasharray:3 5'],
  ['.dg-band', 'fill:var(--dg-lane);stroke:var(--dg-rule);stroke-dasharray:6 5'],
  ['.dg-phase-label rect', 'fill:var(--dg-panel);stroke:var(--dg-rule)'],
  ['.dg-phase-label text', 'fill:var(--dg-muted);font-size:11px;font-weight:600'],
  ['.dg-head-band', 'fill:color-mix(in srgb, var(--dg-t) 16%, var(--dg-panel))'],
  ['.dg-entity .dg-shape', 'fill:var(--dg-panel);stroke:none'],
  ['.dg-outline', 'fill:none;stroke:var(--dg-t);stroke-width:1.5'],
  ['.dg-etitle', 'font-size:13px;font-weight:700'],
  ['.dg-zebra', 'fill:var(--dg-lane)'],
  ['.dg-field', 'font-size:12px'],
  ['.dg-field.dg-pk', 'font-weight:700'],
  ['.dg-ftype', 'fill:var(--dg-muted);font-size:11px'],
  ['.dg-key rect', 'stroke:none'],
  ['.dg-key text', 'font-size:9px;font-weight:700'],
  ['.k-pk rect', 'fill:color-mix(in srgb, var(--dg-database) 18%, var(--dg-panel))'],
  ['.k-pk text', 'fill:var(--dg-database)'],
  ['.k-fk rect', 'fill:color-mix(in srgb, var(--dg-messagebus) 18%, var(--dg-panel))'],
  ['.k-fk text', 'fill:var(--dg-messagebus)'],
  ['.k-uk rect', 'fill:none;stroke:var(--dg-rule);stroke-width:1'],
  ['.k-uk text', 'fill:var(--dg-muted)'],
  ['.dg-card', 'fill:none;stroke:var(--dg-line);stroke-width:1.5'],
];

// `.dg` as a whole class name, not the start of `.dg-node` or `.dg-host`.
const DG = /^\.dg(?![\w-])/;

/**
 * The stylesheet for diagrams placed inside elements matching `scope`. A scope that names the
 * `.dg` root itself (a standalone SVG's `svg.dg`) has no `.dg` element inside it, so a rule
 * rooted at `.dg` joins the scope instead of nesting under it: `.dg text` becomes
 * `svg.dg text`. Every other rule still nests, which keeps it more specific than those.
 */
export function stylesheet(scope) {
  const onRoot = /\.dg(?![\w-])/.test(scope);
  const scoped = selector => selector.split(',').map(s => s.trim())
    .map(s => (onRoot && DG.test(s) ? `${scope}${s.slice('.dg'.length)}` : `${scope} ${s}`)).join(',');
  return `${scope}{${vars(0)}}@media (prefers-color-scheme: dark){${scope}{${vars(1)}}}`
    + RULES.map(([selector, body]) => `${scoped(selector)}{${body}}`).join('');
}
