import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lintScript, allRules, CORE_RULES } from '../lint.mjs';
import { contributions, __setForTest } from '../ext.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';

const HEAD = '#!/usr/bin/env node\n// scenario: B-06 compiled_from: abc123abc123\n';
const GOOD = `${HEAD}import { scenario, sql } from '../../_lib/index.mjs';\nawait scenario('B-06', async () => { await sql(reg, 'scn_app', 'SELECT 1'); });\n`;
const OPTS = { id: 'B-06', hash: 'abc123abc123' };
// The core rules plus this adapter's, so other adapters and the project never change what these cases see.
const lint = source => lintScript(source, { ...OPTS, rules: [...CORE_RULES, ...sqlAdapter.lint] });

let restoreExt;
const install = (config = {}) => { restoreExt = __setForTest({ adapters: { sql: sqlAdapter }, providers: {}, hooks: {}, config }); };
beforeEach(() => install({ adapters: { sql: { ambientDbPrefixes: ['local', 'shared'] } } }));
afterEach(() => restoreExt());

test('the adapter contributes ambient-db and prefix-literal rules owned by sql', () => {
  const rules = contributions('lint');
  assert.deepEqual(rules.map(r => [r.id, r.owner]), [['ambient-db', 'sql'], ['prefix-literal', 'sql']]);
  assert.ok(allRules().some(r => r.id === 'ambient-db'));
});

test('a clean script lints clean under the sql rules', () => {
  assert.deepEqual(lint(GOOD), []);
});

// --- ambient database literals ---
// The target-argument guard cannot see a database named inside the SQL, so this rule is what covers
// it. It has to hold in both directions: catching the ambient name, and staying silent on lookalikes.

test('an ambient database named inside the SQL is rejected, though the target argument is scn_', () => {
  const bad = `${GOOD}\nawait sql(reg, 'scn_app', 'DROP DATABASE local_app_main');\n`;
  assert.match(lint(bad).join(), /ambient database name/);
});

test('a cross-schema read of an ambient database is rejected, the realistic accidental shape', () => {
  const bad = `${GOOD}\nawait sql(reg, 'scn_app', 'SELECT id FROM local_app_main.users');\n`;
  assert.match(lint(bad).join(), /ambient database name/);
});

test('an ambient database mentioned only in a comment is rejected as well', () => {
  const bad = `${GOOD}\n// the ambient equivalent of this table lives in shared_app\n`;
  assert.match(lint(bad).join(), /ambient database name/);
});

test('the problem names its own line', () => {
  const bad = `${GOOD}\n\nconst x = 'local_app_main';\nconsole.log(x);\n`;
  const at = bad.split('\n').findIndex(l => l.includes('local_app_main')) + 1;
  assert.ok(lint(bad).some(p => p.startsWith(`${at}: ambient database name`)), JSON.stringify(lint(bad)));
});

test('the message names the configured database prefix', () => {
  restoreExt();
  install({ dbPrefix: 'qa_', adapters: { sql: { ambientDbPrefixes: ['local'] } } });
  assert.match(lint(`${GOOD}\nconst x = 'local_app';\nconsole.log(x);\n`).join(), /reaches qa_\* databases only/);
});

test('a SCREAMING_SNAKE identifier beginning with a prefix is NOT flagged, the rule is case-sensitive', () => {
  const ok = `${GOOD}\nconst SHARED_THEME_ASSETS = '/themes/x/';\nconst LOCAL_ONLY = SHARED_THEME_ASSETS;\nconsole.log(LOCAL_ONLY);\n`;
  assert.deepEqual(lint(ok), []);
});

test('a lowercase ambient database is still rejected next to a SCREAMING_SNAKE constant', () => {
  const bad = `${GOOD}\nconst SHARED_THEME_ASSETS = '/x';\n// see local_app_main\n`;
  assert.match(lint(bad).join(), /ambient database name/);
});

test('a bare prefix word and a host alias are NOT flagged: the hyphen and the dot are not the underscore', () => {
  const ok = `${GOOD}\nawait page.goto(\`https://\${reg.host('shared-web')}/app\`);\nconst scope = 'local';\nconsole.log(scope);\n`;
  assert.deepEqual(lint(ok), []);
});

test('the prefixes come from the adapter config: an unlisted one is not flagged, a listed one is', () => {
  restoreExt();
  install({ adapters: { sql: { ambientDbPrefixes: ['local'] } } });
  assert.deepEqual(lint(`${GOOD}\nconst x = 'shared_app';\nconsole.log(x);\n`), []);
  assert.match(lint(`${GOOD}\nconst x = 'local_app';\nconsole.log(x);\n`).join(), /ambient database name/);
});

test('with no configured prefixes the default is local', () => {
  restoreExt();
  install({});
  assert.match(lint(`${GOOD}\nconst x = 'local_app';\nconsole.log(x);\n`).join(), /ambient database name/);
  assert.deepEqual(lint(`${GOOD}\nconst x = 'shared_app';\nconsole.log(x);\n`), []);
});

test('an empty prefix list turns the rule off', () => {
  restoreExt();
  install({ adapters: { sql: { ambientDbPrefixes: [] } } });
  assert.deepEqual(lint(`${GOOD}\nconst x = 'local_app';\nconsole.log(x);\n`), []);
});

test('a prefix with a regex metacharacter is matched literally', () => {
  restoreExt();
  install({ adapters: { sql: { ambientDbPrefixes: ['a.b'] } } });
  assert.deepEqual(lint(`${GOOD}\nconst x = 'axb_app';\nconsole.log(x);\n`), []);
  assert.match(lint(`${GOOD}\nconst x = 'a.b_app';\nconsole.log(x);\n`).join(), /ambient database name/);
});

// --- the prefix-literal heuristic ---
// The shape it exists to catch, a prefixed name built into something that is not a sql() target, is
// exactly the argv-array bypass the import rule closes only when the author reaches for another module.

test('a prefixed literal outside a sql() target argument is flagged', () => {
  const bad = `${GOOD}\nconst cmd = 'scn_app';\nconsole.log(cmd);\n`;
  assert.match(lint(bad).join(), /1 scn_ literal\(s\) outside a sql\(\) target argument/);
});

test('one prefixed literal per sql()/one()/scalar() target is not flagged', () => {
  const ok = `${HEAD}import { scenario, sql, one, scalar } from '../../_lib/index.mjs';\n`
    + `await scenario('B-06', async () => {\n`
    + `  await sql(reg, 'scn_app', 'SELECT 1');\n`
    + `  await one(reg, 'scn_admin', 'SELECT 1');\n`
    + `  await scalar(reg, 'scn_accounts', 'SELECT 1');\n`
    + `});\n`;
  assert.deepEqual(lint(ok), []);
});

// schemaFreeze() takes its schema as the second argument exactly like sql() takes its target, so the
// heuristic counts it as a target too.
test('a prefixed literal as the schemaFreeze() target is not flagged', () => {
  const ok = `${HEAD}import { scenario, schemaFreeze } from '../../_lib/index.mjs';\n`
    + `await scenario('B-06', async () => {\n`
    + `  const fault = await schemaFreeze(reg, 'scn_admin');\n`
    + `  await fault.restore();\n`
    + `});\n`;
  assert.deepEqual(lint(ok), []);
});

test('the literal prefix comes from the config', () => {
  restoreExt();
  install({ dbPrefix: 'qa_' });
  const good = GOOD.replace('scn_app', 'qa_app');
  assert.deepEqual(lint(good), []);
  assert.match(lint(`${good}\nconst cmd = 'qa_app';\nconsole.log(cmd);\n`).join(), /1 qa_ literal\(s\) outside/);
});
