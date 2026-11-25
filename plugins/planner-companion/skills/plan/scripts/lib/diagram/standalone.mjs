import { render } from './index.mjs';

// Renders a spec to an SVG document that works on its own: the stylesheet sits inside the root,
// and its prefers-color-scheme rules pick light or dark from the system. The scope is the root
// itself, so the stylesheet's own .dg rules give it the font and the ink.
export function renderStandalone(spec, options = {}) {
  const { svg, css, nodes } = render(spec, { ...options, scope: 'svg.dg' });
  return { svg: svg.replace(/^<svg[^>]*>/, open => `${open}<style>${css}</style>`), nodes };
}
