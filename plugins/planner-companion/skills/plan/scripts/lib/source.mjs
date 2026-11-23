// The plan source format: load, validate and index. See reference/source-format.md.
import fs from 'node:fs';

export const CODE_RE = /\b([DTS])(\d+)\b/g;
const KINDS = { D: 'decision', T: 'task', S: 'scenario' };
const COLLECTIONS = { D: 'decisions', T: 'tasks', S: 'scenarios' };
const ID_RE = /^([DTS])(\d+)$/;
// A domain id is used in tab anchors, `domain:<id>` codes and `check:<id>.<n>` ask targets.
const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const DIAGRAM_TYPES = new Set(['sequence', 'workflow', 'erd']);
const MANDATORY_SLOTS = ['scale', 'dataFrom'];

export function loadSource(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const list = value => (Array.isArray(value) ? value : []);
const isRows = rows => Array.isArray(rows) && rows.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'));
const elements = source => Object.entries(COLLECTIONS).flatMap(([letter, key]) => list(source[key]).map(el => ({ letter, key, el })));
const at = (key, el, rest = '') => `${key}[${el.id}]${rest}`;

// Every place a code is referenced, as {owner, target, path}. owner is an element id, a section
// name (summary, constraints, reviewFocus) or null when the reference does not count as a use.
// Steps' code and run, more.touches and diagram rows are never scanned.
function references(source) {
  const refs = [];
  const add = (owner, path, targets) => list(targets).forEach(target => refs.push({ owner, target, path }));
  const prose = (owner, path, text) => {
    if (typeof text !== 'string') return;
    for (const m of text.matchAll(CODE_RE)) refs.push({ owner, target: m[0], path });
  };
  prose(null, 'goal', source.goal);
  prose(null, 'architecture', source.architecture);
  list(source.summary).forEach((t, i) => prose('summary', `summary[${i}]`, t));
  list(source.constraints).forEach((t, i) => prose('constraints', `constraints[${i}]`, t));
  list(source.reviewFocus).forEach((r, i) => {
    prose('reviewFocus', `reviewFocus[${i}].text`, r?.text);
    if (r?.test) add('reviewFocus', `reviewFocus[${i}].test`, [r.test]);
  });
  add(null, 'checkFirst', source.checkFirst);
  list(source.domains).forEach(d => list(d.checks).forEach((t, i) => prose(null, `domains[${d.id}].checks[${i}]`, t)));
  for (const el of list(source.decisions)) {
    const p = rest => at('decisions', el, rest);
    prose(el.id, p('.title'), el.title);
    prose(el.id, p('.whyPick'), el.whyPick);
    list(el.options).forEach((o, i) => { prose(el.id, p(`.options[${i}].label`), o?.label); prose(el.id, p(`.options[${i}].why`), o?.why); });
    for (const [slot, text] of Object.entries(el.slots || {})) prose(el.id, p(`.slots.${slot}`), text);
    prose(el.id, p('.more.why'), el.more?.why);
    add(el.id, p('.more.related'), el.more?.related);
    prose(el.id, p('.removed.note'), el.removed?.note);
    add(el.id, p('.removed.replacedBy'), el.removed?.replacedBy);
  }
  for (const el of list(source.tasks)) {
    const p = rest => at('tasks', el, rest);
    prose(el.id, p('.title'), el.title);
    add(el.id, p('.decisions'), el.decisions);
    add(el.id, p('.after'), el.after);
    prose(el.id, p('.interfaces.consumes'), el.interfaces?.consumes);
    prose(el.id, p('.interfaces.produces'), el.interfaces?.produces);
    list(el.steps).forEach((s, i) => { prose(el.id, p(`.steps[${i}].title`), s?.title); prose(el.id, p(`.steps[${i}].body`), s?.body); prose(el.id, p(`.steps[${i}].expect`), s?.expect); });
  }
  for (const el of list(source.scenarios)) {
    const p = rest => at('scenarios', el, rest);
    prose(el.id, p('.title'), el.title);
    prose(el.id, p('.expected'), el.expected);
    add(el.id, p('.tasks'), el.tasks);
  }
  return refs.filter(r => r.owner !== r.target);
}

function checkRows(out, path, rows) {
  if (!isRows(rows)) out.push({ code: 'diagram-rows', path, message: 'rows must be an array of arrays of strings' });
}

function checkDiagram(out, path, diagram) {
  if (!DIAGRAM_TYPES.has(diagram.type)) out.push({ code: 'diagram-type', path: `${path}.type`, message: `diagram type must be one of sequence, workflow, erd (got ${JSON.stringify(diagram.type)})` });
  checkRows(out, `${path}.rows`, diagram.rows);
}

function checkIds(out, source, previous) {
  const seen = new Set();
  for (const { letter, key, el } of elements(source)) {
    const m = ID_RE.exec(el.id ?? '');
    const path = at(key, el);
    if (!m || m[1] !== letter) { out.push({ code: 'id-format', path, message: `id ${JSON.stringify(el.id)} must look like ${letter}<number>` }); continue; }
    if (seen.has(el.id)) out.push({ code: 'id-duplicate', path, message: `id ${el.id} is used twice` });
    seen.add(el.id);
    if (Number(m[2]) > (source.counters?.[letter] ?? 0)) out.push({ code: 'id-counter', path, message: `${el.id} is above counters.${letter} (${source.counters?.[letter] ?? 0})` });
  }
  if (!previous) return;
  for (const { letter, key, el } of elements(previous)) {
    if (!list(source[COLLECTIONS[letter]]).some(x => x.id === el.id)) out.push({ code: 'id-dropped', path: at(key, el), message: `${el.id} existed in the previous source and was dropped; mark it removed instead` });
  }
  for (const letter of Object.keys(COLLECTIONS)) {
    const before = previous.counters?.[letter] ?? 0;
    const now = source.counters?.[letter] ?? 0;
    if (now < before) out.push({ code: 'counter-decreased', path: `counters.${letter}`, message: `counters.${letter} went from ${before} to ${now}; counters never decrease` });
  }
}

function checkDomains(out, source) {
  const seen = new Set();
  for (const d of list(source.domains)) {
    const path = `domains[${d?.id}]`;
    if (typeof d?.id !== 'string' || !SLUG_RE.test(d.id)) {
      out.push({ code: 'domain-id-format', path: `${path}.id`, message: `domain id ${JSON.stringify(d?.id)} must be a slug: lower-case letters, digits and hyphens, starting with a letter` });
    } else if (seen.has(d.id)) out.push({ code: 'id-duplicate', path, message: `domain id ${d.id} is used twice` });
    seen.add(d?.id);
  }
}

function checkDecision(out, el, domainIds) {
  const p = rest => at('decisions', el, rest);
  if (el.domain !== null && el.domain !== undefined && !domainIds.has(el.domain)) out.push({ code: 'domain-unknown', path: p('.domain'), message: `domain ${JSON.stringify(el.domain)} is not in domains` });
  if (el.removed) return;
  for (const slot of MANDATORY_SLOTS) {
    if (!el.slots?.[slot]) out.push({ code: 'slot-missing', path: p(`.slots.${slot}`), message: `a live decision needs slots.${slot}` });
  }
  const keys = new Set(list(el.options).map(o => o?.key));
  if (el.state === 'settled') {
    if (!el.pick) out.push({ code: 'pick-missing', path: p('.pick'), message: 'a settled decision needs pick' });
    else if (!keys.has(el.pick)) out.push({ code: 'pick-unknown', path: p('.pick'), message: `pick ${JSON.stringify(el.pick)} is not an option key` });
    if (!el.whyPick) out.push({ code: 'pick-missing', path: p('.whyPick'), message: 'a settled decision needs whyPick' });
  }
  if (el.state === 'open') {
    if (!el.recommended) out.push({ code: 'recommended-missing', path: p('.recommended'), message: 'an open decision needs recommended' });
    else if (!keys.has(el.recommended)) out.push({ code: 'recommended-unknown', path: p('.recommended'), message: `recommended ${JSON.stringify(el.recommended)} is not an option key` });
  }
}

export function validateSource(source, { previous } = {}) {
  const out = [];
  const domainIds = new Set(list(source.domains).map(d => d.id));
  checkIds(out, source, previous);
  checkDomains(out, source);
  for (const el of list(source.decisions)) checkDecision(out, el, domainIds);
  for (const el of list(source.scenarios)) {
    if (!domainIds.has(el.domain)) out.push({ code: 'domain-unknown', path: at('scenarios', el, '.domain'), message: `domain ${JSON.stringify(el.domain)} is not in domains` });
  }
  for (const d of list(source.domains)) if (d.diagram) checkDiagram(out, `domains[${d.id}].diagram`, d.diagram);
  if (source.flow) {
    checkRows(out, 'flow.rows', source.flow.rows);
    for (const [phase, domain] of Object.entries(source.flow.phaseDomains || {})) {
      if (!domainIds.has(domain)) out.push({ code: 'domain-unknown', path: `flow.phaseDomains.${phase}`, message: `domain ${JSON.stringify(domain)} is not in domains` });
    }
  }
  if (source.entities) checkRows(out, 'entities.rows', source.entities.rows);
  const ids = new Set(elements(source).map(({ el }) => el.id));
  for (const { target, path } of references(source)) {
    if (!ids.has(target)) out.push({ code: 'ref-unknown', path, message: `${target} does not exist` });
  }
  return out;
}

export function buildIndex(source) {
  const index = new Map();
  const domainIds = list(source.domains).map(d => d.id);
  const flat = domainIds.length <= 1;
  for (const { letter, el } of elements(source)) {
    const domain = letter === 'T' ? null : el.domain;
    index.set(el.id, {
      kind: KINDS[letter],
      title: el.title,
      tab: flat || !domain ? 'overview' : domain,
      removed: Boolean(el.removed),
      replacedBy: list(el.removed?.replacedBy),
      uses: [],
    });
  }
  for (const { owner, target } of references(source)) {
    const entry = index.get(target);
    if (entry && owner && !entry.uses.includes(owner)) entry.uses.push(owner);
  }
  return index;
}
