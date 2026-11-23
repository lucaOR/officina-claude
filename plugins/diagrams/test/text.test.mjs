import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textWidth, wrap, esc } from '../lib/text.mjs';

test('wider glyphs measure wider than narrow ones', () => {
  assert.ok(textWidth('MMMM', 12) > textWidth('iiii', 12) * 2);
});

test('width scales with font size and bold text is wider', () => {
  assert.equal(Math.round(textWidth('Store it', 24)), Math.round(textWidth('Store it', 12) * 2));
  assert.ok(textWidth('Store it', 12, true) > textWidth('Store it', 12));
});

test('a full-width character counts as one em', () => {
  assert.ok(textWidth('分支', 10) >= 20);
});

test('combining marks add no width', () => {
  assert.equal(textWidth('é', 12), textWidth('e', 12));
});

test('wrap breaks at spaces so no line exceeds the width', () => {
  const lines = wrap('Validate the incoming payment request', 90, 13);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(textWidth(line, 13) <= 90, line);
  assert.equal(lines.join(' '), 'Validate the incoming payment request');
});

test('wrap keeps a single word longer than the width on its own line', () => {
  assert.deepEqual(wrap('Supercalifragilistic', 40, 13), ['Supercalifragilistic']);
});

test('esc escapes markup and quotes', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
