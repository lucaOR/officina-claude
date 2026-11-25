import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, TYPES } from '../lib/index.mjs';
import { assertClean } from './geometry.mjs';

const bad = rows => () => render({ type: 'timeline', title: 'T', rows });

test('timeline: events are placed in date order', () => {
  const r = render({ type: 'timeline', title: 'T', rows: [['2026-03', 'Beta'], ['2025', 'Alpha'], ['2026-09', 'GA']] });
  const x = id => r.boxes.find(b => b.id === id).x;
  assert.ok(x('e2') < x('e1') && x('e1') < x('e3'));
  assert.deepEqual(r.nodes, ['e1', 'e2', 'e3']);
  assertClean(r);
});
test('timeline: events a day apart do not overlap', () => {
  const r = render({ type: 'timeline', title: 'T', rows: [['2026-03-01', 'Long label one'], ['2026-03-02', 'Long label two'], ['2026-03-03', 'Long label three'], ['2027', 'Far later']] });
  assertClean(r);
  const ys = new Set(r.boxes.map(b => b.y));
  assert.ok(ys.size > 1, 'colliding labels are stacked on further rows');
});
test('timeline: output is deterministic', () => {
  const spec = { type: 'timeline', title: 'T', rows: [['2026-03', 'B'], ['2025', 'A']] };
  assert.equal(render(spec).svg, render(spec).svg);
});
test('timeline: one shared date renders without NaN', () => {
  for (const rows of [[['2026-03-01', 'A'], ['2026-03-01', 'B']], [['2026', 'Only']]]) {
    const r = render({ type: 'timeline', title: 'T', rows });
    assert.doesNotMatch(r.svg, /NaN|Infinity/);
    assertClean(r);
  }
});
test('timeline: tracks group events into bands that stay clear of the boxes', () => {
  const r = render({ type: 'timeline', title: 'T', rows: [['track eng', 'Engineering'], ['track biz', 'Business'], ['2025', 'Start', 'biz'], ['2025-02', 'Prototype', 'eng'], ['2025-03', 'Launch', 'biz', 'focus'], ['2025-03-02', 'Hotfix', 'eng']] });
  assertClean(r);
  const y = id => r.boxes.find(b => b.id === id).y;
  assert.ok(y('e2') < y('e1'), 'eng band sits above biz band');
  assert.equal((r.svg.match(/class="dg-lane"/g) || []).length, 2);
  assert.match(r.svg, /Engineering/);
  assert.match(r.svg, /t-focus/);
});
test('timeline: the stylesheet styles the axis and stem classes', () => {
  const { css, svg } = render({ type: 'timeline', title: 'T', rows: [['2025', 'A'], ['2026', 'B']] });
  assert.match(css, /\.dg-axis[^{]*\{[^}]*stroke:var\(--dg-line\)/);
  assert.match(css, /\.dg-stem[^{]*\{[^}]*stroke:var\(--dg-rule\)/);
  assert.match(css, /\.dg-when[^{]*\{[^}]*fill:var\(--dg-muted\)/);
  assert.match(svg, /class="dg-axis"/);
  assert.match(svg, /class="dg-stem"/);
  assert.match(svg, /class="dg-when"/);
});
test('timeline: labels and track names are escaped', () => {
  const { svg } = render({ type: 'timeline', title: 'T', rows: [['track t', '<i>&"'], ['2025', '<b>x</b>', 't']] });
  assert.match(svg, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(svg, /&lt;i&gt;&amp;&quot;/);
  assert.doesNotMatch(svg, /<b>|<i>/);
});
test('timeline: is registered after tree', () => assert.deepEqual(TYPES.slice(0, 6), ['sequence', 'workflow', 'erd', 'state', 'tree', 'timeline']));
test('timeline: a bad date names the row', () => {
  assert.throws(bad([['2026-13', 'x']]), /^Error: Row 1: date "2026-13" is not YYYY, YYYY-MM or YYYY-MM-DD/);
  assert.throws(bad([['2026-02-30', 'x']]), /^Error: Row 1: date "2026-02-30"/);
  assert.throws(bad([['2026', 'ok'], ['soon', 'x']]), /^Error: Row 2: date "soon"/);
});
test('timeline: an unknown track names the row and the track', () => assert.throws(bad([['track a', 'A'], ['2025', 'x', 'nope']]), /^Error: Row 2: track "nope" is not declared/));
test('timeline: a track given when none is declared is unknown', () => assert.throws(bad([['2025', 'x', 'nope']]), /^Error: Row 1: track "nope" is not declared/));
test('timeline: a duplicate track is rejected', () => assert.throws(bad([['track a', 'A'], ['track a', 'B'], ['2025', 'x']]), /^Error: Row 2: track "a" is declared twice/));
test('timeline: a bad track id is rejected', () => assert.throws(bad([['track 1a', 'A'], ['2025', 'x']]), /^Error: Row 1: id "1a"/));
test('timeline: an event needs a label', () => assert.throws(bad([['2025', '']]), /^Error: Row 1: an event needs a label/));
test('timeline: a track needs a label', () => assert.throws(bad([['track a', ''], ['2025', 'x']]), /^Error: Row 1: a track needs a label/));
test('timeline: an unknown type is rejected', () => assert.throws(bad([['track a', 'A'], ['2025', 'x', 'a', 'nope']]), /^Error: Row 2: type "nope"/));
test('timeline: cell counts are checked', () => {
  assert.throws(bad([['2025']]), /^Error: Row 1: a timeline event row needs at least 2 cells/);
  assert.throws(bad([['2025', 'a', 'b', 'backend', 'x']]), /^Error: Row 1: a timeline event row has at most 4 cells/);
});
test('timeline: needs an event', () => assert.throws(bad([['track a', 'A']]), /at least one event/));

test('timeline: a year below 100 is not read as 19xx', () => {
  const r = render({ type: 'timeline', title: 'T', rows: [['1979', 'Late'], ['0079', 'Early']] });
  const x = id => r.boxes.find(b => b.id === id).x;
  assert.ok(x('e2') < x('e1'));
});
