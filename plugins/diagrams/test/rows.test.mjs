import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows } from '../lib/rows.mjs';

const fails = (type, rows, pattern) => assert.throws(() => parseRows(type, rows), pattern);

test('rows must be arrays of strings', () => {
  fails('workflow', 'nope', /rows must be a list/);
  fails('workflow', [['a', 'A'], 'b'], /Row 2: .*list of strings/);
  fails('workflow', [['a', 3]], /Row 1: .*list of strings/);
});

test('an unknown diagram type is rejected', () => {
  fails('gantt', [['a', 'A']], /type must be one of sequence, workflow, erd/);
});

// ---- sequence ----

test('sequence: actors, messages, phases and default types', () => {
  const m = parseRows('sequence', [
    ['actor ui', 'Page', 'frontend'],
    ['actor api', 'Server'],
    ['phase', 'Ask'],
    ['ui', 'api', 'POST /questions'],
    ['Server', 'ui', '202 queued', 'return'],
    ['phase', 'Store'],
    ['api', 'api', 'save', 'emphasis'],
  ]);
  assert.deepEqual(m.actors, [
    { id: 'ui', label: 'Page', type: 'frontend' },
    { id: 'api', label: 'Server', type: 'backend' },
  ]);
  assert.deepEqual(m.messages, [
    { id: 'm1', from: 'ui', to: 'api', label: 'POST /questions', variant: 'default' },
    { id: 'm2', from: 'api', to: 'ui', label: '202 queued', variant: 'return' },
    { id: 'm3', from: 'api', to: 'api', label: 'save', variant: 'emphasis' },
  ]);
  assert.deepEqual(m.phases, [{ label: 'Ask', first: 0, last: 1 }, { label: 'Store', first: 2, last: 2 }]);
});

test('sequence: an undeclared name becomes an external actor', () => {
  const m = parseRows('sequence', [['actor ui', 'Page'], ['ui', 'Payment Gateway', 'charge']]);
  assert.deepEqual(m.actors[1], { id: 'payment-gateway', label: 'Payment Gateway', type: 'external' });
  assert.equal(m.messages[0].to, 'payment-gateway');
});

test('sequence: the message id form m<n> is kept for messages', () => {
  const m = parseRows('sequence', [['actor ui', 'Page'], ['ui', 'M1', 'ask']]);
  assert.equal(m.actors[1].label, 'M1');
  assert.notEqual(m.actors[1].id, 'm1');
  fails('sequence', [['actor m2', 'Second'], ['m2', 'm2', 'x']], /Row 1: actor id "m2" is kept for message 2/);
});

test('sequence: actor rows may come after the messages that use them', () => {
  const m = parseRows('sequence', [['ui', 'api', 'ask'], ['actor ui', 'Page'], ['actor api', 'Server']]);
  assert.deepEqual(m.actors.map(a => a.id), ['ui', 'api']);
});

test('sequence: errors name the row and the problem', () => {
  fails('sequence', [['actor ui', 'Page']], /needs at least one message/);
  fails('sequence', [['phase', 'Ask'], ['phase', 'Two'], ['a', 'b', 'x']], /Row 1: phase "Ask" has no message/);
  fails('sequence', [['actor 9x', 'Bad'], ['a', 'b', 'x']], /Row 1: id "9x"/);
  fails('sequence', [['actor a', 'A'], ['actor a', 'B'], ['a', 'a', 'x']], /Row 2: actor "a" is declared twice/);
  fails('sequence', [['actor a', 'A', 'robot'], ['a', 'a', 'x']], /Row 1: type "robot"/);
  fails('sequence', [['a', 'b', 'x', 'loud']], /Row 1: variant "loud"/);
  fails('sequence', [['a', 'b', '']], /Row 1: .*label/);
});

// ---- workflow ----

test('workflow: nodes, edges, lanes and decisions', () => {
  const m = parseRows('workflow', [
    ['lane prep', 'Prepare'],
    ['lane ship', 'Ship'],
    ['build', 'Build', '', 'prep'],
    ['ok', 'Tests green?', 'backend', 'prep'],
    ['deploy', 'Deploy', 'cloud', 'ship'],
    ['build > ok'],
    ['ok>deploy', 'yes', 'emphasis'],
  ]);
  assert.deepEqual(m.lanes, [{ id: 'prep', label: 'Prepare' }, { id: 'ship', label: 'Ship' }]);
  assert.deepEqual(m.nodes, [
    { id: 'build', label: 'Build', type: 'backend', lane: 'prep', decision: false },
    { id: 'ok', label: 'Tests green?', type: 'backend', lane: 'prep', decision: true },
    { id: 'deploy', label: 'Deploy', type: 'cloud', lane: 'ship', decision: false },
  ]);
  assert.deepEqual(m.edges, [
    { from: 'build', to: 'ok', label: '', variant: 'default' },
    { from: 'ok', to: 'deploy', label: 'yes', variant: 'emphasis' },
  ]);
});

test('workflow: with lanes declared, a node without a lane joins the first lane', () => {
  const m = parseRows('workflow', [['lane a', 'A'], ['lane b', 'B'], ['x', 'X']]);
  assert.equal(m.nodes[0].lane, 'a');
});

test('workflow: errors name the row and the problem', () => {
  fails('workflow', [['lane a', 'A']], /needs at least one node/);
  fails('workflow', [['api', 'Start'], ['api > missing', '']], /Row 2: edge "api > missing" names unknown node "missing"/);
  fails('workflow', [['a', 'A'], ['a > a']], /Row 2: .*itself/);
  fails('workflow', [['a', 'A', 'backend', 'nowhere']], /Row 1: lane "nowhere" is not declared/);
  fails('workflow', [['a', 'A'], ['a', 'B']], /Row 2: node "a" is declared twice/);
  fails('workflow', [['a', 'A'], ['b', 'B'], ['a > b', 'x', 'y', 'z']], /Row 3: .*at most 3 cells/);
});

// ---- erd ----

test('erd: entities, fields with keys and references, relationships', () => {
  const m = parseRows('erd', [
    ['entity question', 'Question'],
    ['entity answer', 'Answer'],
    ['question.id', 'bigint', 'pk'],
    ['answer.id', 'bigint', 'pk'],
    ['answer.question_id', 'bigint', 'fk, uk', 'question.id'],
    ['answer > question', 'many:one', 'answers'],
  ]);
  assert.deepEqual(m.entities[1], {
    id: 'answer', label: 'Answer', fields: [
      { name: 'id', type: 'bigint', keys: ['pk'], ref: null },
      { name: 'question_id', type: 'bigint', keys: ['fk', 'uk'], ref: { entity: 'question', field: 'id' } },
    ],
  });
  assert.deepEqual(m.rels, [{ from: 'answer', to: 'question', fromCard: 'many', toCard: 'one', label: 'answers' }]);
});

test('erd: a self relationship is allowed', () => {
  const m = parseRows('erd', [['entity cat', 'Category'], ['cat > cat', 'many:one', 'parent']]);
  assert.equal(m.rels[0].from, m.rels[0].to);
});

test('erd: errors name the row and the problem', () => {
  fails('erd', [], /needs at least one entity/);
  fails('erd', [['entity a', 'A'], ['b.id', 'int']], /Row 2: field "b.id" names unknown entity "b"/);
  fails('erd', [['entity a', 'A'], ['a.id', 'int', 'primary']], /Row 2: key "primary"/);
  fails('erd', [['entity a', 'A'], ['a.id', 'int', 'fk', 'b.id']], /Row 2: reference "b.id" names unknown entity "b"/);
  fails('erd', [['entity a', 'A'], ['a.x', 'int', 'fk', 'a.nope']], /Row 2: reference "a.nope" names unknown field/);
  fails('erd', [['entity a', 'A'], ['a > b', 'one:many']], /Row 2: .*unknown entity "b"/);
  fails('erd', [['entity a', 'A'], ['entity b', 'B'], ['a > b', 'lots']], /Row 3: cardinality "lots"/);
  fails('erd', [['entity a', 'A'], ['a.id', '']], /Row 2: .*type/);
});
