import { CANVAS } from './themes.mjs';

// The README logo: the Claude Code mascot in pixel art, in a yellow hard hat, holding a wrench.
// Each grid character is one square pixel; the SVG is transparent, so the eyes show the page colour.
export const LOGO_ROWS = [
  '.....yyyYYyyy......',
  '....yyyyYYyyyy.....',
  '...yyyyyYYyyyyy....',
  '.YYYYYYYYYYYYYYYY..',
  '...oooooooooooo....',
  '...oooooooooooo.g.g',
  '...oo.oooooo.oo.ggg',
  '...oo.oooooo.oo..g.',
  '.oooooooooooooooog.',
  '.oooooooooooooooog.',
  '...oooooooooooo..g.',
  '...oooooooooooo....',
  '....o.o....o.o.....',
  '....o.o....o.o.....',
];

export const LOGO_COLOURS = { o: '#D97757', y: '#F2B33D', Y: '#D9962A', g: '#8C96A3' };

export function logoSvg() {
  const w = LOGO_ROWS[0].length;
  const h = LOGO_ROWS.length;
  const rects = [];
  LOGO_ROWS.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const c = row[x];
      let end = x;
      while (end < row.length && row[end] === c) end++;
      if (c !== '.') rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${LOGO_COLOURS[c]}"/>`);
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="266" height="196" shape-rendering="crispEdges" role="img" aria-label="officina-claude logo: the Claude Code mascot in pixel art, wearing a yellow hard hat and holding a wrench">\n${rects.join('\n')}\n</svg>\n`;
}

// The title under the logo, as in the old banner: "officina" in the theme ink, "-claude" in
// terracotta. GitHub strips colour from HTML text, so it is an SVG, one file per theme. It bakes in
// the GitHub canvas, because a <picture> follows the OS scheme while GitHub may show the other theme.
// 760 units leave about 20 spare on each side of DejaVu Sans Bold (720 wide), the widest fallback.
const INK = { light: '#1d1d1f', dark: '#e6edf3' };

export function wordmarkSvg(theme) {
  if (!(theme in INK)) throw new Error(`unknown theme: ${theme}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 112" width="760" height="112" role="img" aria-label="officina-claude">\n<rect width="760" height="112" fill="${CANVAS[theme]}"/>\n<text x="380" y="82" text-anchor="middle" fill="${INK[theme]}" style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:88px;font-weight:700;letter-spacing:-1px">officina<tspan fill="#D97757">-claude</tspan></text>\n</svg>\n`;
}
