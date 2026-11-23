// Compiled scripts must reach the environment ONLY through the lib, so a rename
// of anything the environment exposes stays a one-file edit. This lint keeps
// that true for the ways it can mechanically see, which is not all of them.
//
// WHAT THIS ENFORCES, and what it does not. The rules are TEXTUAL: they match
// literal shapes at the call site and in import specifiers. They do not parse
// the script, resolve a call graph, or know what any identifier refers to.
//
// The core rules (CORE_RULES, owner `core`):
//   - shebang, header, wrapper: the script has the executable first line, the
//     `// scenario: <id> compiled_from: <hash>` header with the current hash,
//     and a `scenario(` wrapper, so the lifecycle and exit contract apply.
//   - unterminated-comment: a `/*` never closed would hide the rest of the file.
//   - import-surface: a specifier under `_lib/` whose tail is not `index.mjs`
//     is refused, because the lever surface index.mjs re-exports is the only
//     sanctioned way in.
//   - ip-literal: a raw `host:port` IP endpoint written into the script.
//   - undeclared: a SCREAMING_SNAKE name used but never declared. An unexpected
//     Error classifies KO, so an authoring typo would read as a PRODUCT failure.
//   - unused: a name imported, or declared at column 0, and never used. It
//     keeps copied helpers from piling up. Textual, so it misses more than it
//     invents: a name that also appears inside a string reads as used.
// Technology rules come from the installed adapters (`lint` contributions) and
// project rules from the `lint.rules` hook; see allRules().
//
// RULE SHAPES (same as the extension contract):
//   { id, owner, kind: 'raw' | 'code', re, msg, mask? }   per line; `raw` tests
//       the line as written, comments included (a comment that names an
//       endpoint has leaked it); `code` tests the comment-stripped line. `re`
//       is one RegExp object shared by every line of every script, so a `g`
//       or `y` flag carries `lastIndex` from one test to the next: use one
//       only on purpose, as a per-file scanner (see linePass below).
//   { id, owner, kind: 'source', check(source, { id, hash, ctx }) -> string[] }
//   { id, owner, kind: 'matrix', check(reg) -> string[] }   once per CLI run.
//
// Lint-clean means "no known bypass shape is present", never "this script
// cannot reach the environment". Reviewing the script is still the guarantee.
import { existsSync, readFileSync } from 'node:fs';
import { contributions, hook } from './ext.mjs';
import { compiledFrom } from './hash.mjs';
import { SCRIPTS, isMain } from './paths.mjs';

export const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Both endpoint rules name the same accessors, because which one is correct
// depends on WHO dereferences the value, and an author who reaches for a
// literal is usually one who could not find the accessor for their case:
//   reg.host(alias)          a service's own host
//   reg.raw.stubs[name]      a stub at its host-published port, for what THIS
//                            harness fetches from the host
//   reg.stubInternal(name)   the same stub at its network alias, for a fixture
//                            value the PRODUCT's own process fetches
// The last one is not interchangeable with the second: a host-side address
// inside the product's namespace never arrives and nothing reports an error.
export const ENDPOINT_REMEDY = 'use reg.host(alias), reg.raw.stubs[name] for a HARNESS-side fetch, '
  + 'or reg.stubInternal(name) for a fixture value the PRODUCT container fetches';

const REGEX_MAY_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

// Returns a per-line detector: true when a line holds a match of `memberRe`
// inside a SINGLE- or DOUBLE-quoted string's content. A plain regex over the
// line cannot tell `" + x.y + "` as two string tokens joined by real `+`
// operators from the same text inside one string, because which one it is
// depends on which quote is currently open, and only a scan answers that. So
// the scanner walks a stack of open delimiters and only tests for a member
// while the top of the stack is a plain quote. A `${...}` inside a template
// literal pushes its own frame and counts as code. Static template-literal text
// is deliberately not checked.
//
// The stack is carried ACROSS lines (a multi-line template literal is common),
// so one detector is made per file and called once per line, in file order. It
// finishes scanning its line before reporting, so a bad line does not desync
// the lines after it. A regex literal is tracked and swallowed without touching
// the stack, the way stripComments() does, because `/'/g` holds a bare quote
// that is not a delimiter; regex-vs-division is decided by the last significant
// token. `memberRe` is used sticky, so matching starts exactly at the scan
// cursor while `\b` still sees the real characters before it.
export function stringLiteralScanner(memberRe) {
  const member = memberRe.sticky ? memberRe : new RegExp(memberRe.source, `${memberRe.flags.replace('g', '')}y`);
  const stack = [];
  let inRegex = false;
  let inClass = false;
  let lastSignificant = '';
  return function insideString(line) {
    let hit = false;
    for (let i = 0; i < line.length; i++) {
      const top = stack[stack.length - 1];
      const c = line[i];
      const c2 = line[i + 1];
      if (c === '\\' && c2 !== undefined && (top === "'" || top === '"' || top === '`' || inRegex)) { i++; continue; }
      if (top === "'" || top === '"') {
        member.lastIndex = i;
        if (member.test(line)) hit = true;
        if (c === top) stack.pop();
        continue;
      }
      if (top === '`') {
        if (c === '`') { stack.pop(); continue; }
        if (c === '$' && c2 === '{') { stack.push('{'); i++; }
        continue;
      }
      if (inRegex) {
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        if (c === '/' && !inClass) { inRegex = false; lastSignificant = '/'; }
        continue;
      }
      if (top === '{' && c === '}') { stack.pop(); continue; }
      if (c === "'" || c === '"' || c === '`') { stack.push(c); continue; }
      if (c === '/' && REGEX_MAY_FOLLOW.has(lastSignificant)) { inRegex = true; inClass = false; continue; }
      if (!/\s/.test(c)) lastSignificant = c;
    }
    return hit;
  };
}

export function stripComments(source, { blankStrings = false, blankRegex = false } = {}) {
  let out = '';
  let inLineComment = false;
  let inBlockComment = false;
  let stringChar = null;
  let inRegex = false;
  let inClass = false; // inside a [...] character class, where / is literal
  let line = 1;
  let blockStartLine = null;
  let lastSignificant = '';

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const c2 = source[i + 1];

    if (c === '\n') line++;

    if (inLineComment) {
      if (c === '\n') { inLineComment = false; out += c; } else { out += ' '; }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && c2 === '/') { inBlockComment = false; out += '  '; i++; }
      else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '\\' && c2 !== undefined) {
      const hide = (stringChar && blankStrings) || (inRegex && blankRegex);
      out += hide ? '  ' : c + c2;
      i++;
      continue;
    }
    if (stringChar) {
      const closing = c === stringChar;
      if (closing) stringChar = null;
      if (blankStrings && !closing) out += c === '\n' ? '\n' : ' ';
      else out += c;
      continue;
    }
    if (inRegex) {
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      const closing = c === '/' && !inClass;
      if (closing) { inRegex = false; lastSignificant = '/'; }
      if (blankRegex && !closing) out += c === '\n' ? '\n' : ' ';
      else out += c;
      continue;
    }
    if (c === '/' && c2 === '/') { inLineComment = true; out += '  '; i++; continue; }
    if (c === '/' && c2 === '*') { inBlockComment = true; blockStartLine = line; out += '  '; i++; continue; }
    if (c === '/' && REGEX_MAY_FOLLOW.has(lastSignificant)) { inRegex = true; inClass = false; out += c; continue; }
    if (c === "'" || c === '"' || c === '`') { stringChar = c; out += c; continue; }
    out += c;
    if (!/\s/.test(c)) lastSignificant = c;
  }
  return { code: out, unterminated: inBlockComment ? blockStartLine : null };
}

export function undeclaredIdentifiers(source) {
  const { code } = stripComments(source, { blankStrings: true, blankRegex: true });
  const free = code
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, ' ')
    .replace(/\b[A-Z][A-Z0-9_]{2,}\s*:/g, ' ');

  const declared = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim().split(/[=:]/)[0].trim();
      if (/^[A-Z][A-Z0-9_]{2,}$/.test(name)) declared.add(name);
    }
  }
  for (const m of code.matchAll(/\bimport\s+([A-Z][A-Z0-9_]{2,})\b/g)) declared.add(m[1]);

  const GLOBALS = new Set(['JSON', 'NaN', 'URL', 'URLSearchParams', 'Infinity', 'Buffer',
    'TextEncoder', 'TextDecoder', 'AbortController', 'Math', 'Date', 'Promise', 'Error']);

  const used = new Set();
  for (const m of free.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) used.add(m[1]);
  return [...used].filter(id => !declared.has(id) && !GLOBALS.has(id)).sort();
}

export function unusedDeclarations(source) {
  const { code } = stripComments(source);
  const lineOf = index => code.slice(0, index).split('\n').length;

  const imports = [];
  const importSpans = [];
  for (const m of code.matchAll(/^import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"]\s*;?/gm)) {
    importSpans.push([m.index, m.index + m[0].length]);
    const bodyStart = m.index + m[0].indexOf('{') + 1;
    for (const part of m[1].matchAll(/[^,]+/g)) {
      const name = part[0].trim().split(/\s+as\s+/).pop().trim();
      const at = bodyStart + part.index + part[0].length - part[0].trimStart().length;
      if (/^[A-Za-z_$][\w$]*$/.test(name)) imports.push({ name, line: lineOf(at), kind: 'import' });
    }
  }

  const declarations = [];
  for (const m of code.matchAll(/^(?:async[ \t]+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)\s*=/gm)) {
    declarations.push({ name: m[1] ?? m[2], line: lineOf(m.index), kind: 'declaration' });
  }

  let body = code;
  for (const [from, to] of importSpans) body = body.slice(0, from) + ' '.repeat(to - from) + body.slice(to);
  body = body.replace(/(?<!\.)\.\s*[A-Za-z_$][\w$]*/g, ' ');

  const count = name => [...body.matchAll(new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`, 'g'))].length;
  const unused = [
    ...imports.filter(d => count(d.name) === 0),
    ...declarations.filter(d => count(d.name) <= 1),
  ];
  return unused.sort((a, b) => a.line - b.line);
}

// Declaration order is report order. The two line rules sit in one run
// (ip-literal, then import-surface), which lintScript() applies line by line.
export const CORE_RULES = [
  {
    id: 'shebang', owner: 'core', kind: 'source',
    check: source => (source.split('\n')[0].startsWith('#!/usr/bin/env node') ? [] : ['missing shebang']),
  },
  {
    id: 'header', owner: 'core', kind: 'source',
    check(source, { id, hash }) {
      const header = /\/\/ scenario: (\S+) compiled_from: (\S+)/.exec(source);
      if (!header) return ['missing "// scenario: <id> compiled_from: <hash>" header'];
      const out = [];
      if (header[1] !== id) out.push(`header id ${header[1]} != ${id}`);
      if (hash && header[2] !== hash) out.push(`header compiled_from ${header[2]} != current ${hash} — recompile`);
      return out;
    },
  },
  {
    id: 'wrapper', owner: 'core', kind: 'source',
    check: source => (/\bscenario\(\s*['"]/.test(source) ? [] : ['no scenario() wrapper — lifecycle and exit contract would be bypassed']),
  },
  {
    id: 'unterminated-comment', owner: 'core', kind: 'source',
    check(source) {
      const { unterminated } = stripComments(source);
      return unterminated === null ? [] : [`${unterminated}: unterminated /* comment — malformed source, rest of file treated as one comment`];
    },
  },
  {
    // Both bracket forms an IPv6 endpoint takes, alongside the IPv4 dotted quad.
    id: 'ip-literal', owner: 'core', kind: 'raw',
    re: /https?:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d+)?/i,
    msg: `literal IP endpoint — ${ENDPOINT_REMEDY}`,
  },
  {
    id: 'import-surface', owner: 'core', kind: 'code',
    re: /['"][^'"]*_lib\/(?!index\.mjs['"])[^'"]*['"]/,
    msg: 'import bypasses _lib/index.mjs — import the lever from index.mjs (re-export it there if missing)',
  },
  {
    id: 'undeclared', owner: 'core', kind: 'source',
    check: source => undeclaredIdentifiers(source).map(name => `${name} is used but never imported or declared — would throw ReferenceError at run time, `
      + 'which the classifier reports as KO (a product failure)'),
  },
  {
    id: 'unused', owner: 'core', kind: 'source',
    check: source => unusedDeclarations(source).map(({ name, line, kind }) => (kind === 'import'
      ? `${line}: ${name} is imported but never used — AUTHORING § 7: no unused imports`
      : `${line}: top-level ${name} is declared but never used — delete it, a dead helper reads as an assert the row makes`)),
  },
];

// Core, then each installed adapter's `lint` contributions in adapter order,
// then the project's own rules from the `lint.rules` hook.
export function allRules(ctx = {}) {
  return [...CORE_RULES, ...contributions('lint'), ...hook('lint.rules', () => [])(ctx)];
}

export function lintScript(source, { id, hash, ctx = {}, rules = allRules(ctx) } = {}) {
  const problems = [];
  const lines = source.split('\n');
  const codeLines = stripComments(source).code.split('\n');

  const masked = (text, rule) => {
    if (!rule.mask) return text;
    rule.mask.lastIndex = 0;
    return text.replace(rule.mask, '');
  };

  // A run of consecutive line rules is applied together, line by line, so a
  // stateful `re.test` (a per-file scanner) sees the lines in file order and
  // the problems of one line come out in declaration order.
  const linePass = run => lines.forEach((line, i) => {
    for (const rule of run) {
      const text = rule.kind === 'raw' ? line : (codeLines[i] ?? '');
      if (rule.re.test(masked(text, rule))) problems.push(`${i + 1}: ${rule.msg}`);
    }
  });

  let run = [];
  const flush = () => { if (run.length) linePass(run); run = []; };
  for (const rule of rules) {
    if (rule.kind === 'raw' || rule.kind === 'code') { run.push(rule); continue; }
    if (rule.kind !== 'source') continue; // matrix rules belong to the CLI
    flush();
    problems.push(...rule.check(source, { id, hash, ctx }));
  }
  flush();
  return problems;
}

// The lines the CLI prints: the matrix rules once, then each row's script
// problems prefixed with the row id. A row with no compiled script is skipped.
export function lintEpic(reg, { epic = reg.epic, only, ctx = {}, rules = allRules(ctx), scriptsDir = SCRIPTS } = {}) {
  const out = [];
  for (const rule of rules) {
    if (rule.kind === 'matrix') out.push(...rule.check(reg));
  }
  for (const row of reg.rows) {
    if (only && row.id !== only) continue;
    const path = `${scriptsDir}/${epic}/${row.id}.mjs`;
    if (!existsSync(path)) continue;
    const problems = lintScript(readFileSync(path, 'utf8'), { id: row.id, hash: compiledFrom(row), ctx, rules });
    for (const p of problems) out.push(`${row.id}: ${p}`);
  }
  return out;
}

// Not awaited at the top level: a project rule may import this module's scanner
// helpers from its hooks.mjs, which puts this module in an import cycle with
// hooks.mjs, and a top-level await inside a cycle never settles. A matrix that
// cannot be linted at all (an unknown epic, a hook that throws) exits 1, as it
// always did, with its message as one line instead of a stack.
if (isMain(import.meta.url)) {
  import('./registry.mjs').then(({ loadRegistry }) => {
    const [, , epic, only] = process.argv;
    const reg = loadRegistry(epic);
    const ctx = hook('lint.context', () => ({}))(reg.raw);
    const out = lintEpic(reg, { epic, only, ctx });
    for (const line of out) console.log(line);
    console.log(out.length === 0 ? 'lint: clean' : `lint: ${out.length} problem(s)`);
    process.exit(out.length === 0 ? 0 : 1);
  }).catch(err => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
