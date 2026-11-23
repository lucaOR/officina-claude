// Renders a plan Source as a Markdown document.
// Adapted from superpowers (MIT), Copyright (c) 2025 Jesse Vincent

const num = (id) => Number(String(id).slice(1));
const live = (list) => (list || []).filter((e) => !e.removed);

// A fenced block whose fence is one backtick longer than the longest backtick run inside (at least
// three), so code that itself contains a fence cannot close the block early.
function fenced(lang, text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [fence + lang, text, fence];
}

// Topological order on `after`; ties by number. Tasks left in a cycle are appended by number.
function orderTasks(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const deps = new Map(tasks.map((t) => [t.id, (t.after || []).filter((a) => byId.has(a) && a !== t.id)]));
  const pending = [...tasks].sort((a, b) => num(a.id) - num(b.id));
  const done = new Set();
  const out = [];
  while (pending.length) {
    const at = pending.findIndex((t) => deps.get(t.id).every((d) => done.has(d)));
    if (at < 0) { out.push(...pending); break; }
    const [t] = pending.splice(at, 1);
    done.add(t.id);
    out.push(t);
  }
  return out;
}

function decisionSection(d) {
  const label = (key) => `(${key}) ${(d.options.find((o) => o.key === key) || {}).label}`;
  const body = d.state === 'settled'
    ? `**Pick:** ${label(d.pick)} — ${d.whyPick}`
    : `**Open.** Recommended: ${label(d.recommended)}`;
  return `### ${d.id}: ${d.title}\n\n${body}`;
}

function taskSection(t, liveDecisions) {
  const lines = [`### Task ${num(t.id)}: ${t.title}`, ''];
  const implements_ = (t.decisions || []).filter((id) => liveDecisions.has(id));
  if (implements_.length) lines.push(`**Implements:** ${implements_.join(', ')}`, '');
  const f = t.files || {};
  const files = [['Create', f.create], ['Modify', f.modify], ['Test', f.test]]
    .flatMap(([kind, paths]) => (paths || []).map((p) => `- ${kind}: \`${p}\``));
  if (files.length) lines.push('**Files:**', ...files, '');
  const i = t.interfaces;
  if (i && (i.consumes || i.produces)) {
    lines.push('**Interfaces:**');
    if (i.consumes) lines.push(`- Consumes: ${i.consumes}`);
    if (i.produces) lines.push(`- Produces: ${i.produces}`);
    lines.push('');
  }
  (t.steps || []).forEach((s, n) => {
    lines.push(`- [ ] **Step ${n + 1}: ${s.title}**`, '');
    if (s.body) lines.push(s.body, '');
    if (s.code) lines.push(...fenced(s.code.lang || '', s.code.text), '');
    if (s.run) lines.push(`Run: \`${s.run}\``, '');
    if (s.expect) lines.push(`Expected: ${s.expect}`, '');
  });
  if (t.commit) lines.push(...fenced('bash', t.commit), '');
  return lines.join('\n').replace(/\n+$/, '');
}

export function renderMarkdown(source) {
  const decisions = live(source.decisions).sort((a, b) => num(a.id) - num(b.id));
  const liveDecisions = new Set(decisions.map((d) => d.id));
  const tasks = orderTasks(live(source.tasks));
  const focus = (source.reviewFocus || []).map((r) => (r.test ? `- ${r.text} Test: ${r.test}.` : `- ${r.text}`));
  const parts = [
    `# ${source.title} Implementation Plan`,
    `**Goal:** ${source.goal}\n\n**Architecture:** ${source.architecture}\n\n**Tech Stack:** ${source.techStack}\n\n**Spec:** ${source.spec ?? 'none'}`,
    `## Global Constraints\n\n${(source.constraints || []).map((c) => `- ${c}`).join('\n')}`,
    `## Review Focus\n\n${focus.join('\n')}`,
    `## Decisions\n\n${decisions.map(decisionSection).join('\n\n')}`,
    '---',
    ...tasks.map((t) => taskSection(t, liveDecisions)),
  ];
  return parts.join('\n\n') + '\n';
}
