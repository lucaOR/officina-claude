import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'diagram.mjs');
const WF = { type: 'workflow', title: 'Accept', rows: [['api', 'Start'], ['db', 'Store', 'database'], ['api > db', 'writes']] };

function spec(content) {
  const dir = mkdtempSync(join(tmpdir(), 'diagram-cli-'));
  const file = join(dir, 'flow.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
const run = (...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8' });

test('renders a page next to the spec and prints a short summary', () => {
  const file = spec(WF);
  const r = run(file);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, { ok: true, out: file.replace(/\.json$/, '.html'), nodes: ['api', 'db'] });
  const html = readFileSync(out.out, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Accept<\/title>/);
  assert.match(html, /<div class="dg-host"><svg /);
  assert.match(html, /\.dg-host \.dg-node/);
});

test('--out with .svg writes a standalone svg with its styles inside', () => {
  const file = spec(WF);
  const target = join(dirname(file), 'out.svg');
  const r = run(file, '--out', target);
  assert.equal(r.status, 0, r.stderr);
  const svg = readFileSync(target, 'utf8');
  assert.match(svg, /^<svg [^>]*><style>svg\.dg\{/);
  assert.match(svg, /svg\.dg \.dg-node \.dg-shape\{/);
});

test('--out with .svg styles the root itself, so its text takes the theme ink', () => {
  const file = spec(WF);
  const target = join(dirname(file), 'out.svg');
  assert.equal(run(file, '--out', target).status, 0);
  const svg = readFileSync(target, 'utf8');
  assert.match(svg, /^<svg [^>]*class="dg dg-workflow"/);
  // The root is the svg.dg element, so a rule that needs a .dg element inside it matches nothing.
  assert.match(svg, /[{}]svg\.dg text\{fill:var\(--dg-ink\)\}/);
  assert.match(svg, /[{}]svg\.dg\{display:block;[^}]*font-family:/);
  assert.doesNotMatch(svg, /svg\.dg \.dg[\s{,]/);
});

test('bad rows fail with the row named and write nothing', () => {
  const file = spec({ ...WF, rows: [['api', 'Start'], ['api > missing']] });
  const r = run(file);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /Row 2: .*missing/);
  assert.equal(existsSync(file.replace(/\.json$/, '.html')), false);
});

test('an unreadable spec fails with a message', () => {
  const r = run(spec('{not json'));
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /cannot read spec/);
});

test('--help prints the usage', () => {
  const out = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(out, /diagram\.mjs <spec\.json> \[--out <file\.html\|file\.svg>\]/);
});

function palette(content) {
  const file = join(mkdtempSync(join(tmpdir(), 'diagram-pal-')), 'palette.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
}
const WFF = { ...WF, rows: [...WF.rows, ['x', 'Focus', 'focus']] };

test('the CLI rejects a bad palette, names the key and writes nothing', () => {
  const file = spec(WF);
  const r = run(file, '--palette', palette({ ink: 'rgb(0;}x{)' }));
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /palette ink: invalid colour/);
  assert.equal(existsSync(file.replace(/\.json$/, '.html')), false);
});

test('--palette and --style reach the page; flags override spec.style', () => {
  const file = spec({ ...WFF, style: 'editorial' });
  const page = file.replace(/\.json$/, '.html');
  let r = run(file, '--palette', palette({ focus: '#123456' }));
  assert.equal(r.status, 0, r.stderr);
  let html = readFileSync(page, 'utf8');
  assert.match(html, /--dg-focus:#123456/);
  assert.match(html, /stroke:var\(--dg-line\);stroke-width:1\}/);
  r = run(file, '--style', 'default');
  assert.equal(r.status, 0, r.stderr);
  html = readFileSync(page, 'utf8');
  assert.doesNotMatch(html, /stroke:var\(--dg-line\);stroke-width:1\}/);
  r = run(file, '--style', 'fancy');
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /style/);
});

test('an unreadable palette file fails with a message', () => {
  const r = run(spec(WF), '--palette', '/nonexistent/p.json');
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /cannot read palette/);
});
