// Default colours and the palette validator. A palette value ends up inside a stylesheet rule,
// so only hex and purely numeric rgb()/hsl() are accepted: no `;`, braces, quotes, url() or var().

export const TYPES = {
  frontend: ['#0891b2', '#22d3ee'],
  backend: ['#059669', '#34d399'],
  database: ['#7c3aed', '#a78bfa'],
  cloud: ['#d97706', '#fbbf24'],
  security: ['#e11d48', '#fb7185'],
  messagebus: ['#ea580c', '#fb923c'],
  external: ['#64748b', '#94a3b8'],
  focus: ['#c2410c', '#fb923c'],
};
export const THEME = {
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

const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)%?`;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = new RegExp(`^(?:rgb|hsl)a?\\(\\s*${NUM}(?:\\s*,\\s*${NUM}){2,3}\\s*\\)$|^(?:rgb|hsl)a?\\(\\s*${NUM}(?:\\s+${NUM}){2}(?:\\s*/\\s*${NUM})?\\s*\\)$`, 'i');
const colour = v => typeof v === 'string' && (HEX.test(v) || FUNC.test(v));

/**
 * Validates a palette ({key: colour | [light, dark]}) and returns {key: [light, dark]}. Keys are
 * the theme and node type names. Throws Error('palette <key>: invalid colour') on a bad value.
 */
export function loadPalette(obj) {
  if (obj === undefined || obj === null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('palette: expected an object of colours');
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!Object.hasOwn(THEME, key) && !Object.hasOwn(TYPES, key)) throw new Error(`palette ${key}: unknown key`);
    const pair = typeof value === 'string' ? [value, value] : value;
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(colour)) throw new Error(`palette ${key}: invalid colour`);
    out[key] = [...pair];
  }
  return out;
}
