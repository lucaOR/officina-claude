// Renders a compact-row diagram for the plan page with the diagrams plugin's renderer.
// `./diagram` is a generated copy of it: node tools/sync-diagram.mjs refreshes it. Ids are
// prefixed per diagram, so several share one page, and the stylesheet is scoped under the
// page's diagram wrapper.
import { render, TYPES } from './diagram/index.mjs';

const SCOPE = '.pl-diagram';

/** @returns {{ok: true, svg: string, css: string, nodes: string[]} | {ok: false, error: string}} */
export function renderDiagram(spec) {
  if (!TYPES.includes(spec?.type)) return { ok: false, error: `diagram type must be one of ${TYPES.join(', ')}` };
  try {
    return { ok: true, ...render(spec, { prefix: `pl-${spec.id || 'diagram'}-`, scope: SCOPE }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
