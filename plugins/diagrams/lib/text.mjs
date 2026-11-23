// Text measuring without a browser. Widths come from the Helvetica advance widths
// (1/1000 em, printable ASCII), which the system UI fonts the diagrams use are close to.
// The result is scaled up a little, so an estimate errs towards a box that is too wide.

const ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space to /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 to ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ to O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P to _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` to o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p to ~
];

const SAFETY = 1.06;
const BOLD = 1.1;
const COMBINING = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︀-️︠-︯]/;
const FULL_WIDTH = /[ᄀ-ᅟ⺀-〿぀-㏿㐀-䶿一-鿿가-힯豈-﫿＀-｠￠-￦]|\p{Extended_Pictographic}/u;

function advance(ch) {
  const code = ch.codePointAt(0);
  if (code >= 32 && code <= 126) return ASCII[code - 32];
  if (COMBINING.test(ch)) return 0;
  if (FULL_WIDTH.test(ch) || code > 0xffff) return 1000;
  return 600;
}

/** Estimated width in px of `text` set at `size` px. */
export function textWidth(text, size, bold = false) {
  let units = 0;
  for (const ch of String(text)) units += advance(ch);
  return (units / 1000) * size * SAFETY * (bold ? BOLD : 1);
}

/** Greedy word wrap: lines no wider than `width`, except a single word that is wider on its own. */
export function wrap(text, width, size, bold = false) {
  const lines = [];
  let line = '';
  for (const word of String(text).trim().split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size, bold) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  return line ? [...lines, line] : lines;
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ENTITIES[c]);
