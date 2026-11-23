// Pin a diagram SVG to one colour scheme, so a <picture> element can pick the file.
const DARK_BLOCK = /@media \(prefers-color-scheme: dark\)\{(svg\.dg\{[^}]*\})\}/;

// GitHub's canvas colours: the page background follows the viewer's GitHub theme,
// not the OS, so each file carries its own solid background.
export const CANVAS = { light: '#ffffff', dark: '#0d1117' };

export function fixedTheme(svg, theme) {
  if (theme !== 'light' && theme !== 'dark') throw new Error(`unknown theme: ${theme}`);
  const m = DARK_BLOCK.exec(svg);
  if (!m) throw new Error('SVG has no dark prefers-color-scheme block; the diagram renderer changed');
  const pinned = svg.replace(DARK_BLOCK, theme === 'dark' ? m[1] : '');
  if (!pinned.includes('</style>')) throw new Error('SVG has no style element');
  return pinned.replace('</style>', `</style><rect width="100%" height="100%" fill="${CANVAS[theme]}"/>`);
}
