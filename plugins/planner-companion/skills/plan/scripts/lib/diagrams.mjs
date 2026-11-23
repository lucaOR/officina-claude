// Renders a compact-row diagram through the vendored archify renderers.
// The renderers run as child processes, as archify's explainer/diagrams.mjs does,
// because the sequence and ERD renderers are CLI scripts with module-level state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const vendorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor/archify');
const TYPES = new Set(['sequence', 'workflow', 'erd']);
const SCOPE = '.pl-diagram';
const ATTRIBUTION = '/* Diagram styles adapted from archify (Apache-2.0 / MIT); see vendor/archify/NOTICE. */';
const MAX_BYTES = 32 * 1024 * 1024;

const vendoredLine = () => fs.readFileSync(path.join(vendorRoot, 'VENDORED'), 'utf8').trim();
const fail = error => ({ ok: false, error: String(error) });

function messageOf(error) {
  for (const raw of [error?.stdout, error?.stderr]) {
    try {
      const native = JSON.parse(raw);
      const text = (native.diagnostics || []).map(d => d.message).filter(Boolean).join('; ');
      if (text) return text;
    } catch { /* not JSON */ }
  }
  return String(error?.stderr || error?.message || error).trim().split('\n')[0] || 'render failed';
}

function selectorList(selector) {
  const parts = []; let depth = 0; let start = 0; let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) { if (c === quote && selector[i - 1] !== '\\') quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && !depth) { parts.push(selector.slice(start, i)); start = i + 1; }
  }
  return [...parts, selector.slice(start)];
}

// Adapted from archify explainer/render.mjs scopeNativeCss: rules are scoped under SCOPE,
// body/chrome rules and rules naming classes absent from the SVG are dropped, and theme
// variables follow the system colour scheme.
function scopeCss(styles, svg) {
  const css = styles.replace(/<style[^>]*>/gi, '').replace(/<\/style>/gi, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const present = new Set([...svg.matchAll(/\bclass="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)));
  const applies = value => [...value.replace(/:not\([^)]*\)/g, '').matchAll(/\.([A-Za-z_][\w-]*)/g)].every(m => present.has(m[1]));
  const defaults = []; const dark = []; const light = [];
  function rules(input, collectThemes = true) {
    let result = ''; let cursor = 0;
    while (cursor < input.length) {
      const opening = input.indexOf('{', cursor); if (opening < 0) break;
      const selector = input.slice(cursor, opening).trim(); let depth = 1; let end = opening + 1; let quote = '';
      for (; end < input.length && depth; end++) {
        const c = input[end];
        if (quote) { if (c === quote && input[end - 1] !== '\\') quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      const body = input.slice(opening + 1, end - 1); cursor = end;
      if (/^@(media|supports|layer)/.test(selector)) { result += `${selector}{${rules(body, false)}}`; continue; }
      if (selector.startsWith('@')) continue;
      const selectors = selectorList(selector).filter(v => !/(^|[\s>+~])body(?:\b|$)/.test(v) && applies(v)).map(v => {
        let next = v.trim().replace(/^:root|^html\b/, SCOPE);
        if (next.startsWith('[data-theme=')) next = SCOPE + next;
        return next.startsWith(SCOPE) ? next : `${SCOPE} ${next}`;
      });
      const roots = selectorList(selector).map(v => v.trim());
      if (collectThemes && roots.includes(':root')) defaults.push(body);
      if (collectThemes && roots.some(v => /^(?::root)?\[data-theme=["']?dark["']?\]$/.test(v))) dark.push(body);
      if (collectThemes && roots.some(v => /^(?::root)?\[data-theme=["']?light["']?\]$/.test(v))) light.push(body);
      if (selectors.length) result += `${selectors.join(',')}{${body}}`;
    }
    return result;
  }
  const scoped = rules(css);
  return scoped
    + (light.length ? `${SCOPE}:not([data-theme]){${light.join(';')}}` : '')
    + (dark.length ? `@media(prefers-color-scheme:dark){${SCOPE}:not([data-theme]){${dark.join(';')}}}` : '');
}

const escapeRe = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Per-diagram id prefix so several diagrams can share one page. Only id="..." attributes and
// their references (url(#x), href="#x", xlink:href="#x", CSS #x selectors) change; data-node-id
// and data-edge-id values stay raw.
function prefixIds(svg, css, prefix) {
  const ids = new Set([...svg.matchAll(/\sid="([^"]*)"/g)].map(m => m[1]));
  const swapUrl = text => text.replace(/url\(\s*(['"]?)#([^)'"\s]+)\1\s*\)/g,
    (all, q, id) => (ids.has(id) ? `url(${q}#${prefix}${id}${q})` : all));
  const outSvg = swapUrl(svg)
    .replace(/(\sid=")([^"]*)"/g, (_, a, id) => `${a}${prefix}${id}"`)
    .replace(/(\b(?:xlink:)?href=")#([^"]*)"/g, (all, a, id) => (ids.has(id) ? `${a}#${prefix}${id}"` : all));
  const outAria = outSvg.replace(/(\baria-(?:labelledby|describedby)=")([^"]*)"/g, (_, a, list) =>
    `${a}${list.split(/\s+/).map(id => (ids.has(id) ? prefix + id : id)).join(' ')}"`);
  const idRe = ids.size ? new RegExp(`#(${[...ids].map(escapeRe).join('|')})(?![\\w-])`, 'g') : null;
  const outCss = swapUrl(css).replace(/([^{}]*)\{/g, (all, selector) => (idRe
    ? `${selector.replace(idRe, (_, id) => `#${prefix}${id}`)}{` : all));
  return { svg: outAria, css: outCss };
}

export async function renderDiagram(spec, { cacheDir } = {}) {
  try {
    if (!spec || typeof spec !== 'object') return fail('diagram spec must be an object');
    if (!TYPES.has(spec.type)) return fail(`unsupported diagram type "${spec.type}"; use sequence, workflow or erd`);
    if (!Array.isArray(spec.rows) || !spec.rows.length) return fail('a diagram needs at least one row');
    const title = spec.title || spec.id || spec.type;

    const key = createHash('sha256').update(JSON.stringify([spec.type, title, spec.id, spec.rows, vendoredLine()])).digest('hex');
    const cacheFile = cacheDir ? path.join(cacheDir, `${key}.json`) : null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      try { return { ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')), cached: true }; } catch { /* re-render */ }
    }

    const { compileExplainerDiagram } = await import(path.join(vendorRoot, 'explainer/diagrams.mjs'));
    const model = compileExplainerDiagram(spec.type, spec.rows, { title, id: spec.id });
    model.meta = { ...model.meta, output: 'diagram.html' };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-diagram-'));
    try {
      const input = path.join(dir, 'diagram.json');
      const output = path.join(dir, 'diagram.html');
      fs.writeFileSync(input, JSON.stringify(model));
      const script = path.join(vendorRoot, 'renderers', spec.type, `render-${spec.type}.mjs`);
      await runFile(process.execPath, [script, input, output], { cwd: dir, maxBuffer: MAX_BYTES, timeout: 120000,
        env: { ...process.env, ARCHIFY_DIAGNOSTIC_FORMAT: 'json', ARCHIFY_QUALITY_PROFILE: 'showcase' } });
      const html = fs.readFileSync(output, 'utf8');
      const match = html.match(/<svg\b[^>]*\bdata-quality-profile="[^"]*"[^>]*>[\s\S]*?<\/svg>/);
      if (!match) return fail('the renderer produced no SVG');
      const svg = match[0];
      const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/g)].map(m => m[0]).join('\n');
      const nodes = [...new Set([...svg.matchAll(/data-node-id="([^"]*)"/g)].map(m => m[1]))];
      const prefix = `pl-${String(spec.id ?? spec.type).replace(/[^A-Za-z0-9_-]+/g, '-')}-`;
      const prefixed = prefixIds(svg, scopeCss(styles, svg), prefix);
      const result = { ok: true, svg: prefixed.svg, css: `${ATTRIBUTION}\n${prefixed.css}`, nodes };
      if (cacheFile) {
        fs.mkdirSync(cacheDir, { recursive: true });
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(result));
        fs.renameSync(tmp, cacheFile);
      }
      return { ...result, cached: false };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (error) {
    return fail(messageOf(error));
  }
}
