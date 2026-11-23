import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, stylesheet } from '../lib/index.mjs';

const SEQ = { type: 'sequence', title: 'Ask', rows: [
  ['actor ui', 'Page', 'frontend'], ['actor api', 'Server'], ['actor db', 'Store', 'database'],
  ['phase', 'Ask'], ['ui', 'api', 'POST /questions'], ['api', 'ui', '202 queued', 'return'],
  ['phase', 'Store'], ['api', 'db', 'save answer', 'emphasis'], ['db', 'db', 'index', 'dashed'],
] };
const WF = { type: 'workflow', title: 'Release', rows: [
  ['lane prep', 'Prepare'], ['lane ship', 'Ship'],
  ['build', 'Build', 'backend', 'prep'], ['ok', 'Tests green?', 'security', 'prep'],
  ['deploy', 'Deploy', 'cloud', 'ship'], ['fix', 'Fix it', 'frontend', 'prep'],
  ['build > ok'], ['ok > deploy', 'yes', 'emphasis'], ['ok > fix', 'no', 'dashed'], ['fix > build', 'retry'],
] };
const ERD = { type: 'erd', title: 'Q&A', rows: [
  ['entity question', 'Question'], ['entity answer', 'Answer'], ['entity cat', 'Category'],
  ['question.id', 'bigint', 'pk'], ['question.cat_id', 'bigint', 'fk', 'cat.id'],
  ['answer.id', 'bigint', 'pk'], ['answer.question_id', 'bigint', 'fk', 'question.id'],
  ['cat.id', 'bigint', 'pk'], ['cat.parent_id', 'bigint', 'fk', 'cat.id'],
  ['answer > question', 'many:one', 'answers'], ['question > cat', 'many:one'], ['cat > cat', 'many:one', 'parent'],
] };

const ids = svg => [...svg.matchAll(/\sid="([^"]*)"/g)].map(m => m[1]);
const refs = svg => [
  ...[...svg.matchAll(/url\(#([^)]+)\)/g)].map(m => m[1]),
  ...[...svg.matchAll(/href="#([^"]+)"/g)].map(m => m[1]),
  ...[...svg.matchAll(/aria-(?:labelledby|describedby)="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)),
];

for (const [spec, nodes] of [[SEQ, ['ui', 'api', 'db', 'm1', 'm2', 'm3', 'm4']], [WF, ['build', 'ok', 'deploy', 'fix']], [ERD, ['question', 'answer', 'cat']]]) {
  test(`${spec.type}: every node carries its id and label`, () => {
    const out = render(spec);
    assert.deepEqual(out.nodes, nodes);
    for (const id of nodes) assert.match(out.svg, new RegExp(`data-node-id="${id}" data-node-label="[^"]+"`));
  });

  test(`${spec.type}: ids carry the prefix and every reference resolves`, () => {
    const a = render(spec, { prefix: 'one-' }).svg;
    const b = render(spec, { prefix: 'two-' }).svg;
    assert.ok(ids(a).length && ids(a).every(id => id.startsWith('one-')));
    assert.ok(refs(a).length);
    for (const ref of refs(a)) assert.ok(ids(a).includes(ref), ref);
    assert.deepEqual(ids(a).filter(id => ids(b).includes(id)), []);
  });

  test(`${spec.type}: output is deterministic`, () => {
    assert.equal(render(spec).svg, render(spec).svg);
  });
}

test('the svg has a natural size, an accessible title and no inline style', () => {
  const { svg } = render(WF, { prefix: 'p-' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+(\.\d+)? \d+(\.\d+)?" width="\d+(\.\d+)?" height="\d+(\.\d+)?"/);
  assert.match(svg, /<title id="p-title">Release<\/title>/);
  assert.doesNotMatch(svg, /<style/);
});

test('labels are escaped', () => {
  const { svg } = render({ type: 'workflow', title: '<b>', rows: [['a', '<script>alert(1)</script>']] });
  assert.doesNotMatch(svg, /<script>|<b>/);
  assert.match(svg, /&lt;script&gt;/);
});

test('sequence: each phase band carries its index as data-segment-id', () => {
  const { svg } = render(SEQ);
  assert.deepEqual([...svg.matchAll(/data-segment-id="(\d+)"/g)].map(m => m[1]), ['0', '1']);
});

test('sequence: each message is a node with a hit area that needs no stylesheet', () => {
  const { svg } = render(SEQ);
  const groups = [...svg.matchAll(/<g data-node-id="(m\d+)" data-node-label="([^"]*)" class="dg-message">(.*?)<\/g>/g)];
  assert.deepEqual(groups.map(g => [g[1], g[2]]), [['m1', 'POST /questions'], ['m2', '202 queued'], ['m3', 'save answer'], ['m4', 'index']]);
  for (const g of groups) assert.match(g[3], /<rect class="dg-hit" [^>]*fill="none" pointer-events="all"/);
});

test('sequence: a return message is dashed with an open arrow', () => {
  const { svg } = render(SEQ, { prefix: 'p-' });
  assert.match(svg, /class="dg-msg v-return"[^>]*marker-end="url\(#p-open\)"/);
});

test('workflow: a decision is drawn as a decision', () => {
  const { svg } = render(WF);
  assert.match(svg, /data-node-id="ok"[^>]*class="dg-node t-security dg-decision"/);
});

test('workflow: lanes are drawn with their labels', () => {
  const { svg } = render(WF);
  assert.match(svg, /class="dg-lane"/);
  assert.match(svg, />Prepare</);
  assert.match(svg, />Ship</);
});

test('workflow: a long chain without lanes is laid out top to bottom', () => {
  const rows = Array.from({ length: 9 }, (_, i) => [`s${i}`, `Step ${i}`]);
  for (let i = 1; i < 9; i++) rows.push([`s${i - 1} > s${i}`]);
  const [, w, h] = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(render({ type: 'workflow', title: 'Chain', rows }).svg).map(Number);
  assert.ok(h > w, `${w}x${h}`);
});

test('erd: many ends get a crow foot and one ends a bar', () => {
  const { svg } = render(ERD);
  assert.match(svg, /class="dg-card dg-many"/);
  assert.match(svg, /class="dg-card dg-one"/);
  assert.match(svg, />answers</);
  assert.match(svg, />parent</);
});

test('erd: fields show their keys', () => {
  const { svg } = render(ERD);
  assert.match(svg, />PK</);
  assert.match(svg, />FK</);
  assert.match(svg, />question_id</);
});

test('bad rows throw with the row named', () => {
  assert.throws(() => render({ type: 'workflow', title: 'x', rows: [['api', 'Start'], ['api > missing', '']] }), /Row 2: .*missing/);
});

test('the stylesheet is scoped and follows the colour scheme', () => {
  const css = stylesheet('.pl-diagram');
  assert.ok(css.length > 200);
  for (const rule of css.replace(/@media[^{]+\{/g, '').split('}').map(r => r.trim()).filter(r => r && r.includes('{'))) {
    assert.ok(rule.split('{')[0].split(',').every(s => s.trim().startsWith('.pl-diagram')), rule);
  }
  assert.match(css, /@media \(prefers-color-scheme: ?dark\)/);
  assert.equal(render(WF, { scope: '.x' }).css, stylesheet('.x'));
});

// [classes, types] of a plain descendant selector, enough to compare the rules below.
const specificity = sel => sel.trim().split(/\s+/).reduce(([c, t], part) =>
  [c + (part.match(/\.[\w-]+/g) || []).length, t + (/^[a-z]/i.test(part) ? 1 : 0)], [0, 0]);
const beats = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

test('a scope on the root itself takes the .dg rules onto that root', () => {
  const css = stylesheet('svg.dg');
  assert.match(css, /\}svg\.dg\{display:block;/);
  assert.match(css, /\}svg\.dg text\{fill:var\(--dg-ink\)\}/);
  assert.doesNotMatch(css, /svg\.dg \.dg[\s{,]/);
  for (const inner of ['svg.dg .dg-lane text', 'svg.dg .dg-elabel text', 'svg.dg .k-pk text', 'svg.dg .dg-ftype']) {
    assert.ok(css.includes(`${inner}{`), inner);
    assert.ok(beats(specificity(inner), specificity('svg.dg text')), `${inner} must beat svg.dg text`);
  }
});

test('a scope around the root keeps the .dg rules nested under it', () => {
  for (const scope of ['.dg-host', '.pl-diagram']) {
    const css = stylesheet(scope);
    assert.ok(css.includes(`${scope} .dg{display:block;`), scope);
    assert.ok(css.includes(`${scope} .dg text{fill:var(--dg-ink)}`), scope);
  }
});
