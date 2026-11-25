import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../lib/index.mjs';
import { TYPES } from '../lib/rows.mjs';
import { assertClean } from './geometry.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'diagram');
const ROWS = join(SKILL, 'reference', 'rows.md');
const skillDescription = /^description: (.*)$/m.exec(readFileSync(join(SKILL, 'SKILL.md'), 'utf8'))[1];

test('every example in the row reference renders', () => {
  const blocks = [...readFileSync(ROWS, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]));
  assert.deepEqual(blocks.map(b => b.type), TYPES);
  for (const spec of blocks) {
    const r = render(spec);
    assert.ok(r.svg.startsWith('<svg'), spec.title);
    assertClean(r);
  }
});

test('the skill description names every kind', () => {
  for (const t of TYPES) assert.ok(skillDescription.includes(t), t);
});
