import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../lib/index.mjs';
import { assertClean } from './geometry.mjs';

const ROWS = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'diagram', 'reference', 'rows.md');
const EXAMPLES = [...readFileSync(ROWS, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map(m => JSON.parse(m[1]));

test('assertClean rejects overlapping boxes', () => assert.throws(() => assertClean({ boxes: [{id:'a',x:0,y:0,w:50,h:20},{id:'b',x:40,y:0,w:50,h:20}], width: 200, height: 100 }), /a.*b.*overlap/));
test('assertClean allows a child inside its parent', () => assertClean({ boxes: [{id:'g',x:0,y:0,w:100,h:100},{id:'n',x:10,y:10,w:30,h:20,parent:'g'}], width: 200, height: 200 }));
test('assertClean allows a node inside a grandparent container', () => assertClean({ boxes: [
  {id:'cloud',x:0,y:0,w:200,h:200},{id:'vpc',x:10,y:10,w:150,h:150,parent:'cloud'},{id:'api',x:20,y:20,w:30,h:20,parent:'vpc'}], width: 300, height: 300 }));
test('assertClean still rejects a node overlapping a sibling container', () => assert.throws(() => assertClean({ boxes: [
  {id:'cloud',x:0,y:0,w:200,h:200},{id:'vpc',x:10,y:10,w:80,h:80,parent:'cloud'},{id:'other',x:100,y:10,w:80,h:80,parent:'cloud'},{id:'api',x:60,y:20,w:60,h:20,parent:'vpc'}], width: 300, height: 300 }), /api.*other.*overlap|other.*api.*overlap/));
test('assertClean rejects a box outside the canvas', () => assert.throws(() => assertClean({ boxes: [{id:'a',x:190,y:0,w:50,h:20}], width: 200, height: 100 }), /a.*outside/));
test('every example renders clean boxes', () => {
  assert.ok(EXAMPLES.length > 0);
  for (const spec of EXAMPLES) { const r = render(spec); assert.ok(r.boxes.length > 0, spec.type); assertClean(r); }
});
