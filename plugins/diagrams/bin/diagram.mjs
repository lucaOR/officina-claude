#!/usr/bin/env node
// Renders a diagram spec ({"type", "title", "rows"}) to a standalone page or SVG file and
// prints a one-line JSON summary: {"ok":true,"out":<file>,"nodes":[...]} or {"ok":false,"error"}.
import fs from 'node:fs';
import { render } from '../lib/index.mjs';
import { esc } from '../lib/text.mjs';

const USAGE = 'usage: diagram.mjs <spec.json> [--out <file.html|file.svg>] [--style <default|editorial>] [--palette <file.json>]\n'
  + 'Renders a sequence, workflow or erd spec. The default output is the spec path with .html.\n';
const FONT = 'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

const done = (result, code) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(code);
};

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const flag = name => { const at = args.indexOf(name); return at >= 0 ? { at, value: args[at + 1] } : undefined; };
const styleFlag = flag('--style');
const paletteFlag = flag('--palette');
const taken = new Set([outAt, styleFlag?.at, paletteFlag?.at].filter(n => n >= 0).map(n => n + 1));
const file = args.find((a, i) => !a.startsWith('--') && !taken.has(i));
if (!file || (outAt >= 0 && !out) || (styleFlag && !styleFlag.value) || (paletteFlag && !paletteFlag.value)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

let spec;
try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { done({ ok: false, error: `cannot read spec: ${e.message}` }, 1); }

let palette;
if (paletteFlag) {
  try { palette = JSON.parse(fs.readFileSync(paletteFlag.value, 'utf8')); }
  catch (e) { done({ ok: false, error: `cannot read palette: ${e.message}` }, 1); }
}
// One code path: render() validates the style and the palette, whichever way they arrived.
const options = { palette, style: styleFlag?.value };

const target = out || file.replace(/(\.json)?$/, '.html');
const title = esc(spec?.title || spec?.type || 'Diagram');
try {
  if (target.endsWith('.svg')) {
    const { svg, css, nodes } = render(spec, { ...options, scope: 'svg.dg' });
    // The scope is the root itself, so the stylesheet's own .dg rules give it the font.
    fs.writeFileSync(target, svg.replace(/^<svg[^>]*>/, open => `${open}<style>${css}</style>`));
    done({ ok: true, out: target, nodes }, 0);
  }
  const { svg, css, nodes } = render(spec, options);
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title}</title><style>`
    + `body{margin:0;padding:24px 16px;background:#f6f6f3;color:#1d1d1f;${FONT}}`
    + '@media (prefers-color-scheme: dark){body{background:#141416;color:#ececee}}'
    + 'h1{font-size:20px;margin:0 0 16px}'
    + `${css}</style></head>`
    + `<body><h1>${title}</h1><div class="dg-host">${svg}</div></body></html>\n`;
  fs.writeFileSync(target, page);
  done({ ok: true, out: target, nodes }, 0);
} catch (e) {
  done({ ok: false, error: e.message }, 1);
}
