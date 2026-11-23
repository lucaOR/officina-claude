import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintScript, CORE_RULES } from '../lint.mjs';
import * as mysqlAdapter from '../adapter-mysql.mjs';

const HEAD = '#!/usr/bin/env node\n// scenario: B-06 compiled_from: abc123abc123\n';
const GOOD = `${HEAD}import { scenario, sql } from '../../_lib/index.mjs';\nawait scenario('B-06', async () => { await sql(reg, 'scn_app', 'SELECT 1'); });\n`;
const lint = source => lintScript(source, { id: 'B-06', hash: 'abc123abc123', rules: [...CORE_RULES, ...mysqlAdapter.lint] });

test('the adapter contributes one mysql-cli rule', () => {
  assert.deepEqual(mysqlAdapter.lint.map(r => r.id), ['mysql-cli']);
});

test('a clean script lints clean under the mysql rule', () => {
  assert.deepEqual(lint(GOOD), []);
});

test('a raw mysql client invocation is rejected', () => {
  assert.match(lint(`${GOOD}\nconst cmd = 'mysql -uroot -e SELECT1';\nconsole.log(cmd);\n`).join(), /raw mysql client — use sql\(\)/);
});

test('a mention of the client in a comment lints clean', () => {
  assert.deepEqual(lint(`${GOOD}\nconst x = 1; // never run mysql -uroot by hand\nconsole.log(x);\n`), []);
});

test('a mysql word that is not a client invocation lints clean', () => {
  assert.deepEqual(lint(`${GOOD}\nconst engine = 'mysql';\nconsole.log(engine);\n`), []);
});
