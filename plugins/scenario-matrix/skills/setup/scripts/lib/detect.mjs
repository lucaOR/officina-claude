import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const SKIPPED_DIRS = new Set(['node_modules', 'vendor', '.git']);
const MAX_DEPTH = 2; // directories below the repo root
const SCENARIOS = '.claude/scenarios';
const LIB = `${SCENARIOS}/_lib`;
const RUNNABLE_NAME = /up|down|start|stop|seed|dump|restore|reset|baseline/i;
const MANIFEST = `${LIB}/.plugin-manifest.json`;

// Anchored at the repo root: `*` stays inside one segment, `**/` spans zero or more directories.
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// An unreadable directory (a root-owned data dir, say) has nothing to detect, so it lists as empty.
const listDir = dir => {
  try { return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
};

// Repo-relative POSIX paths of every file the signals may look at.
function walk(repo) {
  const files = [];
  const visit = (rel, depth) => {
    for (const entry of listDir(join(repo, rel))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && depth < MAX_DEPTH) visit(path, depth + 1);
      } else files.push(path);
    }
  };
  visit('', 0);
  // The harness lib sits deeper than the limit, but its own manifest is a signal source.
  if (existsSync(join(repo, LIB))) {
    for (const entry of listDir(join(repo, LIB))) if (!entry.isDirectory()) files.push(`${LIB}/${entry.name}`);
  }
  return files;
}

const readText = (repo, file) => readFileSync(join(repo, file), 'utf8');
const readTextOrEmpty = (repo, file) => { try { return readText(repo, file); } catch { return ''; } };
const lineOf = (text, re) => {
  const i = text.split('\n').findIndex(l => re.test(l));
  return i < 0 ? null : i + 1;
};
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dependencyNames(json) {
  return ['dependencies', 'devDependencies', 'require', 'require-dev']
    .flatMap(section => (json?.[section] && typeof json[section] === 'object' ? Object.keys(json[section]) : []));
}

// One line of a block mapping: its indent, its key and what follows the colon. A key is plain,
// "double-quoted" or 'single-quoted'.
const KEY_LINE = /^( *)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{},?|>!&*%@`-][^#]*?|-[^\s#'"][^#]*?)[ \t]*:(?:[ \t]+(.*))?$/;
// What may follow a key whose value is the indented block below it: nothing, a comment, an anchor or a tag.
const OPENS_BLOCK = /^(?:[&!]\S*[ \t]*)*(?:#.*)?$/;

function unquote(key) {
  if (key.startsWith("'")) return key.slice(1, -1).replace(/''/g, "'");
  if (key.startsWith('"')) { try { return JSON.parse(key); } catch { return key.slice(1, -1); } }
  return key;
}

// Every line that holds content, as { indent, key, rest, line }; `key` is null for content that is
// not a mapping entry (a list item, a scalar line). Blank lines, comments and document markers hold none.
function contentLines(text) {
  return text.split(/\r?\n/).flatMap((raw, i) => {
    if (/^\s*(?:#.*)?$/.test(raw) || /^(?:---|\.\.\.)(?:\s.*)?$/.test(raw)) return [];
    const m = KEY_LINE.exec(raw);
    if (!m) return [{ indent: raw.length - raw.trimStart().length, key: null, rest: '', line: i + 1 }];
    return [{ indent: m[1].length, key: unquote(m[2]), rest: (m[3] ?? '').trim(), line: i + 1 }];
  });
}

// The entries directly under lines[at]: the first content line below it sets their indent, and the
// block ends at the first content line indented no deeper than lines[at]. Deeper lines (nested maps,
// block scalars) are skipped.
function childrenOf(lines, at) {
  const out = [];
  let indent = null;
  for (let j = at + 1; j < lines.length && lines[j].indent > lines[at].indent; j++) {
    indent ??= lines[j].indent;
    if (lines[j].indent === indent && lines[j].key !== null) out.push(j);
  }
  return out;
}

// The keys of `infra.env_registry` of one matrix, each with the line it sits on. This is a scan by
// indentation, not a YAML parse, so setup.mjs needs no npm package and runs from an installed plugin,
// which has no node_modules. It reads block style, which is how matrices are written; a flow-style
// `infra` or `env_registry` yields no keys, and detect then simply lacks that one piece of evidence.
function registryKeys(repo, file) {
  let text;
  try { text = readText(repo, file); } catch { return []; }
  const lines = contentLines(text);
  const opened = (at, key) => lines[at].key === key && OPENS_BLOCK.test(lines[at].rest);
  const infra = lines.findLastIndex((l, at) => l.indent === 0 && opened(at, 'infra'));
  if (infra < 0) return [];
  const registry = childrenOf(lines, infra).findLast(at => opened(at, 'env_registry'));
  if (registry === undefined) return [];
  return childrenOf(lines, registry).map(at => ({ key: lines[at].key, line: lines[at].line }));
}

function evidenceFor(signal, ctx) {
  const { repo, files } = ctx;
  const matching = glob => files.filter(f => globToRegExp(glob).test(f));
  switch (signal.kind) {
    case 'always':
      return [{ file: null, line: null, signal: 'always' }];
    case 'file':
      return matching(signal.glob).map(file => ({ file, line: null, signal: `file ${signal.glob}` }));
    case 'line': {
      const re = new RegExp(signal.regex);
      return matching(signal.glob).flatMap(file => {
        const line = lineOf(readTextOrEmpty(repo, file), re);
        return line === null ? [] : [{ file, line, signal: `line ${signal.glob} /${signal.regex}/` }];
      });
    }
    case 'dep': {
      const re = new RegExp(signal.name);
      return matching(signal.manifest).flatMap(file => {
        let text, json;
        try { text = readText(repo, file); json = JSON.parse(text); } catch { return []; }
        return dependencyNames(json).filter(n => re.test(n)).map(name => ({
          file,
          line: lineOf(text, new RegExp(`"${escapeRe(name)}"`)),
          signal: `dep ${signal.manifest} ${name}`,
        }));
      });
    }
    case 'registryKey':
      return ctx.registries().filter(r => r.key === signal.key).map(r => ({ file: r.file, line: r.line, signal: `registryKey ${signal.key}` }));
    default:
      return [];
  }
}

function listTree(repo, rel) {
  const root = join(repo, rel);
  if (!existsSync(root)) return [];
  const out = [];
  const visit = dir => {
    for (const entry of listDir(join(root, dir))) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') visit(path); } else out.push(path);
    }
  };
  visit('');
  return out;
}

function inventory(repo, files) {
  const matrices = files.filter(f => /^\.claude\/scenarios\/[^/]+\.yaml$/.test(f)).map(f => basename(f));
  const libFiles = files.filter(f => f.startsWith(`${LIB}/`)).map(f => basename(f)).filter(n => n !== '.plugin-manifest.json').sort();
  let packageScripts = [];
  if (files.includes('package.json')) {
    try { packageScripts = Object.keys(JSON.parse(readText(repo, 'package.json')).scripts ?? {}); } catch { /* an unreadable manifest has no scripts */ }
  }
  const makefile = files.find(f => f === 'Makefile');
  const makeTargets = makefile ? [...readTextOrEmpty(repo, makefile).matchAll(/^([A-Za-z0-9_][A-Za-z0-9_./-]*)\s*:(?!=)/gm)].map(m => m[1]) : [];
  const scriptFiles = files.filter(f => !f.startsWith('.claude/') && /\.sh$/.test(f) && RUNNABLE_NAME.test(basename(f)));
  return {
    harness: { libFiles, matrices, scripts: listTree(repo, `${SCENARIOS}/_scripts`), infra: listTree(repo, `${SCENARIOS}/_infra`) },
    compose: files.filter(f => /(^|\/|-)compose[^/]*\.ya?ml$/.test(f)),
    scripts: [...scriptFiles, ...packageScripts.map(name => `npm run ${name}`)],
    makeTargets,
    loginState: files.find(f => /storage[-_]?state[^/]*\.json$/i.test(f)) ?? null,
  };
}

export function detect(repo, catalog) {
  const mode = !existsSync(join(repo, LIB)) ? 'fresh' : existsSync(join(repo, MANIFEST)) ? 'upgrade' : 'adopt';
  const files = walk(repo);
  let cache;
  const registries = () => (cache ??= files
    .filter(f => /^\.claude\/scenarios\/[^/]+\.yaml$/.test(f))
    .flatMap(file => registryKeys(repo, file).map(k => ({ ...k, file }))));
  const ctx = { repo, files, registries };
  const adapters = [];
  for (const [name, adapter] of catalog.adapters) {
    const evidence = (adapter.detect ?? []).flatMap(signal => evidenceFor(signal, ctx));
    if (evidence.length) adapters.push({ name, evidence });
  }
  return { mode, adapters, assets: inventory(repo, files) };
}
