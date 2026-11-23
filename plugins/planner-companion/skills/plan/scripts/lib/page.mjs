// Renders the plan review page: state loading, diagram specs and the HTML. Everything is inlined
// (CSS, diagram CSS, client JS); the page makes no outbound request. Every source string is escaped.
import fs from 'node:fs';
import { buildIndex, CODE_RE } from './source.mjs';
import { renderDiagram } from './diagrams.mjs';
import { planPaths, readJson } from './store.mjs';
import { unanswered } from './queue.mjs';

const CSS = fs.readFileSync(new URL('../page/page.css', import.meta.url), 'utf8');
const CLIENT_JS = new URL('../page/client.js', import.meta.url);
const FIRST_RULES = 5;
const OPTIONAL_SLOTS = [['userSees', 'User sees'], ['names', 'Names'], ['dragsAlong', 'Drags along'], ['terms', 'Terms']];

const live = list => (Array.isArray(list) ? list : []).filter(e => !e.removed);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const num = id => Number(String(id).slice(1));

/** The client script shipped next to the page, or '' until it exists. */
export function loadClientJs() {
  try { return fs.readFileSync(CLIENT_JS, 'utf8'); } catch { return ''; }
}

export function loadPageState(dir) {
  const p = planPaths(dir);
  return {
    source: readJson(p.working),
    changes: readJson(p.changes),
    threads: readJson(p.threads),
    pending: unanswered(dir),
    hasReal: fs.existsSync(p.real),
  };
}

// One workflow node per live task (id t<n>), one edge per `after`.
function taskGraphRows(tasks) {
  const ids = new Set(tasks.map(t => t.id));
  const node = id => `t${num(id)}`;
  return [
    ...tasks.map(t => [node(t.id), `${t.id} ${t.title}`]),
    ...tasks.flatMap(t => (t.after || []).filter(a => ids.has(a)).map(a => [`${node(a)} > ${node(t.id)}`])),
  ];
}

export function pageDiagrams(source) {
  const specs = [];
  if (source.flow?.rows?.length) specs.push({ id: 'flow', type: 'sequence', title: source.flow.title, rows: source.flow.rows });
  for (const d of source.domains || []) {
    if (d.diagram?.rows?.length) specs.push({ ...d.diagram, id: `domain-${d.id}` });
  }
  if (source.entities?.rows?.length) specs.push({ id: 'entities', type: 'erd', title: source.entities.title, rows: source.entities.rows });
  const tasks = live(source.tasks);
  if (tasks.length) specs.push({ id: 'tasks', type: 'workflow', title: 'Task order', rows: taskGraphRows(tasks) });
  return specs;
}

// ---- context shared by the renderers -------------------------------------------------------

function makeContext(state, diagrams) {
  const { source } = state;
  const firstTouch = new Map();
  for (const change of state.changes.log) {
    for (const t of change.touched) if (!firstTouch.has(t.code)) firstTouch.set(t.code, t);
  }
  const domains = source.domains || [];
  return {
    source, diagrams, index: buildIndex(source), firstTouch, domains,
    flat: domains.length <= 1,
    threads: state.threads.threads,
    // An undo or update notice has no target: it marks no element.
    pendingTargets: new Set(state.pending.map(q => q.target).filter(t => typeof t === 'string')),
    pendingThreads: new Set(state.pending.map(q => q.thread).filter(Boolean)),
    placed: new Set(),
    tasks: live(source.tasks),
  };
}

const pendingAttr = (c, match) => ([...c.pendingTargets].some(match) ? ' data-pending' : '');

function codeLink(code, c, extraClass = '') {
  const entry = c.index.get(code);
  return `<a class="code${extraClass}" data-code="${code}" href="#${code}" title="${esc(`${code}: ${entry.title}`)}">${code}</a>`;
}

// Escape first, then link codes: a code is plain ASCII so escaping cannot split one.
const prose = (text, c) => esc(text).replace(CODE_RE, m => (c.index.has(m) ? codeLink(m, c) : m));
const codeList = (codes, c) => (codes || []).map(code => (c.index.has(code) ? codeLink(code, c) : esc(code))).join(' ');
const tabLink = (tab, label) => `<a data-tab-link="${esc(tab)}" href="#${esc(tab)}">${esc(label)}</a>`;

const askButton = '<button type="button" class="ask">Ask</button>';
const askAttrs = (c, target, label) => `data-ask-target="${esc(target)}" data-ask-label="${esc(label)}"${pendingAttr(c, t => t === target)}`;

// ---- threads -------------------------------------------------------------------------------

function threadHtml(t, c) {
  c.placed.add(t.id);
  const msgs = t.messages.map(m => `<div class="msg by-${esc(m.by)}"><span class="who">${m.by === 'claude' ? 'Claude' : 'You'}</span> ${prose(m.text, c)}</div>`).join('');
  const head = `data-thread="${esc(t.id)}" data-kind="${esc(t.kind)}" data-state="${esc(t.state)}"`;
  if (t.state !== 'open') {
    const first = t.messages[0]?.text ?? t.target;
    return `<details class="thread resolved" ${head}><summary>Resolved: ${esc(first.slice(0, 80))}</summary>${msgs}</details>`;
  }
  const suggested = t.messages.some(m => m.by === 'claude' && m.suggestChange);
  const toChange = t.kind === 'comment'
    ? `<button type="button" class="${suggested ? 'suggested' : ''}" data-action="to-change">Make this a change request</button>` : '';
  const waiting = c.pendingThreads.has(t.id) ? '<div class="wait">Waiting for Claude.</div>' : '';
  return `<div class="thread" ${head}><div class="tkind">${t.kind === 'change' ? 'Change request' : 'Comment'}</div>${msgs}${waiting}`
    + `<div class="tactions"><button type="button" data-action="resolve">Resolve</button>${toChange}</div></div>`;
}

const threadsWhere = (c, match) => {
  const found = c.threads.filter(t => !c.placed.has(t.id) && match(t.target));
  return found.length ? `<div class="notes">${found.map(t => threadHtml(t, c)).join('')}</div>` : '';
};
const threadsFor = (c, target) => threadsWhere(c, t => t === target);

// ---- diagrams ------------------------------------------------------------------------------

function figure(id, title, c) {
  const result = c.diagrams[id];
  const mark = pendingAttr(c, t => t.startsWith(`node:${id}.`));
  const body = result?.ok
    ? `<div class="pl-diagram">${result.svg}</div>`
    : `<div class="diagram-error" role="alert">The ${esc(title || id)} diagram could not be drawn: ${esc(result?.error || 'not rendered')}</div>`;
  return `<figure class="diagram" data-diagram="${esc(id)}"${mark}>${body}<figcaption>${esc(title || id)}</figcaption>`
    + `${threadsWhere(c, t => t.startsWith(`node:${id}.`))}</figure>`;
}

// ---- cards ---------------------------------------------------------------------------------

function badges(el, c) {
  const changed = c.firstTouch.has(el.id) ? '<span class="changed">changed</span>' : '';
  const recheck = el.recheck ? '<span class="recheck">re-check</span>' : '';
  return changed + recheck;
}

function oldPick(d, c) {
  const before = c.firstTouch.get(d.id)?.before?.pick;
  if (!before || before === d.pick) return null;
  return (d.options || []).find(o => o.key === before) ?? { label: before };
}

function optionRow(d, o, c) {
  const open = d.state === 'open';
  const picked = !open && o.key === d.pick;
  const recommended = o.key === d.recommended;
  const old = picked ? oldPick(d, c) : null;
  const button = open
    ? `<button type="button" class="pickbtn" data-pick="${d.id}" data-option="${esc(o.key)}"${recommended ? ' data-recommended' : ''}>Pick</button>` : '';
  const tag = picked ? '<span class="tag">picked</span>' : open && recommended ? '<span class="tag">recommended</span>' : '';
  const was = old ? `<s class="old-pick">${esc(old.label)}</s> ` : '';
  const why = open && o.why ? `<div class="owhy">${prose(o.why, c)}</div>` : '';
  const kind = picked ? 'picked' : open ? 'open' : 'alt';
  return `<div class="opt ${picked ? 'pick' : open ? '' : 'alt'}" data-opt-state="${kind}"><div class="olabel">${was}${esc(o.label)}${tag}</div>${why}${button}</div>`;
}

function slotBox(label, text, c, optional = false) {
  return `<div class="box${optional ? ' optional' : ''}"><div class="lbl">${label}</div><p>${prose(text, c)}</p></div>`;
}

function moreHtml(d, c) {
  const more = d.more || {};
  const parts = [];
  if (more.why) parts.push(`<div class="box"><div class="lbl">Why this decision exists</div><p>${prose(more.why, c)}</p></div>`);
  if (more.touches?.length) parts.push(`<div class="box"><div class="lbl">Touches</div><ul class="touches">${more.touches.map(t => `<li><code>${esc(t)}</code></li>`).join('')}</ul></div>`);
  if (more.related?.length) parts.push(`<div class="box"><div class="lbl">Related</div><p>${codeList(more.related, c)}</p></div>`);
  return parts.length ? `<details class="more"><summary>More context</summary>${parts.join('')}</details>` : '';
}

function decisionCard(d, c) {
  const implementers = c.tasks.filter(t => (t.decisions || []).includes(d.id)).map(t => codeLink(t.id, c, ' chip'));
  const slots = d.slots || {};
  const shown = OPTIONAL_SLOTS.filter(([key]) => slots[key]);
  const hidden = OPTIONAL_SLOTS.filter(([key]) => !slots[key]).map(([, label]) => label);
  const nodes = (d.nodes || []).length ? ` data-nodes="${esc(d.nodes.join(' '))}"` : '';
  const why = d.state === 'settled' ? `<p class="why">Why: ${prose(d.whyPick, c)}</p>` : '';
  return `<article class="card" id="${d.id}" data-state="${esc(d.state)}"${nodes} ${askAttrs(c, d.id, `${d.id} · ${d.title}`)}>`
    + `<header><span class="did">${d.id}</span><h4>${prose(d.title, c)}</h4>${badges(d, c)}${implementers.join('')}${askButton}</header>`
    + `<div class="box"><div class="lbl">Options</div>${(d.options || []).map(o => optionRow(d, o, c)).join('')}${why}</div>`
    + slotBox('At scale / if it fails', slots.scale, c) + slotBox('Data from', slots.dataFrom, c)
    + shown.map(([key, label]) => slotBox(label, slots[key], c, true)).join('')
    + (hidden.length ? `<div class="hidden-list">Hidden: ${hidden.join(', ')}</div>` : '')
    + moreHtml(d, c) + threadsFor(c, d.id) + '</article>';
}

function taskCard(t, c) {
  const files = [['Create', t.files?.create], ['Modify', t.files?.modify], ['Test', t.files?.test]].filter(([, list]) => list?.length);
  const detail = [
    ...files.map(([kind, list]) => `<div class="box"><div class="lbl">${kind}</div><ul class="touches">${list.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul></div>`),
    t.interfaces?.consumes ? slotBox('Consumes', t.interfaces.consumes, c) : '',
    t.interfaces?.produces ? slotBox('Produces', t.interfaces.produces, c) : '',
  ].join('');
  const links = [['Implements', t.decisions], ['After', t.after]].filter(([, list]) => list?.length)
    .map(([label, list]) => `<span>${label} ${codeList(list, c)}</span>`).join(' · ');
  return `<article class="card task" id="${t.id}" data-nodes="t${num(t.id)}" ${askAttrs(c, t.id, `${t.id} · ${t.title}`)}>`
    + `<header><span class="did">${t.id}</span><h4>${prose(t.title, c)}</h4>${badges(t, c)}${askButton}</header>`
    + (links ? `<div class="meta">${links}</div>` : '')
    + (detail ? `<details class="more"><summary>Files and interfaces</summary>${detail}</details>` : '')
    + threadsFor(c, t.id) + '</article>';
}

function scenarioRow(s, c) {
  return `<div class="mini" id="${s.id}" ${askAttrs(c, s.id, `${s.id} · ${s.title}`)}>`
    + `<span class="did">${s.id}</span><span class="t">${prose(s.title, c)}</span>${badges(s, c)}`
    + `<span class="p">${prose(s.expected, c)} ${codeList(s.tasks, c)}</span>${askButton}${threadsFor(c, s.id)}</div>`;
}

// ---- panels --------------------------------------------------------------------------------

const decisionsOf = (c, domainId) => live(c.source.decisions).filter(d => (domainId === null ? !d.domain : d.domain === domainId));

function domainBody(d, c) {
  const checks = (d.checks || []).map((text, i) => `<li ${askAttrs(c, `check:${d.id}.${i + 1}`, `Check ${i + 1} · ${d.title}`)}>${prose(text, c)}${threadsFor(c, `check:${d.id}.${i + 1}`)}</li>`).join('');
  const scenarios = live(c.source.scenarios).filter(s => s.domain === d.id);
  return (c.diagrams[`domain-${d.id}`] || d.diagram ? figure(`domain-${d.id}`, d.diagram?.title, c) : '')
    + `<div class="cards">${decisionsOf(c, d.id).map(x => decisionCard(x, c)).join('')}</div>`
    + (checks ? `<h3>What the review must check</h3><ol class="checks">${checks}</ol>` : '')
    + (scenarios.length ? `<h3>Scenarios</h3>${scenarios.map(s => scenarioRow(s, c)).join('')}` : '');
}

function domainPanel(d, c) {
  const n = decisionsOf(c, d.id).length;
  return `<section data-tab-panel="${esc(d.id)}" hidden><h2>${prose(d.title, c)}</h2><div class="meta">${n} decision${n === 1 ? '' : 's'}</div>${domainBody(d, c)}</section>`;
}

function entitiesPanel(c) {
  const body = c.source.entities?.rows?.length ? figure('entities', c.source.entities.title, c) : '<p class="stubnote">This plan lists no entities.</p>';
  return `<section data-tab-panel="entities" hidden><h2>Entities</h2>${body}</section>`;
}

function indexPanel(c) {
  const order = { D: 0, T: 1, S: 2 };
  const rows = [...c.index.entries()].sort(([a], [b]) => order[a[0]] - order[b[0]] || num(a) - num(b)).map(([code, e]) => {
    const used = e.uses.map(u => (c.index.has(u) ? codeLink(u, c) : esc(u))).join(' ') || '<span class="muted">nowhere</span>';
    const link = codeLink(code, c);
    const where = tabLink(e.tab, e.tab === 'overview' ? 'Overview' : e.tab);
    if (!e.removed) return `<tr><td>${link}</td><td>${prose(e.title, c)}</td><td>${where}</td><td>${used}</td></tr>`;
    const by = e.replacedBy.length ? ` replaced by ${codeList(e.replacedBy, c)}` : ' removed';
    return `<tr id="${code}" class="removed"><td><s>${link}</s></td><td><s>${esc(e.title)}</s>${by}</td><td>${where}</td><td>${used}</td></tr>`;
  });
  return `<section data-tab-panel="index" hidden><h2>Index</h2><table><tr><th>Code</th><th>Meaning</th><th>Defined in</th><th>Used in</th></tr>${rows.join('')}</table></section>`;
}

function summaryHtml(c) {
  const s = c.source;
  const lines = (s.summary || []).map((t, i) => `<li ${askAttrs(c, `summary:${i + 1}`, `Summary line ${i + 1}`)}>${prose(t, c)}${threadsFor(c, `summary:${i + 1}`)}</li>`);
  const first = (s.checkFirst || []).filter(code => c.index.has(code))
    .map(code => `${codeLink(code, c)} ${esc(c.index.get(code).title)}`);
  if (first.length) lines.push(`<li><b>Check first:</b> ${first.join('; ')}</li>`);
  const focus = (s.reviewFocus || []).map((f, i) => `<li ${askAttrs(c, `focus:${i + 1}`, `Review focus ${i + 1}`)}>${prose(f.text, c)} ${f.test && c.index.has(f.test) ? codeLink(f.test, c) : ''}${threadsFor(c, `focus:${i + 1}`)}</li>`);
  return `<ul class="lede">${lines.join('')}</ul>`
    + (focus.length ? `<details class="more"><summary>What the review must check (${focus.length})</summary><ol class="checks">${focus.join('')}</ol></details>` : '');
}

function flowHtml(c) {
  const flow = c.source.flow;
  if (!flow?.rows?.length) return '';
  const phases = flow.rows.filter(r => r[0] === 'phase').map(r => r[1]);
  const links = phases.map(name => {
    const domain = (flow.phaseDomains || {})[name];
    if (!c.domains.some(d => d.id === domain)) return `<span class="phase-link">${esc(name)}</span>`;
    const tab = c.flat ? 'overview' : domain;
    return `<a class="phase-link" data-tab-link="${esc(tab)}" href="#${esc(tab)}">${esc(name)}</a>`;
  });
  return `<h3>${esc(flow.title || 'How it runs, end to end')}</h3>${figure('flow', flow.title, c)}`
    + (links.length ? `<p class="phases">Decided in: ${links.join(' ')}</p>` : '');
}

function tilesHtml(c) {
  if (c.flat) return '';
  const tiles = c.domains.map(d => {
    const ds = decisionsOf(c, d.id);
    const open = ds.filter(x => x.state === 'open').length;
    return `<div class="tile"><div class="name"><a data-tab-link="${esc(d.id)}" href="#${esc(d.id)}">${esc(d.id)}</a>${open ? `<span class="badge">${open} open</span>` : ''}</div>`
      + `<div class="q">${prose(d.title, c)}</div><div class="m">${ds.length} decision${ds.length === 1 ? '' : 's'} · ${codeList(ds.map(x => x.id), c)}</div></div>`;
  });
  return tiles.length ? `<h3>Domains</h3><div class="tiles">${tiles.join('')}</div>` : '';
}

function rulesHtml(c) {
  const rules = (c.source.constraints || []).map((text, i) => `<li ${askAttrs(c, `rule:${i + 1}`, `Rule ${i + 1}`)}>${prose(text, c)}${threadsFor(c, `rule:${i + 1}`)}</li>`);
  if (!rules.length) return '';
  const rest = rules.slice(FIRST_RULES);
  return `<h3>Rules for every task</h3><ol class="rules">${rules.slice(0, FIRST_RULES).join('')}</ol>`
    + (rest.length ? `<details class="more"><summary>${rest.length} more rule${rest.length === 1 ? '' : 's'}</summary><ol class="rules" start="${FIRST_RULES + 1}">${rest.join('')}</ol></details>` : '');
}

function overviewPanel(c) {
  const s = c.source;
  const cross = decisionsOf(c, null);
  const flatDomain = c.flat && c.domains[0] ? `<h3>${prose(c.domains[0].title, c)}</h3>${domainBody(c.domains[0], c)}` : '';
  const open = live(s.decisions).filter(d => d.state === 'open').length;
  const parts = [
    `<h2>Overview</h2><div class="meta">${live(s.decisions).length} decisions (${open} open) in ${c.domains.length} domain${c.domains.length === 1 ? '' : 's'} · ${c.tasks.length} tasks</div>`,
    summaryHtml(c), flowHtml(c), tilesHtml(c),
    cross.length ? `<h3>Decisions that cross domains</h3><div class="cards">${cross.map(d => decisionCard(d, c)).join('')}</div>` : '',
    flatDomain, rulesHtml(c),
    c.tasks.length ? `<h3>Task order</h3>${figure('tasks', 'Task order', c)}<div class="cards">${c.tasks.map(t => taskCard(t, c)).join('')}</div>` : '',
  ];
  const html = parts.join('');
  const stray = c.threads.filter(t => !c.placed.has(t.id));
  const other = stray.length ? `<h3>Other threads</h3><div class="other-threads">${stray.map(t => `<div class="where">On ${esc(t.target)}</div>${threadHtml(t, c)}`).join('')}</div>` : '';
  return `<section data-tab-panel="overview">${html}${other}</section>`;
}

// ---- chrome --------------------------------------------------------------------------------

function tabsHtml(c) {
  const tabs = [['overview', 'Overview', '']];
  if (!c.flat) {
    for (const d of c.domains) {
      const ds = decisionsOf(c, d.id).map(x => num(x.id));
      const range = ds.length ? ` <span class="sub">D${Math.min(...ds)}${ds.length > 1 ? `–D${Math.max(...ds)}` : ''}</span>` : '';
      const open = decisionsOf(c, d.id).filter(x => x.state === 'open').length;
      tabs.push([d.id, esc(d.id), range + (open ? `<span class="badge">${open} open</span>` : '')]);
    }
  }
  tabs.push(['entities', 'Entities', ''], ['index', 'Index', '']);
  return `<nav class="tabs">${tabs.map(([id, label, extra], i) => `<a data-tab="${esc(id)}" href="#${esc(id)}"${i === 0 ? ' class="on"' : ''}>${label}${extra}</a>`).join('')}</nav>`;
}

function drawerHtml(state, c) {
  const log = [...state.changes.log].reverse();
  const rows = log.map(ch => {
    const codes = [...new Set(ch.touched.map(t => t.code))].map(code => (c.index.has(code) ? codeLink(code, c) : `<code>${esc(code)}</code>`)).join(' ');
    return `<li data-change="${esc(ch.id)}"><div><b>${prose(ch.summary, c)}</b> <time datetime="${esc(ch.at)}">${esc(ch.at.slice(0, 16).replace('T', ' '))}</time></div>`
      + `<div class="touched">${codes}</div><button type="button" data-action="undo">Undo</button></li>`;
  });
  const body = rows.length ? `<ul class="changes">${rows.join('')}</ul>` : '<p class="stubnote">No changes since the real plan.</p>';
  return `<details class="drawer"><summary>Changes <span class="badge">${log.length}</span></summary>${body}</details>`;
}

export function renderPage(state, diagrams, opts = {}) {
  const c = makeContext(state, diagrams);
  const panels = [
    ...(c.flat ? [] : c.domains.map(d => domainPanel(d, c))),
    entitiesPanel(c), indexPanel(c),
  ];
  const overview = overviewPanel(c);
  const css = [...new Set(Object.values(diagrams).filter(r => r?.ok).map(r => r.css))].join('\n');
  const js = (opts.clientJs || '').replace(/<\/script/gi, '<\\/script');
  const update = state.hasReal ? 'Update the real plan' : 'Create the real plan';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(c.source.title)}</title><style>${CSS}</style><style id="diagram-css">${css}</style></head><body>`
    + `<div class="wrap top"><div class="titlebar"><h1>${esc(c.source.title)}</h1>`
    + `<button type="button" class="primary" data-action="update-real">${update}</button></div>`
    + (c.source.goal ? `<p class="goal">${prose(c.source.goal, c)}</p>` : '')
    + `${tabsHtml(c)}${drawerHtml(state, c)}</div><main class="wrap">${overview}${panels.join('')}</main>`
    + (js ? `<script>${js}</script>` : '') + '</body></html>';
}

/** The whole review page for a plan folder: state, every diagram (a failed one becomes an error box) and the HTML. */
export async function renderPlanPage(dir) {
  const state = loadPageState(dir);
  const diagrams = {};
  for (const spec of pageDiagrams(state.source)) diagrams[spec.id] = renderDiagram(spec);
  return renderPage(state, diagrams, { clientJs: loadClientJs() });
}
