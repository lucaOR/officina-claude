import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintScript, allRules, CORE_RULES } from '../lint.mjs';
import { contributions, __setForTest } from '../ext.mjs';
import * as laravelAdapter from '../adapter-laravel.mjs';

const HEAD = '#!/usr/bin/env node\n// scenario: B-06 compiled_from: abc123abc123\n';
const GOOD = `${HEAD}import { scenario, read } from '../../_lib/index.mjs';\nawait scenario('B-06', async () => { await read('SELECT 1'); });\n`;
const OPTS = { id: 'B-06', hash: 'abc123abc123' };
// The core rules plus this adapter's, so other adapters and the project never change what these cases see.
const lint = source => lintScript(source, { ...OPTS, rules: [...CORE_RULES, ...laravelAdapter.lint] });

test('the adapter contributes a php-artisan rule owned by laravel', (t) => {
  t.after(__setForTest({ adapters: { laravel: laravelAdapter }, providers: {}, hooks: {} }));
  const rule = contributions('lint').find(r => r.id === 'php-artisan');
  assert.equal(rule.owner, 'laravel');
  assert.ok(allRules().some(r => r.id === 'php-artisan'));
});

test('a clean script lints clean under the artisan rule', () => {
  assert.deepEqual(lint(GOOD), []);
});

test('a raw artisan invocation is rejected', () => {
  assert.match(lint(`${GOOD}\nconst cmd = 'php artisan migrate';\n`).join(), /raw artisan — use artisan\(\)\/tinker\(\)/);
});

test('the artisan lever call itself lints clean', () => {
  assert.deepEqual(lint(`${GOOD}\nawait artisan(reg, 'api', ['app:prune', 'x']);\n`), []);
});

test('a trailing // comment mentioning php artisan lints clean', () => {
  assert.deepEqual(lint(`${GOOD}\nconst x = 1; // note: php artisan is intentionally not used here\nconsole.log(x);\n`), []);
});

test('a php artisan mention inside a block comment lints clean on its opening and continuation lines', () => {
  const ok = `${GOOD}\n/* heads-up: an earlier draft ran php artisan directly\n   this continuation line also says php artisan, still just prose\n*/\n`;
  assert.deepEqual(lint(ok), []);
});

test('a raw artisan call after a URL string literal on the same line is still caught', () => {
  const bad = `${GOOD}\nconst u = 'https://example.test/path'; run('php artisan migrate');\n`;
  assert.match(lint(bad).join(), /raw artisan/);
});

test('the problem is reported on its own line after a multi-line block comment', () => {
  const bad = `${GOOD}\n/* line A of the comment even says php artisan\n   line B of the comment says it again\n*/\nconst cmd = 'php artisan migrate';\n`;
  const at = bad.split('\n').findIndex(l => l.startsWith("const cmd = 'php artisan")) + 1;
  assert.ok(lint(bad).some(p => p.startsWith(`${at}: raw artisan`)), JSON.stringify(lint(bad)));
});
