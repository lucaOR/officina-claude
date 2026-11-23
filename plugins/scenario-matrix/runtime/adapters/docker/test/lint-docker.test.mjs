import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintScript, allRules, CORE_RULES } from '../lint.mjs';
import { contributions, __setForTest } from '../ext.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';

const HEAD = '#!/usr/bin/env node\n// scenario: B-06 compiled_from: abc123abc123\n';
const GOOD = `${HEAD}import { scenario, read } from '../../_lib/index.mjs';\nawait scenario('B-06', async () => { await read('SELECT 1'); });\n`;
const OPTS = { id: 'B-06', hash: 'abc123abc123' };
// The core rules plus this adapter's, so other adapters and the project never change what these cases see.
const lint = source => lintScript(source, { ...OPTS, rules: [...CORE_RULES, ...dockerAdapter.lint] });

test('the adapter contributes a docker-exec rule owned by docker', (t) => {
  t.after(__setForTest({ adapters: { docker: dockerAdapter }, providers: {}, hooks: {} }));
  const rule = contributions('lint').find(r => r.id === 'docker-exec');
  assert.equal(rule.owner, 'docker');
  assert.ok(allRules().some(r => r.id === 'docker-exec'));
});

test('a clean script lints clean under the docker rule', () => {
  assert.deepEqual(lint(GOOD), []);
});

test('a raw docker exec is rejected', () => {
  const bad = `${GOOD}\nspawn('docker', ['exec', '-i', 'app-web']);\n`;
  assert.match(lint(bad).join(), /raw docker exec — use a lib lever/);
});

test('a docker exec written as a shell string is rejected', () => {
  assert.match(lint(`${GOOD}\nexecSync('docker exec app-web ls');\n`).join(), /raw docker exec/);
});

test('the argv-array form through another spawn helper is rejected too', () => {
  assert.match(lint(`${GOOD}\nexecFileSync("docker", ['exec', 'app-web', 'ls']);\n`).join(), /raw docker exec/);
});

test('a trailing // comment mentioning docker exec lints clean', () => {
  const ok = `${GOOD}\nconst x = 1; // note: docker exec is intentionally not used here\nconsole.log(x);\n`;
  assert.deepEqual(lint(ok), []);
});

test('a docker exec mention inside a block comment lints clean on its opening and continuation lines', () => {
  const ok = `${GOOD}\n/* heads-up: an earlier draft ran docker exec directly\n   this continuation line also says docker exec, still just prose\n*/\n`;
  assert.deepEqual(lint(ok), []);
});

test('a docker exec call after a URL string literal on the same line is still caught, not swallowed by the URL slashes', () => {
  const bad = `${GOOD}\nconst u = 'https://example.test/path'; spawn('docker', ['exec']);\n`;
  assert.match(lint(bad).join(), /raw docker exec/);
});

test('the problem is reported on its own line after a multi-line block comment', () => {
  const bad = `${GOOD}\n/* line A\n   line B\n*/\nspawn('docker', ['exec']);\n`;
  const at = bad.split('\n').findIndex(l => l.includes("spawn('docker'")) + 1;
  assert.ok(lint(bad).some(p => p.startsWith(`${at}: raw docker exec`)), JSON.stringify(lint(bad)));
});
