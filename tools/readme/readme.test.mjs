import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET } from './shots.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const assets = path.join(root, '.github', 'assets');
const DOCS = ['README.md', 'CONTRIBUTING.md'];
const SOCIAL = 'social-preview.png';
const TERMS_FILE = path.join(root, '.project-terms');

function doc(name) {
  const file = path.join(root, name);
  assert.ok(fs.existsSync(file), `${name} is missing`);
  return fs.readFileSync(file, 'utf8');
}

// Fenced code blocks are shown literally, so a link-like string inside one is not a link.
const prose = (md) => md.replace(/^```[\s\S]*?^```/gm, '');

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function targets(md) {
  const text = prose(md);
  return [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1]),
  ];
}

// GitHub's heading anchors: lowercase, drop everything but letters, digits, spaces, hyphens
// (and underscores, which GitHub keeps too), then turn each space into a hyphen.
const slug = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
const headings = (md) => [...prose(md).matchAll(/^#{1,6} +(.+?) *#* *$/gm)].map((m) => slug(m[1]));

const marketplace = () => JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));

test('every local link and image exists', () => {
  for (const name of DOCS) {
    const missing = targets(doc(name))
      .filter((t) => !/^(https?:|mailto:|#)/.test(t))
      .map((t) => decodeURIComponent(t.split('#')[0]))
      .filter((t) => !fs.existsSync(path.resolve(root, path.dirname(name), t)));
    assert.deepEqual(missing, [], `${name} links to files that do not exist`);
  }
});

test('every anchor link matches a heading', () => {
  for (const name of DOCS) {
    const broken = [];
    for (const t of targets(doc(name))) {
      const m = t.match(/^([^#:]*\.md)?#(.+)$/);
      if (!m) continue;
      const file = m[1] ?? name;
      if (!headings(doc(file)).includes(decodeURIComponent(m[2]))) broken.push(t);
    }
    assert.deepEqual(broken, [], `${name} has anchors with no matching heading`);
  }
});

test('README has a section for every marketplace plugin', () => {
  const readme = doc('README.md');
  const missing = marketplace().plugins.map((p) => p.name)
    .filter((n) => !new RegExp(`^### \`${n}\`$`, 'm').test(readme));
  assert.deepEqual(missing, []);
});

test('plugins badge counts the marketplace plugins', () => {
  const n = marketplace().plugins.length;
  assert.ok(doc('README.md').includes(`img.shields.io/badge/plugins-${n}-`), `no plugins-${n} badge`);
});

test('every picture has a dark source and a light fallback', () => {
  const pictures = [...doc('README.md').matchAll(/<picture>([\s\S]*?)<\/picture>/g)].map((m) => m[1]);
  assert.ok(pictures.length > 0, 'README has no <picture>');
  for (const p of pictures) {
    const dark = p.match(/<source\b[^>]*\bmedia="\(prefers-color-scheme: dark\)"[^>]*\bsrcset="([^"]+)"/)?.[1];
    const img = p.match(/<img\b[^>]*>/)?.[0];
    const light = img?.match(/\bsrc="([^"]+)"/)?.[1];
    assert.match(dark ?? '', /-dark\.\w+$/, `dark source in ${p.trim()}`);
    assert.match(light ?? '', /-light\.\w+$/, `light fallback in ${p.trim()}`);
    assert.equal(dark.replace(/-dark(\.\w+)$/, '-light$1'), light, 'the dark and light files are not a pair');
    assert.match(img.match(/\balt="([^"]*)"/)?.[1] ?? '', /\S/, `no alt text on ${light}`);
  }
});

test('README assets stay under budget', () => {
  const total = walk(assets)
    .filter((f) => path.relative(assets, f) !== SOCIAL)
    .reduce((sum, f) => sum + fs.statSync(f).size, 0);
  assert.ok(total < BUDGET, `${total} bytes under .github/assets, budget ${BUDGET}`);
});

test('no project term appears in docs or asset sources', { skip: !fs.existsSync(TERMS_FILE) }, () => {
  const terms = fs.readFileSync(TERMS_FILE, 'utf8').split('\n')
    .map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = terms.map((t) => new RegExp(`\\b${esc(t)}\\b`, 'i'));
  const files = [
    ...DOCS.map((d) => path.join(root, d)).filter((f) => fs.existsSync(f)),
    ...walk(assets).filter((f) => /\.(svg|json|html)$/.test(f)),
  ];
  // Report file and line only: the terms themselves must never reach a public CI log.
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (res.some((re) => re.test(line))) hits.push(`${path.relative(root, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'project terms found; open these lines to see which');
});
