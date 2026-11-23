// Pin a diagram SVG to one colour scheme, so a <picture> element can pick the file.
const DARK_BLOCK = /@media \(prefers-color-scheme: dark\)\{(svg\.dg\{[^}]*\})\}/;

export function fixedTheme(svg, theme) {
  if (theme !== 'light' && theme !== 'dark') throw new Error(`unknown theme: ${theme}`);
  const m = DARK_BLOCK.exec(svg);
  if (!m) throw new Error('SVG has no dark prefers-color-scheme block; the diagram renderer changed');
  return svg.replace(DARK_BLOCK, theme === 'dark' ? m[1] : '');
}
