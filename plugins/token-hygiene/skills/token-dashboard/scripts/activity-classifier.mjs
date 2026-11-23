// Activity-class attribution, shared by the metrics pipeline.
//
// This is a VERBATIM COPY of the classifier block in ../../../hooks/record-session-metrics.js
// (lines 175-191 at the time of extraction), not a move: the hook still carries its own copy and
// still owns the definitions. Wiring the hook to import from here is a separate change, so any
// edit to the tool sets or the class order has to be applied in BOTH places until then, or
// turns.v4.csv stops being comparable with activity.v4.csv / segments.v4.csv.
//
// Each assistant RESPONSE (one message.id, not one transcript record) is classed by the tools it
// invoked: author (mutates files) > investigate (reads/searches/runs) > reason (thinks, no tools).
// `carry` is not a turn class -- it is the ambient scaffolding bucket (system prompt, tool defs,
// CLAUDE.md, compaction summaries, user-typed text). `delegate` is subagent-billed cost, which a
// per-turn row of the MAIN transcript never sees, so it appears here only to keep CLASSES aligned
// with the hook's own list.

export const CLASSES = ['reason', 'investigate', 'author', 'carry', 'delegate'];
export const AUTHOR_TOOLS      = new Set(['Edit', 'Write', 'NotebookEdit']);
export const INVESTIGATE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch',
  'Agent', 'Explore', 'ToolSearch', 'TaskOutput', 'TaskList', 'TaskGet']);

export const toolClassOf = n => AUTHOR_TOOLS.has(n) ? 'author' : INVESTIGATE_TOOLS.has(n) ? 'investigate' : 'reason';

export const turnClassOf = names =>                               // whole-response class for output attribution
  names.some(n => AUTHOR_TOOLS.has(n)) ? 'author'
  : names.some(n => INVESTIGATE_TOOLS.has(n)) ? 'investigate'
  : 'reason';

export const newCls = () => ({ turns: 0, out: 0, ingest: 0, replay: 0, calls: 0 });
export const blen = c => c == null ? 0 : (typeof c === 'string' ? c.length : JSON.stringify(c).length);

// Split `amount` across classes by a {class: weight} map; fallback to `fb` class if all-zero.
export function splitBy(cls, key, amount, weights, fb) {
  let tot = 0; for (const c of CLASSES) tot += weights[c] || 0;
  if (tot <= 0) { cls[fb][key] += amount; return; }
  for (const c of CLASSES) cls[c][key] += amount * ((weights[c] || 0) / tot);
}

// Tie rule for dominant_class when two classes hold an exactly equal output-token share. Favours
// the more specific / more informative class, so a turn that both edited and read reports `author`.
export const CLASS_TIE_ORDER = ['author', 'investigate', 'reason', 'carry', 'delegate'];
