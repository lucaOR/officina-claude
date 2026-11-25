import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPalette } from '../lib/palette.mjs';
import { stylesheet, render } from '../lib/index.mjs';
import { NODE_TYPES } from '../lib/rows.mjs';

const WF = { type: 'workflow', title: 'T', rows: [['a', 'Start'], ['b', 'Focus', 'focus'], ['a > b', 'go']] };

test('a palette sets light and dark values', () => {
  const css = stylesheet('.dg-host', { palette: { ink: ['#111111', '#eeeeee'] } });
  assert.match(css, /--dg-ink:#111111/);
  assert.match(css, /--dg-ink:#eeeeee/);
});
test('a string value applies to both schemes', () => {
  assert.deepEqual(loadPalette({ focus: '#abc' }).focus, ['#abc', '#abc']);
});
test('a palette value that could break out of the rule is rejected', () => {
  assert.throws(() => loadPalette({ ink: 'red;}body{x' }), /palette ink: invalid colour/);
});
test('injection attempts are rejected, whatever the colour function', () => {
  for (const bad of ['rgb(0;}x{)', 'rgb(0,0,0);}', 'url(x)', 'var(--x;}a{)', 'var(--x, red)', 'var(x)', 'var(--x )', 'var(var(--x))', 'expression(1)', 'red', '#12', '#ggg', '#12345', '"#fff"', "#fff'", '#fff}', 'rgb(0,0)', 'hsl(1,2%,3%;)', '', 5, null, ['#fff'], ['#fff', 'red;']]) {
    assert.throws(() => loadPalette({ ink: bad }), /palette ink: invalid colour/, JSON.stringify(bad));
  }
});
test('hex, rgb and hsl colours are accepted', () => {
  const p = loadPalette({ ink: '#1a2b3c', muted: ['#abcd', '#aabbccdd'], panel: 'rgb(10, 20, 30)', line: 'hsl(210 40% 50%)', rule: 'rgba(0,0,0,.5)', dashed: 'rgb(0 0 0 / .5)', emphasis: 'var(--accent)' });
  assert.equal(p.ink[0], '#1a2b3c');
  assert.equal(p.panel[1], 'rgb(10, 20, 30)');
});
test('an unknown palette key is rejected and named', () => {
  assert.throws(() => loadPalette({ nope: '#fff' }), /palette nope: unknown key/);
});
test('stylesheet validates a raw palette itself, so it cannot be bypassed', () => {
  assert.throws(() => stylesheet('.dg-host', { palette: { ink: 'red;}body{x' } }), /palette ink: invalid colour/);
});
test('render takes a palette and a style, and spec.style is used unless the option is set', () => {
  assert.match(render(WF, { palette: { focus: '#123456' } }).css, /--dg-focus:#123456/);
  assert.throws(() => render(WF, { palette: { ink: 'rgb(0;}x{)' } }), /palette ink: invalid colour/);
  assert.match(render({ ...WF, style: 'editorial' }).css, /stroke:var\(--dg-line\);stroke-width:1\}/);
  assert.doesNotMatch(render({ ...WF, style: 'editorial' }, { style: 'default' }).css, /stroke:var\(--dg-line\);stroke-width:1\}/);
  assert.throws(() => render({ ...WF, style: 'fancy' }), /style/);
});
test('editorial draws every node with a hairline and no tint', () => {
  const css = stylesheet('.dg-host', { style: 'editorial' });
  assert.match(css, /\.dg-host \.dg-node \.dg-shape\{fill:var\(--dg-panel\);stroke:var\(--dg-line\);stroke-width:1\}/);
  assert.match(css, /\.dg-host \.dg-node\.t-focus \.dg-shape\{fill:var\(--dg-focus\)/);
  assert.doesNotMatch(stylesheet('.dg-host'), /stroke:var\(--dg-line\);stroke-width:1\}/);
});
test('focus is a valid node type and renders', () => {
  assert.ok(NODE_TYPES.includes('focus'));
  assert.match(render(WF).svg, /t-focus/);
});
