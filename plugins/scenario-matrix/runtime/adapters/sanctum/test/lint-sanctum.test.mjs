import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintScript, allRules, CORE_RULES } from '../lint.mjs';
import { contributions, __setForTest } from '../ext.mjs';
import * as sanctumAdapter from '../adapter-sanctum.mjs';

const HEAD = '#!/usr/bin/env node\n// scenario: B-06 compiled_from: abc123abc123\n';
const GOOD = `${HEAD}import { scenario, read } from '../../_lib/index.mjs';\nawait scenario('B-06', async () => { await read('SELECT 1'); });\n`;
const OPTS = { id: 'B-06', hash: 'abc123abc123' };
// The core rules plus this adapter's, so other adapters and the project never change what these cases see.
const lint = source => lintScript(source, { ...OPTS, rules: [...CORE_RULES, ...sanctumAdapter.lint] });

test('the adapter contributes a raw-request rule owned by sanctum', (t) => {
  t.after(__setForTest({ adapters: { sanctum: sanctumAdapter }, providers: {}, hooks: {} }));
  const rule = contributions('lint').find(r => r.id === 'raw-request');
  assert.equal(rule.owner, 'sanctum');
  assert.ok(allRules().some(r => r.id === 'raw-request'));
});

test('a clean script lints clean under the raw-request rule', () => {
  assert.deepEqual(lint(GOOD), []);
});

test('a bare context.request call is rejected — it 401s under a stateful API gate', () => {
  // The exact shape that costs rows: correct cookies, correct origin, and a 401 from a route whose
  // guard would have passed, because a browser APIRequestContext sends neither Referer nor Origin
  // and the gate returns false without them. It fails OPEN, which is why it is mechanised.
  const bad = `${GOOD}\nconst res = await context.request.get(url, { failOnStatusCode: false });\n`;
  assert.match(lint(bad).join(), /raw context\.request/);
});

test('every request verb is covered, not just get', () => {
  for (const verb of ['post', 'put', 'patch', 'delete', 'head']) {
    const bad = `${GOOD}\nawait context.request.${verb}(url, {});\n`;
    assert.match(lint(bad).join(), /raw context\.request/, `context.request.${verb}() was not flagged`);
  }
});

test('page.request is rejected too — same APIRequestContext, same missing headers', () => {
  const bad = `${GOOD}\nawait page.request.get(url);\n`;
  assert.match(lint(bad).join(), /raw context\.request/);
});

test('apiRequest() itself is NOT flagged', () => {
  const ok = `${GOOD}\nconst res = await apiRequest(context, reg, 'app', '/api/v1/x');\nconsole.log(res);\n`;
  assert.deepEqual(lint(ok), []);
});

test('the rule does not fire from a COMMENT explaining the trap', () => {
  // Every compiled script that uses apiRequest wants to say why in its header, and naming
  // context.request there must not fail the lint.
  const ok = `${GOOD}\n// NOT context.request.get(): the stateful gate needs a Referer.\n`;
  assert.deepEqual(lint(ok), []);
});
