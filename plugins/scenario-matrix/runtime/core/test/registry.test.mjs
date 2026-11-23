import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTemplate } from '../registry.mjs';

test('resolveTemplate substitutes braces and reports the first unknown', () => {
  assert.equal(resolveTemplate('curl -k https://{host}', { host: 'a.b' }), 'curl -k https://a.b');
  assert.throws(() => resolveTemplate('{host}/{path}', { host: 'a.b' }), /unresolved placeholder: path/);
});
