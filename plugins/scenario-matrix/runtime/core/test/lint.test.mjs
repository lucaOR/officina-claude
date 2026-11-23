import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { lintScript, lintEpic, allRules, CORE_RULES, stringLiteralScanner, unusedDeclarations } from '../lint.mjs';
import { compiledFrom } from '../hash.mjs';
import { __setForTest } from '../ext.mjs';

const HEAD = '#!/usr/bin/env node\n// scenario: B-06 compiled_from: abc123abc123\n';
const GOOD = `${HEAD}import { scenario, read } from '../../_lib/index.mjs';\nawait scenario('B-06', async () => { await read('SELECT 1'); });\n`;
const OPTS = { id: 'B-06', hash: 'abc123abc123' };
// The core rules alone, so adapter and project rules installed in the scratch
// project never change what these cases see.
const lint = (source, extra = {}) => lintScript(source, { ...OPTS, rules: CORE_RULES, ...extra });

test('a clean script lints clean', () => {
  assert.deepEqual(lint(GOOD), []);
});

test('a missing scenario() wrapper is rejected', () => {
  assert.match(lint(`${HEAD}console.log('hi')\n`).join(), /scenario\(\) wrapper/);
});

test('a header hash mismatch is rejected', () => {
  assert.match(lint(GOOD, { hash: 'zzz999zzz999' }).join(), /compiled_from/);
});

test('a header naming another id is rejected', () => {
  assert.match(lint(GOOD, { id: 'B-07' }).join(), /header id B-06 != B-07/);
});

test('a missing header is rejected', () => {
  assert.match(lint(GOOD.replace(/\/\/ scenario:.*\n/, '')).join(), /missing "\/\/ scenario/);
});

test('a missing shebang is rejected', () => {
  assert.match(lint(GOOD.replace('#!/usr/bin/env node\n', '')).join(), /missing shebang/);
});

test('line numbers survive a multi-line block comment for a line rule firing after it', () => {
  const bad = `${GOOD}\n/* line A of the comment\n   line B of the comment\n*/\nconst u = 'http://10.0.0.5:9280';\n`;
  const at = bad.split('\n').findIndex(l => l.includes('10.0.0.5')) + 1;
  const problems = lint(bad);
  assert.ok(problems.some(p => p.startsWith(`${at}: literal IP endpoint`)), JSON.stringify(problems));
});

// stripComments(): the comment scan must not be fooled by slashes inside
// strings or regex literals, because a false comment hides real code from the
// code rules and a missed one invents problems.

test('a code rule still fires after a URL string on the same line, whose slashes are not a comment', () => {
  const bad = `${GOOD}\nconst u = 'https://example.test/x'; import('../../_lib/db.mjs');\n`;
  assert.match(lint(bad).join(), /bypasses _lib\/index\.mjs/);
});

test('an import-surface mention inside a comment lints clean, trailing or block', () => {
  const ok = `${GOOD}\nconst x = 1; // see import('../../_lib/db.mjs') for why not\nconsole.log(x);\n/* an old draft used '../../_lib/db.mjs'\n   still prose, '../../_lib/db.mjs' */\n`;
  assert.deepEqual(lint(ok), []);
});

test('an escaped slash at the end of a regex literal does not fake a line comment', () => {
  const bad = `${GOOD}\nconst re = /https?:\\/\\//; import('../../_lib/db.mjs');\n`;
  assert.match(lint(bad).join(), /bypasses _lib\/index\.mjs/);
});

test('the minimal escaped-trailing-slash repro does not fake a line comment', () => {
  const bad = `${GOOD}\nconst re = /foo\\//; import('../../_lib/db.mjs');\n`;
  assert.match(lint(bad).join(), /bypasses _lib\/index\.mjs/);
});

test('an escaped slash immediately before a * does not fake a block comment that swallows the rest of the file', () => {
  const bad = `${GOOD}\nconst re = /a\\/*b/;\nimport('../../_lib/db.mjs');\nimport('../../_lib/other.mjs');\n`;
  const hits = lint(bad).filter(p => /bypasses _lib\/index\.mjs/.test(p));
  assert.equal(hits.length, 2);
});

test('a division expression is not mistaken for an escape, and a real trailing comment after it is still stripped', () => {
  const ok = `${GOOD}\nconst x = 1 / 2; // import('../../_lib/db.mjs')\nconsole.log(x);\n`;
  assert.deepEqual(lint(ok), []);
});

test('an unterminated /* comment is reported as its own violation instead of silently hiding everything after it', () => {
  const bad = `${GOOD}\n/* this block comment is never closed\nimport('../../_lib/db.mjs');\n`;
  const problems = lint(bad);
  assert.ok(problems.some(p => /^6: unterminated \/\* comment/.test(p)), problems.join('; '));
});

// import-surface: index.mjs is the only sanctioned specifier under _lib/.

test('an import that reaches around index.mjs into another _lib module is rejected', () => {
  const bad = `${HEAD}import { run } from '../../_lib/db.mjs';\nawait scenario('B-06', async () => { await run(); });\n`;
  assert.match(lint(bad).join(), /bypasses _lib\/index\.mjs/);
});

test('a dynamic import of a _lib module other than index.mjs is rejected too', () => {
  const bad = `${HEAD}const { run } = await import('../../_lib/db.mjs');\nawait scenario('B-06', async () => { await run(); });\n`;
  assert.match(lint(bad).join(), /bypasses _lib\/index\.mjs/);
});

test('reaching into _lib/node_modules is rejected', () => {
  const bad = `${HEAD}import { thing } from '../../_lib/node_modules/pkg/index.mjs';\nawait scenario('B-06', async () => { await thing(); });\n`;
  assert.match(lint(bad).join(), /bypasses _lib\/index\.mjs/);
});

test('the sanctioned import of _lib/index.mjs itself is not flagged', () => {
  assert.deepEqual(lint(GOOD), []);
});

// ip-literal: a raw IP endpoint is a RAW rule, so it fires in a comment too.

test('a raw IP endpoint literal is rejected, in code and in a comment alike', () => {
  assert.match(lint(`${GOOD}\nconst u = 'https://127.0.0.1:9444/v1.0/thing';\n`).join(), /literal IP endpoint/);
  assert.match(lint(`${GOOD}\n// the fixture is served from http://10.0.0.5:9280\n`).join(), /literal IP endpoint/);
});

test('the IPv6 bracket form of the same endpoint is rejected too', () => {
  assert.match(lint(`${GOOD}\nconst u = 'https://[::1]:9444/v1.0/thing';\n`).join(), /literal IP endpoint/);
});

test('the ip-literal message names the three accessors', () => {
  const [msg] = lint(`${GOOD}\nconst u = 'http://10.0.0.5:9280';\n`);
  assert.match(msg, /^6: literal IP endpoint — use reg\.host\(alias\), reg\.raw\.stubs\[name\] for a HARNESS-side fetch, or reg\.stubInternal\(name\)/);
});

test('the bypass shape reports the import and the endpoint together, in line order', () => {
  const bad = `${HEAD}import { run } from '../../_lib/db.mjs';\n`
    + `await fetch('https://127.0.0.1:9444/v1.0/thing');\n`
    + `await scenario('B-06', async () => { await run(); });\n`;
  const problems = lint(bad);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^3: import bypasses/);
  assert.match(problems[1], /^4: literal IP endpoint/);
});

// undeclaredIdentifiers() through lintScript. An unexpected Error classifies
// KO, so an authoring typo would read as a PRODUCT failure.

test('an identifier that is used but never declared is flagged', () => {
  const bad = `${GOOD}\nif (await visible(page, MODIFICATI_TABLE)) fail('x');\n`;
  assert.match(lint(bad).join(), /MODIFICATI_TABLE is used but never imported or declared/);
});

test('a declared constant is not flagged', () => {
  const ok = `${GOOD}\nconst MODIFICATI_TABLE = '.result-table';\nconst x = MODIFICATI_TABLE;\nconsole.log(x);\n`;
  assert.deepEqual(lint(ok), []);
});

test('an imported constant is not flagged', () => {
  const ok = `${HEAD}import { scenario, read, TOAST_SELECTOR } from '../../_lib/index.mjs';\n`
    + `await scenario('B-06', async () => { await read('SELECT 1'); });\n`
    + 'const x = TOAST_SELECTOR;\nconsole.log(x);\n';
  assert.deepEqual(lint(ok), []);
});

test('SQL keywords inside a template literal are not identifiers', () => {
  const ok = `${GOOD}\nconst q = \`SELECT a FROM t WHERE b = 1 ORDER BY c LIMIT 1\`;\nconsole.log(q);\n`;
  assert.deepEqual(lint(ok), []);
});

test("an apostrophe inside a double-quoted string does not desync the scan", () => {
  const ok = `${GOOD}\nconst m = "that is the OUTGOING owner's room";\nconst n = 'BLOCKED';\nconsole.log(m, n);\n`;
  assert.deepEqual(lint(ok), []);
});

test('a SCREAMING_SNAKE token inside a regex literal is not an identifier', () => {
  const ok = `${GOOD}\nconst found = /^SOME_VAR_HOST=(.*)$/m.exec(out);\nconsole.log(found);\n`;
  assert.deepEqual(lint(ok), []);
});

test('a property access is not a free identifier', () => {
  const ok = `${GOOD}\nconst t = TIMEOUTS.NAV_TIMEOUT;\nconst TIMEOUTS = {};\nconsole.log(t);\n`;
  assert.deepEqual(lint(ok), []);
});

test('a division is not treated as a regex literal', () => {
  const bad = `${GOOD}\nconst pct = done / total;\nconst x = MISSING_CONST;\n`;
  assert.match(lint(bad).join(), /MISSING_CONST is used but never imported or declared/);
});

// unusedDeclarations(): copied helpers and imports the row never uses.

const names = src => unusedDeclarations(src).map(d => `${d.kind}:${d.name}@${d.line}`);

test('an unused import is reported through lintScript, with its line and the AUTHORING rule', () => {
  const bad = GOOD.replace('{ scenario, read }', '{ scenario, read, visible }');
  assert.deepEqual(lint(bad), ['3: visible is imported but never used — AUTHORING § 7: no unused imports']);
});

test('an unused top-level declaration is reported through lintScript', () => {
  assert.match(lint(`${GOOD}const POLL_INTERVAL = 300;\n`).join(), /5: top-level POLL_INTERVAL is declared but never used/);
});

test('dead functions, async functions, arrow consts and lets are all reported, in source order', () => {
  const src = 'function checkFreed(miss) { miss.push(1); }\n'
    + 'async function readPlan(reg) { return reg; }\n'
    + 'const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));\n'
    + 'let counter = 0;\n';
  assert.deepEqual(names(src),
    ['declaration:checkFreed@1', 'declaration:readPlan@2', 'declaration:sleep@3', 'declaration:counter@4']);
});

test('a multi-line import reports the line the dead name sits on', () => {
  const src = "import {\n  scenario, fail,\n  blocked, sql,\n} from '../../_lib/index.mjs';\nawait scenario('X', () => sql(fail));\n";
  assert.deepEqual(names(src), ['import:blocked@3']);
});

test('an aliased import is judged by its local name', () => {
  const used = "import { visible as seen } from '../../_lib/index.mjs';\nawait seen();\n";
  const dead = "import { visible as seen } from '../../_lib/index.mjs';\nawait visible();\n";
  assert.deepEqual(names(used), []);
  assert.deepEqual(names(dead), ['import:seen@1']);
});

test('a name used only inside a ${} template expression is a use — why strings are not blanked', () => {
  const src = "const PBX_ID = 'p1';\nconsole.log(`/api/v1/pbxes/${PBX_ID}/imports`);\n";
  assert.deepEqual(names(src), []);
});

test('a spread is a use, and so is an object shorthand', () => {
  const src = 'const BASE = [1];\nconst EXTRA = 2;\nconsole.log([...BASE], { EXTRA });\n';
  assert.deepEqual(names(src), []);
});

test('a .name property access is not a use of name', () => {
  const src = "import { visible } from '../../_lib/index.mjs';\nconst checkBound = 1;\nawait page.visible(); obj.checkBound;\n";
  assert.deepEqual(names(src), ['import:visible@1', 'declaration:checkBound@2']);
});

test('a mention in a comment is not a use', () => {
  const src = 'const RESULT_VIEW_TIMEOUT = 20000;\n// waits RESULT_VIEW_TIMEOUT for the poll tick\n/* RESULT_VIEW_TIMEOUT */\n';
  assert.deepEqual(names(src), ['declaration:RESULT_VIEW_TIMEOUT@1']);
});

test('an indented declaration is not top level, so it is not judged', () => {
  const src = 'function used() {\n  const local = 1;\n  function inner() {}\n}\nused();\n';
  assert.deepEqual(names(src), []);
});

test('a name also spelled inside a string reads as used — the documented miss, never a false alarm', () => {
  const src = "const login = 1;\nconsole.log('login failed');\n";
  assert.deepEqual(names(src), []);
});

// The rule set: core, adapter contributions, project hook, in that order.

test('the core rules carry the ids the extension contract names, all owned by core', () => {
  assert.deepEqual(CORE_RULES.map(r => r.id).sort(),
    ['header', 'import-surface', 'ip-literal', 'shebang', 'undeclared', 'unterminated-comment', 'unused', 'wrapper']);
  assert.ok(CORE_RULES.every(r => r.owner === 'core'));
});

test('allRules orders core, then adapter rules, then project rules', (t) => {
  const adapterRule = { id: 'a-rule', kind: 'source', check: () => [] };
  const projectRule = { id: 'p-rule', owner: 'project', kind: 'source', check: () => [] };
  t.after(__setForTest({
    hooks: { lint: { rules: () => [projectRule] } },
    adapters: { alpha: { lint: [adapterRule] } },
    providers: {},
  }));
  const ids = allRules().map(r => r.id);
  assert.deepEqual(ids.slice(0, CORE_RULES.length), CORE_RULES.map(r => r.id));
  assert.deepEqual(ids.slice(CORE_RULES.length), ['a-rule', 'p-rule']);
  assert.equal(allRules().find(r => r.id === 'a-rule').owner, 'alpha');
});

test('a project rule from lint.rules runs with the context from lint.context', (t) => {
  const seen = [];
  t.after(__setForTest({
    hooks: {
      lint: {
        context: raw => ({ words: raw.banned }),
        rules: ctx => [{
          id: 'banned-word', owner: 'project', kind: 'code',
          re: new RegExp(`\\b(?:${ctx.words.join('|')})\\b`), msg: 'banned word',
        }, {
          id: 'saw-ctx', owner: 'project', kind: 'source',
          check: (source, args) => { seen.push(args.ctx); return []; },
        }],
      },
    },
    adapters: {}, providers: {},
  }));
  const ctx = { words: ['zorp'] };
  const problems = lintScript(`${GOOD}const w = 'zorp';\nconsole.log(w);\n`, { ...OPTS, ctx, rules: allRules(ctx) });
  assert.deepEqual(problems, ['5: banned word']);
  assert.deepEqual(seen, [ctx]);
});

test('a code rule ignores a comment while a raw rule reads it', () => {
  const rules = [
    { id: 'c', owner: 'x', kind: 'code', re: /zorp/, msg: 'code hit' },
    { id: 'r', owner: 'x', kind: 'raw', re: /zorp/, msg: 'raw hit' },
  ];
  assert.deepEqual(lintScript('a // zorp\n', { rules }), ['1: raw hit']);
});

test('a rule mask is applied first, and a global mask keeps no state across lines', () => {
  const rules = [{ id: 'm', owner: 'x', kind: 'raw', re: /zorp/, mask: /safe zorp/g, msg: 'hit' }];
  assert.deepEqual(lintScript('safe zorp\nsafe zorp\nbare zorp safe zorp\n', { rules }), ['3: hit']);
});

test('lintScript skips matrix rules', () => {
  let calls = 0;
  const rules = [{ id: 'mx', owner: 'x', kind: 'matrix', check: () => { calls++; return ['nope']; } }];
  assert.deepEqual(lintScript('x\n', { rules }), []);
  assert.equal(calls, 0);
});

test('matrix rules run once per invocation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-lint-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'e'));
  const rows = [{ id: 'A-01', behaviour: 'one' }, { id: 'A-02', behaviour: 'two' }];
  for (const row of rows) {
    const src = `#!/usr/bin/env node\n// scenario: ${row.id} compiled_from: ${compiledFrom(row)}\nawait scenario('${row.id}', async () => {});\n`;
    writeFileSync(join(dir, 'e', `${row.id}.mjs`), src);
  }
  const reg = { epic: 'e', rows };
  const seen = [];
  const rules = [
    ...CORE_RULES,
    { id: 'mx', owner: 'x', kind: 'matrix', check: r => { seen.push(r); return ['matrix: one problem']; } },
  ];
  const out = lintEpic(reg, { scriptsDir: dir, rules });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], reg);
  assert.deepEqual(out, ['matrix: one problem']);
});

test('lintEpic prefixes script problems with the row id, honours `only`, and skips uncompiled rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-lint-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'e'));
  writeFileSync(join(dir, 'e', 'A-01.mjs'), 'console.log(1);\n');
  const reg = { epic: 'e', rows: [{ id: 'A-01' }, { id: 'A-02' }] };
  const all = lintEpic(reg, { scriptsDir: dir, rules: CORE_RULES });
  assert.ok(all.length > 0 && all.every(p => p.startsWith('A-01: ')));
  assert.deepEqual(lintEpic(reg, { scriptsDir: dir, rules: CORE_RULES, only: 'A-02' }), []);
});

// stringLiteralScanner(memberRe): the per-file scanner a project or adapter
// rule builds to find a member that is text inside a quoted string.

const MEMBER = /\bfoo\.bar\b/y;
const scan = (...lines) => { const d = stringLiteralScanner(MEMBER); return lines.map(d); };

test('stringLiteralScanner finds a member only inside a string literal', () => {
  assert.deepEqual(scan(`const a = 'x foo.bar y';`), [true]);
  assert.deepEqual(scan(`const a = "x foo.bar y";`), [true]);
  assert.deepEqual(scan('const a = foo.bar;'), [false]);
  assert.deepEqual(scan('const a = `${foo.bar}`;'), [false]);
  assert.deepEqual(scan(`const a = 'x' + foo.bar + 'y';`), [false]);
  assert.deepEqual(scan(`const a = "x" + foo.bar + "y";`), [false]);
});

test('stringLiteralScanner reads a trapped concatenation as string content', () => {
  assert.deepEqual(scan(`const a = 'x" + foo.bar + "y';`), [true]);
  assert.deepEqual(scan(`const a = "x' + foo.bar + 'y";`), [true]);
});

test('stringLiteralScanner carries its stack across the lines of one template literal', () => {
  assert.deepEqual(scan('const q = `INSERT (', "  '${foo.bar}', '${foo.bar}'", ')`;'), [false, false, false]);
});

test('stringLiteralScanner does not read a quote inside a regex literal as a string open', () => {
  assert.deepEqual(scan(`const s = v.replace(/'/g, "\\\\'");`, 'const t = foo.bar;'), [false, false]);
});

test('stringLiteralScanner makes a non-sticky pattern sticky and keeps \\b honest', () => {
  const d = stringLiteralScanner(/\bfoo\.bar\b/);
  assert.equal(d(`const a = 'xfoo.bar';`), false);
  assert.equal(d(`const a = 'x foo.bar';`), true);
});

test('stringLiteralScanner finishes its line before reporting, so one hit does not desync the next line', () => {
  assert.deepEqual(scan(`const a = 'foo.bar'; const b = 1;`, 'const c = foo.bar;'), [true, false]);
});

test('the CLI names a matrix it cannot load in one line and exits 1, with no stack trace', () => {
  const env = { ...process.env, SCN_MATRIX_DIR: join(import.meta.dirname, 'fixtures') };
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'lint.mjs'), 'no-such-epic'], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /matrix not found: .*no-such-epic\.yaml/);
  assert.doesNotMatch(r.stderr, /^\s+at /m);
});
