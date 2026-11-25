// Compact rows to a diagram model. A row is a list of string cells; the grammar is in
// skills/diagram/reference/rows.md. Every error names the 1-based row it comes from.

export const TYPES = ['sequence', 'workflow', 'erd', 'state', 'tree'];
export const NODE_TYPES = ['frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external', 'focus'];
export const VARIANTS = ['default', 'emphasis', 'security', 'dashed'];
const KEYS = ['pk', 'fk', 'uk'];
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MESSAGE_ID = /^m([1-9]\d*)$/; // a sequence's n-th message is node m<n>

class RowError extends Error {}
const fail = (i, message) => { throw new RowError(i === null ? message : `Row ${i + 1}: ${message}`); };

function cellCount(row, i, kind, min, max) {
  if (row.length > max) fail(i, `a ${kind} row has at most ${max} cells, got ${row.length}`);
  if (row.length < min) fail(i, `a ${kind} row needs at least ${min} cells, got ${row.length}`);
}
function checkId(id, i) {
  if (!ID.test(id)) fail(i, `id "${id}" must start with a letter and use only letters, digits, - and _`);
  return id;
}
function oneOf(value, allowed, what, i, fallback) {
  if (!value) return fallback;
  if (!allowed.includes(value)) fail(i, `${what} "${value}" is not one of ${allowed.join(', ')}`);
  return value;
}
const needLabel = (label, i, what) => label || fail(i, `${what} needs a label`);

function normalise(rows) {
  if (!Array.isArray(rows)) fail(null, 'rows must be a list of rows');
  return rows.map((row, i) => {
    if (!Array.isArray(row) || !row.length || row.some(c => typeof c !== 'string')) fail(i, 'a row must be a non-empty list of strings');
    return row.map(c => c.trim());
  });
}

/** Parses `rows` of diagram `type` into its model, or throws an Error naming the bad row. */
export function parseRows(type, rows) {
  if (!TYPES.includes(type)) fail(null, `type must be one of ${TYPES.join(', ')}, got "${type}"`);
  const list = normalise(rows);
  return { sequence, workflow, erd, state, tree }[type](list);
}

// ---- sequence --------------------------------------------------------------------------------

function sequence(rows) {
  const actors = [];
  const byId = new Map();
  rows.forEach((row, i) => {
    const m = /^actor\s+(\S+)$/.exec(row[0]);
    if (!m) return;
    cellCount(row, i, 'actor', 2, 3);
    const id = checkId(m[1], i);
    const kept = MESSAGE_ID.exec(id);
    if (kept) fail(i, `actor id "${id}" is kept for message ${kept[1]}; pick another id`);
    if (byId.has(id)) fail(i, `actor "${id}" is declared twice`);
    const actor = { id, label: needLabel(row[1], i, 'an actor'), type: oneOf(row[2], NODE_TYPES, 'type', i, 'backend') };
    actors.push(actor);
    byId.set(id, actor);
  });

  const resolve = name => {
    if (byId.has(name)) return name;
    const found = actors.find(a => a.label === name);
    if (found) return found.id;
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    let id = ID.test(slug) ? slug : `actor-${actors.length + 1}`;
    for (let n = 2; byId.has(id) || MESSAGE_ID.test(id); n++) id = `${slug || 'actor'}-${n}`;
    const actor = { id, label: name, type: 'external' };
    actors.push(actor);
    byId.set(id, actor);
    return id;
  };

  const messages = [];
  const phases = [];
  let open = null;
  const close = () => {
    if (open && open.first === messages.length) fail(open.row, `phase "${open.label}" has no message after it`);
    if (open) phases.push({ label: open.label, first: open.first, last: messages.length - 1 });
  };
  rows.forEach((row, i) => {
    if (/^actor\s/.test(row[0])) return;
    if (row[0] === 'phase') {
      cellCount(row, i, 'phase', 2, 2);
      close();
      open = { label: needLabel(row[1], i, 'a phase'), first: messages.length, row: i };
      return;
    }
    cellCount(row, i, 'message', 3, 4);
    if (!row[0] || !row[1]) fail(i, 'a message needs a sender and a receiver');
    const label = needLabel(row[2], i, 'a message');
    const variant = oneOf(row[3], [...VARIANTS, 'return'], 'variant', i, 'default');
    messages.push({ id: `m${messages.length + 1}`, from: resolve(row[0]), to: resolve(row[1]), label, variant });
  });
  close();
  if (!messages.length) fail(null, 'a sequence needs at least one message');
  return { actors, messages, phases };
}

// ---- workflow --------------------------------------------------------------------------------

const EDGE = /^([^>\s]+)\s*>\s*([^>\s]+)$/;

function parseEdge(row, i) {
  const m = EDGE.exec(row[0]);
  if (!m) fail(i, `edge "${row[0]}" must read "from > to"`);
  return [m[1], m[2]];
}

function workflow(rows) {
  const lanes = [];
  rows.forEach((row, i) => {
    const m = /^lane\s+(\S+)$/.exec(row[0]);
    if (!m) return;
    cellCount(row, i, 'lane', 2, 2);
    const id = checkId(m[1], i);
    if (lanes.some(l => l.id === id)) fail(i, `lane "${id}" is declared twice`);
    lanes.push({ id, label: needLabel(row[1], i, 'a lane') });
  });

  const nodes = [];
  rows.forEach((row, i) => {
    if (/^lane\s/.test(row[0]) || row[0].includes('>')) return;
    cellCount(row, i, 'node', 2, 4);
    const id = checkId(row[0], i);
    if (nodes.some(n => n.id === id)) fail(i, `node "${id}" is declared twice`);
    const label = needLabel(row[1], i, 'a node');
    const lane = row[3] || lanes[0]?.id || null;
    if (lane && !lanes.some(l => l.id === lane)) fail(i, `lane "${lane}" is not declared`);
    nodes.push({ id, label, type: oneOf(row[2], NODE_TYPES, 'type', i, 'backend'), lane, decision: /[?？]$/.test(label) });
  });
  if (!nodes.length) fail(null, 'a workflow needs at least one node');

  const edges = [];
  rows.forEach((row, i) => {
    if (!row[0].includes('>')) return;
    cellCount(row, i, 'edge', 1, 3);
    const [from, to] = parseEdge(row, i);
    for (const end of [from, to]) if (!nodes.some(n => n.id === end)) fail(i, `edge "${row[0]}" names unknown node "${end}"`);
    if (from === to) fail(i, `edge "${row[0]}" joins a node to itself`);
    edges.push({ from, to, label: row[1] || '', variant: oneOf(row[2], VARIANTS, 'variant', i, 'default') });
  });
  return { lanes, nodes, edges };
}

// ---- erd -------------------------------------------------------------------------------------

function erd(rows) {
  const entities = [];
  const byId = new Map();
  rows.forEach((row, i) => {
    const m = /^entity\s+(\S+)$/.exec(row[0]);
    if (!m) return;
    cellCount(row, i, 'entity', 2, 2);
    const id = checkId(m[1], i);
    if (byId.has(id)) fail(i, `entity "${id}" is declared twice`);
    const entity = { id, label: needLabel(row[1], i, 'an entity'), fields: [] };
    entities.push(entity);
    byId.set(id, entity);
  });
  if (!entities.length) fail(null, 'an erd needs at least one entity');

  const refs = [];
  rows.forEach((row, i) => {
    if (/^entity\s/.test(row[0]) || row[0].includes('>')) return;
    cellCount(row, i, 'field', 2, 4);
    const m = /^([^.\s]+)\.([^.\s]+)$/.exec(row[0]);
    if (!m) fail(i, `field "${row[0]}" must read "entity.field"`);
    const entity = byId.get(m[1]) || fail(i, `field "${row[0]}" names unknown entity "${m[1]}"`);
    if (!FIELD.test(m[2])) fail(i, `field name "${m[2]}" must use only letters, digits and _`);
    if (entity.fields.some(f => f.name === m[2])) fail(i, `field "${row[0]}" is declared twice`);
    const keys = (row[2] || '').split(',').map(k => k.trim()).filter(Boolean);
    for (const k of keys) oneOf(k, KEYS, 'key', i);
    let ref = null;
    if (row[3]) {
      const r = /^([^.\s]+)\.([^.\s]+)$/.exec(row[3]);
      if (!r) fail(i, `reference "${row[3]}" must read "entity.field"`);
      ref = { entity: r[1], field: r[2] };
      refs.push({ ref, text: row[3], i });
    }
    entity.fields.push({ name: m[2], type: row[1] || fail(i, `field "${row[0]}" needs a type`), keys, ref });
  });
  for (const { ref, text, i } of refs) {
    const target = byId.get(ref.entity) || fail(i, `reference "${text}" names unknown entity "${ref.entity}"`);
    if (!target.fields.some(f => f.name === ref.field)) fail(i, `reference "${text}" names unknown field "${ref.field}"`);
  }

  const rels = [];
  rows.forEach((row, i) => {
    if (!row[0].includes('>')) return;
    cellCount(row, i, 'relationship', 2, 3);
    const [from, to] = parseEdge(row, i);
    for (const end of [from, to]) if (!byId.has(end)) fail(i, `relationship "${row[0]}" names unknown entity "${end}"`);
    const card = /^(one|many):(one|many)$/.exec(row[1]) || fail(i, `cardinality "${row[1]}" is not one of one:one, one:many, many:one, many:many`);
    rels.push({ from, to, fromCard: card[1], toCard: card[2], label: row[2] || '' });
  });
  return { entities, rels };
}

// ---- state -----------------------------------------------------------------------------------

function state(rows) {
  const states = [];
  const markers = [];
  const ids = new Set();
  const order = []; // markers and states in the order the rows declare them
  const declare = (id, i, what) => {
    if (ids.has(id)) fail(i, `${what} "${id}" is declared twice`);
    ids.add(id);
    order.push(id);
  };
  rows.forEach((row, i) => {
    if (row[0].includes('>')) return;
    const m = /^(initial|final)\s+(\S+)$/.exec(row[0]);
    if (m) {
      cellCount(row, i, m[1], 1, 1);
      const id = checkId(m[2], i);
      declare(id, i, `${m[1]} marker`);
      markers.push({ id, kind: m[1] });
      return;
    }
    cellCount(row, i, 'state', 2, 4);
    const id = checkId(row[0], i);
    declare(id, i, 'state');
    // The group cell is kept in the model; groups are drawn once the engine supports them.
    states.push({ id, label: needLabel(row[1], i, 'a state'), type: oneOf(row[2], NODE_TYPES, 'type', i, 'backend'), group: row[3] || null });
  });
  if (!states.length) fail(null, 'a state diagram needs at least one state');

  const kind = new Map(markers.map(m => [m.id, m.kind]));
  const transitions = [];
  rows.forEach((row, i) => {
    if (!row[0].includes('>')) return;
    cellCount(row, i, 'transition', 1, 3);
    const [from, to] = parseEdge(row, i);
    for (const end of [from, to]) if (!ids.has(end)) fail(i, `unknown state "${end}"`);
    if (kind.get(from) === 'final') fail(i, `final marker "${from}" cannot have a transition leaving it`);
    if (kind.get(to) === 'initial') fail(i, `initial marker "${to}" cannot have a transition entering it`);
    transitions.push({ from, to, label: row[1] || '', variant: oneOf(row[2], VARIANTS, 'variant', i, 'default') });
  });
  return { states, markers, transitions, order };
}

// ---- tree ------------------------------------------------------------------------------------

function tree(rows) {
  const nodes = [];
  const ids = new Set();
  rows.forEach((row, i) => {
    if (row[0].includes('>')) return;
    cellCount(row, i, 'node', 2, 3);
    const id = checkId(row[0], i);
    if (ids.has(id)) fail(i, `node "${id}" is declared twice`);
    ids.add(id);
    nodes.push({ id, label: needLabel(row[1], i, 'a node'), type: oneOf(row[2], NODE_TYPES, 'type', i, 'backend') });
  });
  if (!nodes.length) fail(null, 'a tree needs at least one node');

  const parent = new Map();
  const edges = [];
  rows.forEach((row, i) => {
    if (!row[0].includes('>')) return;
    cellCount(row, i, 'edge', 1, 1);
    const [from, to] = parseEdge(row, i);
    for (const end of [from, to]) if (!ids.has(end)) fail(i, `unknown node "${end}"`);
    if (parent.has(to)) fail(i, `${to} already has a parent (${parent.get(to)})`);
    for (let up = from; up !== undefined; up = parent.get(up)) {
      if (up === to) fail(i, `edge "${row[0]}" makes a cycle`);
    }
    parent.set(to, from);
    edges.push({ from, to });
  });
  return { nodes, edges };
}
