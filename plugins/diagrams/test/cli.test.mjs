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
