import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../lib/index.mjs';
import { assertClean } from './geometry.mjs';

const ROWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'diagram', 'reference', 'rows.md');

test('every example in the row reference renders', () => {
  const blocks = [...readFileSync(ROWS, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]));
  assert.deepEqual(blocks.map(b => b.type), ['sequence', 'workflow', 'erd']);
  for (const spec of blocks) {
    const r = render(spec);
    assert.ok(r.svg.startsWith('<svg'), spec.title);
    assertClean(r);
  }
});
