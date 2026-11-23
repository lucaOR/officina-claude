#!/usr/bin/env node
// Renders a diagram spec ({"type", "title", "rows"}) to a standalone page or SVG file and
// prints a one-line JSON summary: {"ok":true,"out":<file>,"nodes":[...]} or {"ok":false,"error"}.
import fs from 'node:fs';
import { render, stylesheet } from '../lib/index.mjs';
import { esc } from '../lib/text.mjs';

const USAGE = 'usage: diagram.mjs <spec.json> [--out <file.html|file.svg>]\n'
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
const file = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
if (!file || (outAt >= 0 && !out)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

let spec;
try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) { done({ ok: false, error: `cannot read spec: ${e.message}` }, 1); }

const target = out || file.replace(/(\.json)?$/, '.html');
const title = esc(spec?.title || spec?.type || 'Diagram');
try {
  if (target.endsWith('.svg')) {
    const { svg, css, nodes } = render(spec, { scope: 'svg.dg' });
    fs.writeFileSync(target, svg.replace(/^<svg[^>]*>/, open => `${open}<style>svg.dg{${FONT}}${css}</style>`));
    done({ ok: true, out: target, nodes }, 0);
  }
  const { svg, nodes } = render(spec);
  const page = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title}</title><style>`
    + `body{margin:0;padding:24px 16px;background:#f6f6f3;color:#1d1d1f;${FONT}}`
    + '@media (prefers-color-scheme: dark){body{background:#141416;color:#ececee}}'
    + 'h1{font-size:20px;margin:0 0 16px}'
    + `${stylesheet('.dg-host')}</style></head>`
    + `<body><h1>${title}</h1><div class="dg-host">${svg}</div></body></html>\n`;
  fs.writeFileSync(target, page);
  done({ ok: true, out: target, nodes }, 0);
} catch (e) {
  done({ ok: false, error: e.message }, 1);
}
