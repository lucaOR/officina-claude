// Renders a compact-row diagram ({type, title, rows}) to a static SVG and its stylesheet.
// No dependencies and no browser: text is measured from a width table, layout is computed.
import { parseRows, TYPES } from './rows.mjs';
import { stylesheet } from './style.mjs';
import { root } from './svg.mjs';
import { sequence } from './sequence.mjs';
import { workflow } from './workflow.mjs';
import { erd } from './erd.mjs';
import { state } from './state.mjs';
import { tree } from './tree.mjs';

export { TYPES, stylesheet };
export { loadPalette } from './palette.mjs';

const DRAW = { sequence, workflow, erd, state, tree };

/**
 * Renders `spec`. Every id in the SVG starts with `prefix`, so several diagrams can share a
 * page, and the stylesheet applies inside elements matching `scope`. Throws an Error naming
 * the bad row when the rows do not parse.
 * @returns {{svg: string, css: string, nodes: string[], boxes: {id: string, x: number, y: number, w: number, h: number, parent?: string}[], width: number, height: number}}
 */
export function render(spec, { prefix = 'dg-', scope = '.dg-host', style, palette } = {}) {
  const model = parseRows(spec?.type, spec?.rows);
  const drawn = DRAW[spec.type](model, { p: prefix });
  const svg = root({ p: prefix, type: spec.type, title: spec.title || spec.type, desc: drawn.desc, width: drawn.width, height: drawn.height, body: drawn.body });
  return { svg, css: stylesheet(scope, { style: style ?? spec.style, palette }), nodes: drawn.nodes, boxes: drawn.boxes, width: drawn.width, height: drawn.height };
}
