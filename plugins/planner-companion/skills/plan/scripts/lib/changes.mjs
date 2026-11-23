// Working-copy writes: author patches, user changes and picks, undo, and "update the real plan".
// Every function takes the lock, so the server and the session CLI can write concurrently.
import fs from 'node:fs';
import { validateSource } from './source.mjs';
import { renderMarkdown } from './markdown.mjs';
import { planPaths, readJson, withLock, writeJsonAtomic, writeTextAtomic } from './store.mjs';

const COLLECTIONS = { D: 'decisions', T: 'tasks', S: 'scenarios' };
const ID_RE = /^([DTS])(\d+)$/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// A touched code addresses one thing: D/T/S id, domain:<id> or field:<name>. Fields wrap their value
// as {value} so that before/after stay objects.
function locate(source, code) {
  if (ID_RE.test(code)) return { list: source[COLLECTIONS[code[0]]], key: 'id', id: code };
  if (code.startsWith('domain:')) return { list: source.domains, key: 'id', id: code.slice(7) };
  return null;
}

function read(source, code) {
  const where = locate(source, code);
  if (where) return clone(where.list.find(e => e[where.key] === where.id)) ?? null;
  const name = code.slice(6);
  return name in source ? { value: clone(source[name]) } : null;
}

function write(source, code, value) {
  const where = locate(source, code);
  if (!where) {
    const name = code.slice(6);
    if (value === null) delete source[name]; else source[name] = value.value;
    return;
  }
  const at = where.list.findIndex(e => e[where.key] === where.id);
  if (value === null) { if (at >= 0) where.list.splice(at, 1); return; }
  if (at >= 0) where.list[at] = value; else where.list.push(value);
}

const codeOf = el => (ID_RE.test(el.id) ? el.id : `domain:${el.id}`);

function bumpCounters(source) {
  source.counters = source.counters || {};
  for (const [letter, key] of Object.entries(COLLECTIONS)) {
    for (const el of source[key] || []) {
      const m = ID_RE.exec(el.id);
      if (m && Number(m[2]) > (source.counters[letter] || 0)) source.counters[letter] = Number(m[2]);
    }
  }
}

// Apply the patch to a copy and record what moved. Does not validate or write.
function applyToCopy(current, patch) {
  const next = clone(current);
  next.domains = next.domains || [];
  for (const key of Object.values(COLLECTIONS)) next[key] = next[key] || [];
  const touched = [];
  const record = (code, value) => {
    const before = read(next, code);
    if (same(before, value)) return;
    write(next, code, clone(value));
    touched.push({ code, before, after: clone(value) });
  };
  for (const [name, value] of Object.entries(patch.set || {})) record(`field:${name}`, { value });
  const patchCodes = new Set();
  for (const el of patch.upsert || []) { patchCodes.add(codeOf(el)); record(codeOf(el), el); }
  return { next, touched, patchCodes };
}

// A changed decision flags the tasks built on it; a changed or flagged task flags its scenarios.
function flagLinks(next, touched, patchCodes) {
  const changed = new Set(touched.filter(t => ID_RE.test(t.code) && t.after).map(t => t.code));
  const flag = (list, linksOf, hit) => {
    for (const el of list) {
      if (el.removed || el.recheck || patchCodes.has(el.id)) continue;
      if (!(linksOf(el) || []).some(code => hit.has(code))) continue;
      const before = clone(el);
      el.recheck = true;
      touched.push({ code: el.id, before, after: clone(el) });
      changed.add(el.id);
    }
  };
  flag(next.tasks, t => t.decisions, changed);
  flag(next.scenarios, s => s.tasks, changed);
}

async function commit(dir, apply) {
  const paths = planPaths(dir);
  const current = readJson(paths.working);
  const result = apply(current, readJson(paths.changes));
  if (!result.write) return result.out;
  writeJsonAtomic(paths.working, result.write.working);
  if (result.write.changes) writeJsonAtomic(paths.changes, result.write.changes);
  return result.out;
}

function summaryOf(touched) {
  return touched.map(t => t.code).join(', ');
}

const PICK_FIELDS = ['state', 'pick', 'whyPick'];

// An upsert names its element by a string id. An author patch may not move an existing decision's
// pick (R60): a stale copy would silently revert a page pick, so picks move only through `pick` and
// change patches, which are logged and undoable. A new decision may set them.
function upsertDiagnostics(current, patch, kind) {
  const out = [];
  (patch.upsert || []).forEach((el, i) => {
    if (typeof el?.id !== 'string') {
      out.push({ code: 'id-missing', path: `upsert[${i}]`, message: 'an upserted element needs a string id' });
      return;
    }
    if (kind !== 'author') return;
    const was = (current.decisions || []).find(d => d.id === el.id);
    if (!was) return;
    for (const field of PICK_FIELDS.filter(f => !same(was[f], el[f]))) {
      out.push({
        code: 'pick-by-author', path: `decisions[${el.id}].${field}`,
        message: `an author patch cannot change ${field} of ${el.id}; settle it with pick or edit it with apply --kind change`,
      });
    }
  });
  return out;
}

function applyLocked(dir, patch, meta) {
  return commit(dir, (current, log) => {
    const refused = upsertDiagnostics(current, patch, meta.kind);
    if (refused.length) return { out: { ok: false, diagnostics: refused } };
    const { next, touched, patchCodes } = applyToCopy(current, patch);
    const recorded = meta.kind !== 'author';
    if (recorded) flagLinks(next, touched, patchCodes);
    if (recorded && touched.length === 0) return { out: { ok: true, change: null } };
    bumpCounters(next);
    const diagnostics = validateSource(next, { previous: current });
    if (diagnostics.length) return { out: { ok: false, diagnostics } };
    if (!recorded) return { out: { ok: true, change: null }, write: { working: next } };
    const change = {
      id: `c${log.next}`, kind: meta.kind, question: meta.question ?? null,
      at: new Date().toISOString(), summary: meta.summary || summaryOf(touched), touched,
    };
    return {
      out: { ok: true, change },
      write: { working: next, changes: { next: log.next + 1, log: [...log.log, change] } },
    };
  });
}

export function applyPatch(dir, patch, meta) {
  return withLock(dir, () => applyLocked(dir, patch, meta));
}

export function pick(dir, code, option, question) {
  return withLock(dir, async () => {
    const working = readJson(planPaths(dir).working);
    const decision = (working.decisions || []).find(d => d.id === code);
    const bad = (path, message, diag = 'pick-unknown') => ({ ok: false, diagnostics: [{ code: diag, path, message }] });
    if (!decision) return bad(code, `${code} is not a decision`, 'ref-unknown');
    const chosen = (decision.options || []).find(o => o.key === option);
    if (!chosen) return bad(`decisions[${code}].pick`, `${JSON.stringify(option)} is not an option key of ${code}`);
    if (decision.state === 'settled' && decision.pick === option) return { ok: true, change: null };
    const settled = { ...decision, state: 'settled', pick: option, whyPick: chosen.why };
    return applyLocked(dir, { upsert: [settled] }, {
      kind: 'pick', question, summary: `Picked option ${option} (${chosen.label}) for ${code}`,
    });
  });
}

// The later entries that touch a code the target (or an already-conflicting entry) touches.
function conflictSet(log, target) {
  const later = log.slice(log.indexOf(target) + 1);
  const codes = new Set(target.touched.map(t => t.code));
  const members = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of later) {
      if (members.has(entry) || !entry.touched.some(t => codes.has(t.code))) continue;
      members.add(entry);
      entry.touched.forEach(t => codes.add(t.code));
      grew = true;
    }
  }
  return later.filter(e => members.has(e));
}

// `dryRun` answers what a real undo would (a conflict, diagnostics or the ids it undoes) and writes
// nothing; the page uses it to confirm a plain undo before making it.
export function undo(dir, changeId, { withLater = false, dryRun = false } = {}) {
  return withLock(dir, async () => {
    const paths = planPaths(dir);
    const current = readJson(paths.working);
    const log = readJson(paths.changes);
    const target = log.log.find(c => c.id === changeId);
    if (!target) return { ok: false, diagnostics: [{ code: 'change-unknown', path: changeId, message: `${changeId} is not in the change log` }] };
    const conflict = conflictSet(log.log, target);
    if (conflict.length && !withLater) {
      return { ok: false, conflict: conflict.map(c => ({ id: c.id, summary: c.summary })) };
    }
    const order = [target, ...conflict].reverse();
    const next = clone(current);
    const deleted = [];
    for (const entry of order) {
      for (const t of [...entry.touched].reverse()) {
        write(next, t.code, clone(t.before));
        if (t.before === null && ID_RE.test(t.code)) deleted.push(t.code);
      }
    }
    const diagnostics = validateSource(next, { previous: current })
      .filter(d => !(d.code === 'id-dropped' && deleted.some(id => d.path.includes(`[${id}]`))));
    if (diagnostics.length) return { ok: false, diagnostics };
    if (dryRun) return { ok: true, dryRun: true, undone: order.map(c => c.id) };
    const undone = new Set(order);
    writeJsonAtomic(paths.working, next);
    writeJsonAtomic(paths.changes, { next: log.next, log: log.log.filter(c => !undone.has(c)) });
    return {
      ok: true, undone: order.map(c => c.id),
      changes: order.map(c => ({ id: c.id, summary: c.summary })),
      touched: [...new Set(order.flatMap(c => c.touched.map(t => t.code)))],
    };
  });
}

// plan.md is the execution input, so the real plan needs its header (R59); a draft may lack it.
const HEADER_FIELDS = ['goal', 'architecture', 'techStack'];
const headerDiagnostics = source => HEADER_FIELDS
  .filter(field => typeof source[field] !== 'string' || !source[field].trim())
  .map(field => ({ code: 'header-missing', path: field, message: `the real plan needs ${field}; set it before updating` }));

export function updateReal(dir) {
  return withLock(dir, async () => {
    const paths = planPaths(dir);
    const working = readJson(paths.working);
    const diagnostics = [...headerDiagnostics(working), ...validateSource(working)];
    if (diagnostics.length) return { ok: false, diagnostics };
    const log = readJson(paths.changes);
    writeTextAtomic(paths.real, fs.readFileSync(paths.working, 'utf8'));
    writeTextAtomic(paths.md, renderMarkdown(working));
    writeJsonAtomic(paths.changes, { next: log.next, log: [] });
    return { ok: true };
  });
}
