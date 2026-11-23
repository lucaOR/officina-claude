#!/usr/bin/env node
// build-turns.mjs -- per-TURN speed metrics, one row per user-message-to-end-of-assistant-work span.
//
// Standalone and idempotent: it re-parses ~/.claude/projects/<slug>/*.jsonl from scratch on every
// run and never reads or writes the ledger that record-session-metrics.js maintains. The hook is
// deliberately NOT modified by this script; it shares only the activity classifier, imported from
// activity-classifier.mjs (itself a verbatim copy of the hook's own block -- see that file's header).
//
// A turn is USER-MESSAGE to END-OF-ASSISTANT-WORK: it excludes the human's thinking time before the
// message and includes every tool round-trip and permission wait inside the response.
//
// Turn boundaries are NOT reconstructed heuristically where the harness records them itself. Every
// completed turn emits `{type:"system", subtype:"turn_duration", durationMs, parentUuid}` whose
// parent chain walks back to the user message that started it, so the anchor is found by walking
// that chain rather than by guessing which user record was "real".
//
// `durationMs` is the harness's own wall clock and is preferred over end_ts-start_ts, but NOT
// trusted blindly. Measured over 760 transcripts / 3293 stop events of this project: the walk anchor
// and the anchor implied by stop_ts-durationMs agree on 3160 (96.0%). Of the 133 that disagree, 90
// have an implied start belonging to an EARLIER user message that already has its own exact stop
// event, and in 30 more the implied start is earlier than the walk anchor with no such event. Those
// are prompt-to-IDLE figures, not per-turn ones: one 2260.8s event in session 04290e79 spans six
// turns back to the session's first message, whose own stop event reported 45.3s. The walk anchor is
// correct in those cases and the durationMs is not, so the harness figure is accepted only when it
// agrees with the observed span within DUR_TOL_S; otherwise the row falls back to reconstruction.
// Turns in a transcript with no stop events at all (137 of 760 files -- short or aborted sessions)
// are reconstructed the same way. Both fallbacks are marked in the printout.
//
// The walk falls back to `logicalParentUuid` when `parentUuid` is null: compact_boundary records
// carry the link there, so a turn with a compaction in its ancestry would otherwise break the chain.
//
// MAIN-THREAD ONLY by construction. Subagent transcripts under <session>/subagents/ run their own
// API loops with their own turn_duration events; folding their spans into a parent turn's model_s
// would double-count wall clock that ran concurrently. A turn that spawned agents therefore reports
// the parent's own speed, not the delegated work's -- `subagent_calls` says how many it dispatched.
//
// THE THREE-WAY SPLIT. Every millisecond of a turn lands in exactly one of model_s, tool_wait_s or
// tail_s, and the three sum to the turn's own span to the millisecond (checked per row, see
// aggregateSpan). The split hinges on each call's TRIGGER rather than its first assistant chunk:
// time-to-first-token is model time, not wait time, and defining tool_wait_s against the first
// chunk instead left that window billed to neither. On one measured turn (04290e79 turn 9, zero
// tools) the first-chunk definition reported model_s 16.0s against a duration of 34.0s and left an
// 18.0s residual with no owner; the trigger definition puts 18.0s of it in model_s as
// time-to-first-token and 0.1s in tail_s as harness bookkeeping.
//
// Usage:
//   node build-turns.mjs                  # print 20 turns of the most recent transcript, write nothing
//   node build-turns.mjs --print 40       # print 40
//   node build-turns.mjs --session <id>   # a specific session id (or a path to a .jsonl)
//   node build-turns.mjs --all --write    # every transcript -> ~/.claude/metrics/turns<V>.csv
//
// KNOWN ISSUES (deferred, not fixed in this pass):
//
// - Ingest-time dedupe (item-3-ingest-dedupe, design D-7): record-level dedupe belongs at ingest,
//   replacing the current write-time dedupe. Not implemented; deferred pending a corpus recount.
//
// - Formal acceptance outputs (acceptance-1-4): four outputs are still owed before this pipeline is
//   considered done -- the coverage histogram, the human+queued diff against the mechanical exception
//   class, item-6's billed+api_calls conservation check, and the 14 interactive queued rows listed
//   individually (no percentiles). None produced yet.
//
// - Classifier copy drift (classifier-copy-sync): activity-classifier.mjs is a verbatim copy of
//   record-session-metrics.js:175-191; any classifier edit must land in both files by hand. Nothing
//   has drifted yet -- this is a standing hazard, not a bug.
//
// - ebef9ea4-25ee-4ba5-a9d4-249d91345b89 row@1297 (ledger op-15): the sole Q1 invariant offender in
//   the corpus, a synthetic isApiErrorMessage=false record that still carries a real usage object.
//   Accepted as a known, bounded case rather than guarded against; the offender set must stay exactly
//   this one record or the acceptance is void.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { turnClassOf, CLASS_TIE_ORDER } from './activity-classifier.mjs';

const HOME = process.env.HOME;
const PROJ_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SLUG = PROJ_ROOT.replace(/[/.]/g, '-');
const PROJECT_DIR = path.join(HOME, '.claude/projects', SLUG);
const V = process.env.METRICS_SUFFIX !== undefined ? process.env.METRICS_SUFFIX : '.v4';
const OUT = path.join(HOME, '.claude/metrics', `turns${V}.csv`);
const SYNTHETIC_MODEL = '<synthetic>';
// How far the harness's durationMs may sit from the observed anchor-to-stop span before it is
// rejected as a prompt-to-idle figure. 2s absorbs the sub-second bookkeeping between the last
// assistant chunk and the stop record; the rejected cases miss by minutes, not seconds.
const DUR_TOL_S = +(process.env.METRICS_TURN_DUR_TOL_S || 2);
// How far model_s + tool_wait_s + tail_s may sit from the turn's own span before the row is
// reported as an invariant violation. The three are built to telescope exactly, so this is a
// tripwire for a definition bug, not a tolerance to be tuned: it allows only integer-ms slop.
const INV_TOL_MS = +(process.env.METRICS_TURN_INV_TOL_MS || 5);
// A typed prompt that sat in the queue is separated from one typed at an idle prompt by how long
// it waited between its enqueue record and the dequeued user record that anchors the turn. The
// threshold is a proxy and is known to be one: a headless harness whose scheduling jitter puts the
// gap at 0.4s produces the same kind of turn as one whose jitter puts it at 2.0s. `entrypoint`
// carries the fact this threshold only approximates, which is why the default filter keys on it.
const QUEUED_MS = +(process.env.METRICS_QUEUED_MS || 1000);

const TASK_NOTIF = '<task-notification>';
const XSESSION = '<cross-session-message';
// Only a `user` or `assistant` record means work happened. EVERY other record type is harness
// bookkeeping and may sit between a stop event and an injected user record without meaning that a
// turn ran in between. The test is an allow-list on purpose: a deny-list of known bookkeeping types
// reads the NEXT harness type as conversation, and that is not hypothetical -- the deny-list this
// replaces was missing 11 types present in the corpus (permission-mode 2791 records, agent-name
// 2557, file-history-delta 1700, cost-state 338, agent-setting 305, worktree-state 241, relocated
// 239, frame-link 130, artifact-comment-monitor 45, artifact-autoreact-ledger 16, continued-in 1),
// which refused 164 of 2487 injected anchors and left 84.3M billed tokens in 31 stretches outside
// every row. `system` is excluded here as well: a system record other than the turn_duration tested
// first is a harness annotation, and turn_duration is matched before this test is reached.
const CONVERSATION = new Set(['user', 'assistant']);
// The harness record types this script has actually seen. Nothing keys on it -- membership changes
// no behaviour, because the allow-list above already treats an unrecognised type as bookkeeping.
// It exists so the sweep can NAME a type that appeared after this list was written, which is the
// visibility the deny-list bug was missing.
const KNOWN_TYPES = new Set(['user', 'assistant', 'system',
  'queue-operation', 'last-prompt', 'custom-title', 'mode', 'bridge-session', 'ai-title',
  'atis-latch', 'attachment', 'file-history-snapshot', 'summary', 'permission-mode', 'agent-name',
  'file-history-delta', 'cost-state', 'agent-setting', 'worktree-state', 'relocated', 'frame-link',
  'artifact-comment-monitor', 'artifact-autoreact-ledger', 'continued-in']);

// Every entrypoint value the corpus is known to contain. An unrecognised one fails the build
// rather than being silently bucketed, because the default filter is an ALLOW-list: a new headless
// entrypoint that fell through to "not interactive" would be excluded correctly by luck, and a new
// interactive one would be excluded wrongly and silently.
const ENTRYPOINTS = new Set(['cli', 'sdk-cli', 'claude-vscode']);
// Interactive means a human was at the other end. `claude-vscode` is interactive; `sdk-cli` is the
// headless SDK, whose sessions are one-shot harness runs and are not human turn-taking.
const INTERACTIVE = new Set(['cli', 'claude-vscode']);
const DEFAULT_ORIGINS = new Set(['human', 'queued']);

const HEADER = ['session_id', 'turn_start_uuid', 'turn_seq', 'start_ts', 'end_ts', 'duration_s',
  'duration_src',
  'tool_wait_s', 'compact_s', 'inject_s', 'model_s', 'tail_s', 'max_tool_gap_s', 'api_calls',
  'tool_calls', 'output_tokens',
  'billed', 'model', 'dominant_class', 'interrupted', 'compactions', 'subagent_calls',
  'origin', 'entrypoint'];

// The default population for speed work: an interactive session, and a turn a human actually
// started. The two terms are kept separate so a drop can be attributed to one or the other.
export const inDefault = r => INTERACTIVE.has(r.entrypoint) && DEFAULT_ORIGINS.has(r.origin);

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WRITE = flag('--write');
const ALL = flag('--all');
const PRINT_N = +opt('--print', 20);
const SESSION = opt('--session', null);

// ---------------------------------------------------------------------------------------------
// "Real user message" predicate -- what may anchor a turn.
// ---------------------------------------------------------------------------------------------
// Slash commands are the hard case: a fully-local command (/clear, /model) and a skill-triggering
// command (/epic, /kb) write the IDENTICAL `<command-name>` envelope, so the envelope itself cannot
// discriminate. What does discriminate is the OUTPUT wrapper: `<local-command-caveat>` and
// `<local-command-stdout>` are the command's result being fed back, analogous to a tool_result, not
// new input from the human. A bare `<command-name>` block IS the instruction the human gave, so it
// anchors. A local-only command produces no turn_duration event anyway and simply never gets claimed.
const LOCAL_CMD_OUTPUT = /<local-command-(caveat|stdout)>/;

function textOf(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n');
}

function isToolResultOnly(msg) {
  const c = msg && msg.content;
  if (!Array.isArray(c) || !c.length) return false;
  return c.every(b => b && b.type === 'tool_result');
}

// An interrupt marker is not a turn: span_asst=0 on every one (D-5), so no assistant record and no
// billed token ever sits inside it, and anchoring on it truncates the real turn it interrupts.
// Excluded from every anchor predicate below; its text is instead the `interrupted` signal
// aggregateSpan unions in, replacing the old synthetic-record-only source (which undercounted:
// 4 vs 64 markers in the corpus, since a marker only produces a synthetic record when nothing was
// enqueued behind it).
const INTERRUPT_MARKERS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]'];
const isMarkerOnlyText = t => INTERRUPT_MARKERS.includes(t.trim());
const isMarkerOnly = o => o && o.type === 'user' && o.message && isMarkerOnlyText(textOf(o.message));

function isRealUserMessage(o) {
  if (o.type !== 'user' || !o.message) return false;
  if (o.isMeta === true) return false;
  if (o.isSidechain === true) return false;
  if (o.isCompactSummary === true) return false;
  if (isToolResultOnly(o.message)) return false;
  if (LOCAL_CMD_OUTPUT.test(textOf(o.message))) return false;
  if (isMarkerOnly(o)) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Injected turn starts, and where a turn came from.
// ---------------------------------------------------------------------------------------------
// An isMeta user record is EITHER a genuine turn start (a task notification, a cross-session
// message, a scheduled fire) OR mid-turn context the harness injected into a turn already running.
// The discriminator is POSITION, not content: a genuine one is preceded by a turn_duration stop
// with nothing but bookkeeping in between, i.e. the previous turn had already ended. Content-based
// variants were measured and rejected -- anchoring every isMeta record drove no_stop from 194 to
// 1273 by splitting human turns in half.
const isMetaCandidate = o => o.type === 'user' && o.message && o.isMeta === true && o.isSidechain !== true;

function metaAnchors(recs, i) {
  for (let j = i - 1; j >= 0; j--) {
    const o = recs[j];
    if (!o) continue;
    if (o.type === 'system' && o.subtype === 'turn_duration' && o.isSidechain !== true) return true;
    if (!CONVERSATION.has(o.type) || o.isSidechain === true) continue;
    if (isMarkerOnly(o)) continue;                                  // not a turn; keep walking past it
    return false;
  }
  return true;                                                     // nothing before it: file starts here
}

// Markers are tested at the START of the message, never anywhere in it. Text that merely QUOTES a
// marker carries it further down, and a substring test counts every one of those as an injection.
// Measured over the frozen corpus, by marker and by leading text:
//   <task-notification>      334 start-anchored (the real injections, all isMeta=false)
//                             31 inside a "This session is being continued..." compaction summary
//                              6 inside an autonomous-loop prompt (claimed by the loop test below)
//   <cross-session-message>  390 after the harness lead sentence (the real injections, all isMeta)
//                             13 inside a compaction summary
// So the quoting cases are compaction summaries replaying an earlier conversation, not human
// prompts, and the substring rule would misattribute 44 of them plus the 6 loop prompts.
const startsMarker = (t, marker) => t.trimStart().startsWith(marker);

// The harness never injects the cross-session marker bare: all 390 in the corpus are preceded by
// this literal sentence, so a bare start-anchored test matches NONE of them and every one lands in
// injected_other. The lead is stripped before anchoring rather than the test being widened to a
// substring, because the 13 compaction summaries above must still be rejected.
const XSESSION_LEAD = 'Another Claude session sent a message:';
const startsXsession = t => {
  const s = t.trimStart();
  const body = s.startsWith(XSESSION_LEAD) ? s.slice(XSESSION_LEAD.length).trimStart() : s;
  return body.startsWith(XSESSION);
};
const startsTask = t => startsMarker(t, TASK_NOTIF);

// The two contexts that legitimately CONTAIN a marker without being one. A compaction summary
// replays an earlier conversation verbatim, and an autonomous-loop prompt carries the notification
// that woke it. Both are recognisable from their own opening, which is what makes the leak guard
// below usable as a hard gate: a marker substring in a record opening with neither of these is an
// injection the classifier failed to recognise, not a quote.
const COMPACT_LEAD = 'This session is being continued from a previous conversation that ran';
const AUTOLOOP_LEAD = /^#\s*Autonomous loop/;
const isCompactSummary = t => t.trimStart().startsWith(COMPACT_LEAD);

// The exemptions, in ONE place, for every guard that has to fix a marker population. Same shape as
// the leak guard's (dbfeba4): a literal predicate plus one enumerated origin/marker pair, never a
// general "quoting context" predicate, so no future origin gets a free pass.
// The leak guard keys the pair on the classifier's origin because it has one per row. A population
// count does not: a record the builder never claimed has no origin, so the pair is keyed on the
// record's own opening instead. That is the stricter of the two -- AUTOLOOP_LEAD is anchored at
// string start, where originOfMeta's own autoloop test carries the `m` flag and so matches the
// heading at any line start.
const markerExempt = (t, morigin) => isCompactSummary(t)
  || (morigin === 'task_notification' && AUTOLOOP_LEAD.test(t.trimStart()));

// marker, the origin it must produce, and the start-anchored test for it.
const MARKER_TESTS = [[TASK_NOTIF, 'task_notification', startsTask],
                      [XSESSION, 'cross_session', startsXsession]];

function originOfMeta(recs, i) {
  const t = textOf(recs[i].message);
  if (startsXsession(t)) return 'cross_session';
  if (/^#\s*Autonomous loop/m.test(t)) return 'autonomous_loop';
  for (let j = i - 1; j >= 0; j--) {
    const o = recs[j];
    if (!o) continue;
    if (o.type === 'system' && o.subtype === 'scheduled_task_fire') return 'scheduled';
    if (!CONVERSATION.has(o.type)) continue;
    break;
  }
  return 'injected_other';                                         // isMeta but unclassified, not a mechanism
}

// Enqueued prompts, keyed on the first 200 chars of their content, so a dequeued user record can
// be matched back to the enqueue that produced it.
function enqueuesOf(recs) {
  const m = new Map();
  for (const o of recs) {
    if (o.type !== 'queue-operation' || o.operation !== 'enqueue' || !o.content) continue;
    const k = String(o.content).slice(0, 200);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(Date.parse(o.timestamp));
  }
  return m;
}

function originOfReal(o, enqueues) {
  const t = textOf(o.message);
  if (startsMarker(t, TASK_NOTIF)) return 'task_notification';
  const ts = Date.parse(o.timestamp);
  const cands = enqueues.get(t.slice(0, 200));
  if (!cands) return 'human';
  let best = null;
  for (const e of cands) if (e <= ts && (best === null || e > best)) best = e;
  if (best === null) return 'human';
  return (ts - best) > QUEUED_MS ? 'queued' : 'human';
}

// ---------------------------------------------------------------------------------------------
// Parse one transcript into turn rows.
// ---------------------------------------------------------------------------------------------
function readRecords(file) {
  const recs = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { recs.push(JSON.parse(line)); } catch { /* truncated tail line */ }
  }
  return recs;
}

// Walk the parent chain from `rec` until an anchor index is reached. Returns the anchor's record
// index, or -1. `logicalParentUuid` covers compact_boundary records, whose parentUuid is null.
function walkToAnchor(rec, byUuid, anchorIdx) {
  const seen = new Set();
  let cur = rec;
  while (cur) {
    const up = cur.parentUuid || cur.logicalParentUuid || null;
    if (!up || seen.has(up)) return -1;
    seen.add(up);
    const idx = anchorIdx.get(up);
    if (idx !== undefined) return idx;
    cur = byUuid.get(up);
  }
  return -1;
}

const sec = ms => Math.round(ms / 100) / 10;                       // ms -> seconds, 1 decimal
const tsOf = o => o && o.timestamp ? Date.parse(o.timestamp) : NaN;

// What kind of user-type record armed a call's trigger. A `tool_result` trigger means the window
// before it was tool execution; every other kind means the window was the harness doing something
// else -- dequeuing a message, compacting, injecting context -- which is not tool time and must not
// be reported as such. Kept as one function so the trigger classification has a single definition.
function triggerKindOf(o) {
  if (!o || o.type !== 'user' || !o.message) return 'other';
  if (isToolResultOnly(o.message)) return 'tool_result';
  if (o.isCompactSummary === true) return 'compact_summary';
  if (o.isMeta === true) return 'injected_meta';
  if (LOCAL_CMD_OUTPUT.test(textOf(o.message))) return 'local_cmd_output';
  return 'real_user';
}

// Group the assistant records of a span into API calls (one per message.id) and aggregate.
//
// Call identity is `message.id`: one call is every transcript record carrying that id, and the
// call's clock runs from its TRIGGER to its LAST such record. The trigger is the last `user`-type
// record before the call's first assistant record -- the anchor for the first call, and for every
// later call the tool_result that unblocked it. For a PARALLEL tool batch that is automatically the
// LAST tool_result of the batch, because the model cannot resume until the slowest one lands, so
// the earlier results of the batch are wait time and not model time.
//
// `anchorMs` seeds the trigger because the span passed in starts one record AFTER the anchor.
//
// The three components telescope by construction:
//   model_s     = sum(last_i - trigger_i)
//   tool_wait_s = sum(trigger_i - last_{i-1})        over i >= 2
//   tail_s      = end - last_n
//   total       = (last_n - trigger_1) + (end - last_n) = end - trigger_1 = end - anchor = span
// which is why the sums must stay algebraic: dropping a negative gap, as the previous first-chunk
// definition did, silently breaks the identity. Negative gaps are counted and reported instead.
function aggregateSpan(recs, from, to, anchorMs, endMs) {
  const calls = [];                                                // { mid, usage, model, names[], trigger, first, last }
  let cur = null;
  let interrupted = false, compactions = 0;
  let triggerMs = anchorMs;                                        // pending trigger: last user-type record seen
  let triggerKind = 'anchor';
  let sideTok = 0, sideCalls = 0;                                   // sidechain usage inside the span, excluded
  const sideMids = new Set();
  for (let i = from; i <= to; i++) {
    const o = recs[i];
    if (!o) continue;
    if (o.isSidechain === true) {
      // Counted, never aggregated: a sidechain record is a subagent's own API call, billed to the
      // same cap but running concurrently, so folding it into this turn would double-count wall
      // clock and inflate the throughput numerator. Reported so the exclusion is checkable.
      const u = o.type === 'assistant' && o.message ? o.message.usage : null;
      if (u && o.message.id && !sideMids.has(o.message.id)) {
        sideMids.add(o.message.id);
        sideCalls++;
        sideTok += u.output_tokens || 0;
      }
      continue;
    }
    // A compaction inside a turn is worth reporting on its own: it rewrites the prefix mid-turn and
    // so moves the cache-write cost that `billed` picks up on the following call.
    if (o.type === 'system' && o.subtype === 'compact_boundary') { compactions++; continue; }
    // Any user-type record re-arms the trigger -- tool_result, injected context, compaction summary.
    // The rule is positional, not content-based: whatever the model saw last before resuming is
    // what started the next call's clock.
    if (o.type === 'user' && o.message) {
      if (isMarkerOnly(o)) interrupted = true;
      const t = tsOf(o);
      if (!isNaN(t)) { triggerMs = t; triggerKind = triggerKindOf(o); }
      continue;
    }
    if (o.type !== 'assistant' || !o.message) continue;
    // A `<synthetic>` record is a harness placeholder, never a billed response. isApiErrorMessage
    // true means a real API failure (the hook's `retry` label); an explicit false means the human
    // interrupted / cancelled / rejected -- which is what `interrupted` reports. An ABSENT flag is
    // neither, so this tests for `false` exactly rather than for falsiness.
    if (o.message.model === SYNTHETIC_MODEL) {
      if (o.isApiErrorMessage === false) interrupted = true;
      continue;
    }
    // A failed call carries no usage and would form a phantom zero-token call, so it is skipped. It
    // deliberately does NOT re-arm the trigger: the retry's clock still runs from the tool_result
    // that started the attempt, which is what the wall clock actually cost.
    if (o.isApiErrorMessage === true) continue;
    const mid = o.message.id;
    if (!cur || !mid || cur.mid !== mid) {
      cur = { mid, usage: null, model: null, names: [], trigger: triggerMs, tkind: triggerKind,
              first: tsOf(o), last: tsOf(o) };
      calls.push(cur);
    }
    const t = tsOf(o);
    if (!isNaN(t)) { if (isNaN(cur.first) || t < cur.first) cur.first = t; if (isNaN(cur.last) || t > cur.last) cur.last = t; }
    if (!cur.usage && o.message.usage) cur.usage = o.message.usage;
    if (!cur.model && o.message.model) cur.model = o.message.model;
    const content = o.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b && b.type === 'tool_use') cur.names.push(b.name);
  }

  let outTok = 0, billed = 0, toolCalls = 0, modelMs = 0, maxGapMs = 0;
  // Diagnostic twin of maxGapMs under the OLD rule -- widest mid-turn window of ANY kind, window 1
  // excluded -- kept only so the before/after of the by-kind split is exact rather than reconstructed.
  let maxGapAllMs = 0;
  let subagentCalls = 0, negGaps = 0;
  const byClass = Object.create(null);
  let model = null;
  const billedCalls = calls.filter(c => c.usage);
  const trigOf = c => isNaN(c.trigger) ? c.first : c.trigger;      // a span opening on an assistant record
  for (const c of billedCalls) {
    const u = c.usage;
    const og = u.output_tokens || 0;
    outTok += og;
    // Same formula as record-session-metrics.js derive() -- input + cache_read + cache_creation +
    // output -- so a turn row stays summable against the sessions/segments ledgers.
    billed += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + og;
    toolCalls += c.names.length;
    for (const n of c.names) if (n === 'Agent') subagentCalls++;
    const t0 = trigOf(c);
    if (!isNaN(t0) && !isNaN(c.last)) modelMs += c.last - t0;
    if (!model && c.model) model = c.model;
    const cl = turnClassOf(c.names);
    byClass[cl] = (byClass[cl] || 0) + og;
  }
  // The complement of model_s: one response's last record to the trigger that unblocked the next.
  // Each such window is attributed by WHAT ARMED THE TRIGGER THAT CLOSES IT, and by nothing else --
  // in particular not by its position in the span. Window 1 runs from the anchor to the first call's
  // trigger and is bucketed by the same rule as every later window, which is what retires lead_s:
  // the anchor-to-first-trigger stretch was never a fourth kind of time, only a window whose arming
  // record the old loop skipped because it started at i=1. With i=0 included the telescoping is
  //   sum(windows) + sum(model windows) + tail
  //     = sum(trigger_i - last_{i-1}) + sum(last_i - trigger_i) + (end - last_n)   [last_0 := anchor]
  //     = end - anchor = span
  // unconditionally, with no `trigger is the anchor` precondition left to violate.
  //
  // tool_result arms tool time; compact_summary and injected_meta arm harness work that merely looks
  // like tool time, so they get their own columns rather than being buried in tool_wait_s. `other`
  // is the overflow that keeps the identity exact if some kind not in this list ever arms a window;
  // it is expected to stay empty and is reported so that the expectation is checked, not assumed.
  const BUCKET = { tool_result: 'tool_wait', compact_summary: 'compact', injected_meta: 'inject' };
  const compMs = { tool_wait: 0, compact: 0, inject: 0, other: 0 };
  const compN = { tool_wait: 0, compact: 0, inject: 0, other: 0 };
  const compNegN = { tool_wait: 0, compact: 0, inject: 0, other: 0 };
  // Same sums with negative windows dropped. Not a definition -- dropping them would break the
  // identity above -- but the only way to size how far overlapping calls push a component off, since
  // a telescoping sum cannot see an overlap it is algebraically blind to.
  const compPosMs = { tool_wait: 0, compact: 0, inject: 0, other: 0 };
  let harnessMidMs = 0, harnessMidN = 0, overlapN = 0;
  const kindMs = Object.create(null), kindN = Object.create(null);
  for (let i = 0; i < billedCalls.length; i++) {
    const prevEnd = i === 0 ? anchorMs : billedCalls[i - 1].last;
    const trig = trigOf(billedCalls[i]);
    // Window 1 does not exist when the anchor IS the first trigger: the model answered the anchor
    // directly and there is nothing between them to attribute.
    if (i === 0 && trig === anchorMs) continue;
    if (i > 0 && billedCalls[i].first < billedCalls[i - 1].last) overlapN++;
    const gap = trig - prevEnd;
    if (isNaN(gap)) continue;
    const b = BUCKET[billedCalls[i].tkind] || 'other';
    compMs[b] += gap;
    compN[b]++;
    if (gap < 0) { compNegN[b]++; negGaps++; } else compPosMs[b] += gap;
    const k = billedCalls[i].tkind;
    kindMs[k] = (kindMs[k] || 0) + gap;
    kindN[k] = (kindN[k] || 0) + 1;
    if (i > 0 && k !== 'tool_result') { harnessMidMs += gap; harnessMidN++; }
    // max_tool_gap_s is the longest window of ACTUAL tool execution, so a compaction or an injected
    // context window -- however long -- must not set it.
    if (b === 'tool_wait' && gap > maxGapMs) maxGapMs = gap;
    if (i > 0 && gap > maxGapAllMs) maxGapAllMs = gap;           // old rule, diagnostic only
  }
  const waitMs = compMs.tool_wait;
  const lastCall = billedCalls.length ? billedCalls[billedCalls.length - 1] : null;
  const tailMs = lastCall && !isNaN(endMs) && !isNaN(lastCall.last) ? endMs - lastCall.last : NaN;
  const firstTrigger = lastCall ? trigOf(billedCalls[0]) : NaN;
  // The window between the anchor and the first call's trigger: it exists only when a user-type
  // record re-armed the trigger before the model ever answered, and today it belongs to no
  // component, which is what the span-identity violations are.
  const leadMs = lastCall && !isNaN(firstTrigger) && !isNaN(anchorMs) ? firstTrigger - anchorMs : NaN;
  const leadKind = lastCall ? billedCalls[0].tkind : '';

  let dominant = '';
  let best = -1;
  for (const cl of CLASS_TIE_ORDER) {                              // iterating in tie order settles ties by priority
    const v = byClass[cl] || 0;
    if (v > best) { best = v; dominant = cl; }
  }
  if (best <= 0) dominant = billedCalls.length ? 'reason' : '';

  return { apiCalls: billedCalls.length, toolCalls, outTok, billed, model: model || '',
           dominant, interrupted, modelMs, waitMs, maxGapMs, maxGapAllMs, tailMs, firstTrigger,
           compactions, subagentCalls, negGaps,
           compMs, compN, compNegN, compPosMs,
           leadMs, leadKind, harnessMidMs, harnessMidN, kindMs, kindN, overlapN, sideTok, sideCalls };
}

export function turnsOf(file) {
  const recs = readRecords(file);
  const sessionId = path.basename(file, '.jsonl');
  const byUuid = new Map();
  const anchorIdx = new Map();                                     // uuid -> record index, anchors only
  const anchors = [];                                              // record indices, file order
  const metaSet = new Set();                                       // which anchors are injected ones
  const stops = [];                                                // turn_duration records, file order
  const entrypoints = new Set();
  const types = {};                                                // record type -> count, for the drift report
  recs.forEach((o, i) => {
    if (typeof o.type === 'string' && o.type) types[o.type] = (types[o.type] || 0) + 1;
    if (o.uuid) byUuid.set(o.uuid, o);
    if (typeof o.entrypoint === 'string' && o.entrypoint) entrypoints.add(o.entrypoint);
    if (isRealUserMessage(o) && o.uuid) { anchorIdx.set(o.uuid, i); anchors.push(i); }
    else if (isMetaCandidate(o) && o.uuid && metaAnchors(recs, i)) {
      anchorIdx.set(o.uuid, i); anchors.push(i); metaSet.add(i);
    }
    if (o.type === 'system' && o.subtype === 'turn_duration' && o.isSidechain !== true) stops.push(i);
  });
  // `entrypoint` is a session-level fact written onto individual records, so it is read off the
  // records and asserted constant rather than trusted from any single one. A file with none is
  // reported as '' and excluded by the interactive term.
  const entrypoint = entrypoints.size === 1 ? [...entrypoints][0] : '';
  const enqueues = enqueuesOf(recs);

  // Claim each stop event's anchor by walking its parent chain.
  const claimed = new Map();                                       // anchor index -> stop record index
  let unmatchedStops = 0, conflicts = 0;
  for (const si of stops) {
    const ai = walkToAnchor(recs[si], byUuid, anchorIdx);
    if (ai < 0) { unmatchedStops++; continue; }
    // Several stop events can walk to one anchor: a prompt-to-idle event measured from this turn's
    // message fires again after later turns, and its parent chain still leads here. Keep the
    // EARLIEST, which is the tightest span for this turn; a later one would swallow the records of
    // every turn in between and re-bill them into this row. Stops in file order, so first wins.
    if (claimed.has(ai)) { conflicts++; continue; }
    claimed.set(ai, si);
  }

  const rows = [];
  const zeroCall = {};                                             // origin -> anchors that produced no row
  for (let k = 0; k < anchors.length; k++) {
    const ai = anchors[k];
    const start = recs[ai];
    const si = claimed.has(ai) ? claimed.get(ai) : -1;
    // No stop event: reconstruct the span as "up to just before the next anchor", or EOF for the
    // last turn (which may simply still be in progress).
    const nextAnchor = k + 1 < anchors.length ? anchors[k + 1] : recs.length;
    const to = si >= 0 ? si : nextAnchor - 1;
    // endMs is needed to close tail_s, so the span end is resolved BEFORE aggregating rather than
    // after. Neither endRec nor spanMs depends on the aggregate, so the order is free.
    // With no stop event the end is the last record that IS work -- an assistant record or a
    // tool_result -- not merely the last timestamped record before the next anchor. The bookkeeping
    // that trails a finished turn (file-history-snapshot, queue-operation, injected context) can
    // land minutes later while nothing is running, and charging that idle stretch to tail_s put
    // 13 of the 14 tail>30s rows in the no_stop_event class.
    const endRec = si >= 0 ? recs[si] : lastWorkRecord(recs, ai + 1, to);
    const endOldRec = si >= 0 ? recs[si] : lastTimestamped(recs, ai + 1, to);
    const startMs = tsOf(start), endMs = tsOf(endRec);
    const a = aggregateSpan(recs, ai + 1, to, startMs, endMs);
    if (!a.apiCalls) {
      // A local-only command, or a turn interrupted before its first call, produces no row. Its
      // origin is still tallied: the marker guards balance `raw == rows + zero_call`, so an anchor
      // dropped here has to be visible somewhere or the guard would read as a lost row.
      const zo = metaSet.has(ai) ? originOfMeta(recs, ai) : originOfReal(start, enqueues);
      zeroCall[zo] = (zeroCall[zo] || 0) + 1;
      continue;
    }
    const spanMs = (!isNaN(startMs) && !isNaN(endMs)) ? endMs - startMs : NaN;
    const hasStop = si >= 0;
    const reported = hasStop && typeof recs[si].durationMs === 'number' ? recs[si].durationMs : null;
    // Accept the harness figure only where it agrees with the span this turn's own records cover.
    // A prompt-to-idle event measures from an earlier turn's message and would otherwise report a
    // 37-minute "turn" whose records span six minutes -- see the header note.
    const agrees = reported !== null && !isNaN(spanMs) && Math.abs(reported - spanMs) <= DUR_TOL_S * 1000;
    // `malformed_stop` is split out of `no_stop_event` rather than folded into it: a turn whose stop
    // event exists but carries a non-numeric durationMs is a harness defect, whereas a turn with no
    // stop event at all is an ordinary reconstruction. Folding the two makes the defect unreportable
    // -- it reads as one more of the 194 turns that simply never emitted a stop. The corpus holds 0
    // of these, which is a measurement, not a reason to leave the two classes merged.
    const source = agrees ? 'harness'
      : reported !== null ? 'dur_mismatch'
      : hasStop ? 'malformed_stop'
      : 'no_stop_event';
    const durMs = agrees ? reported : spanMs;
    // The invariant is checked in MILLISECONDS, before sec() rounds each column to one decimal --
    // three rounded columns need not add up to a rounded total, and that is presentation, not a
    // definition bug. It is checked against the SPAN, which is what the components telescope to.
    // On a `harness` row duration_s is the reported figure instead, and may legitimately sit up to
    // DUR_TOL_S from the span, so invDurMs is tracked separately and counted at DUR_TOL_S, not at
    // INV_TOL_MS: at the identity tolerance it counts every harness row whose jitter exceeds 5ms,
    // which is nearly all of them and says nothing.
    const sumMs = a.modelMs + a.compMs.tool_wait + a.compMs.compact + a.compMs.inject
                  + a.compMs.other + a.tailMs;
    const invSpanMs = (!isNaN(sumMs) && !isNaN(spanMs)) ? Math.abs(sumMs - spanMs) : NaN;
    const invDurMs = (!isNaN(sumMs) && !isNaN(durMs)) ? Math.abs(sumMs - durMs) : NaN;
    // `queued` means this prompt waited while an EARLIER turn ran, so the first turn of a session
    // cannot be queued whatever the enqueue gap says. Without this the headless harnesses, which
    // enqueue their single prompt before the session has anything to run, all classify queued.
    const seq = rows.length + 1;
    let origin = metaSet.has(ai) ? originOfMeta(recs, ai) : originOfReal(start, enqueues);
    if (origin === 'queued' && seq === 1) origin = 'human';
    rows.push({
      session_id: sessionId,
      turn_start_uuid: start.uuid,
      turn_seq: seq,
      start_ts: start.timestamp || '',
      end_ts: (endRec && endRec.timestamp) || '',
      duration_s: isNaN(durMs) ? '' : sec(durMs),
      duration_src: source,                     // where duration_s came from -- see MARK below
      tool_wait_s: sec(a.compMs.tool_wait),
      compact_s: sec(a.compMs.compact),
      inject_s: sec(a.compMs.inject),
      model_s: sec(a.modelMs),
      tail_s: isNaN(a.tailMs) ? '' : sec(a.tailMs),
      max_tool_gap_s: sec(a.maxGapMs),
      api_calls: a.apiCalls,
      tool_calls: a.toolCalls,
      output_tokens: a.outTok,
      billed: a.billed,
      model: a.model,
      dominant_class: a.dominant,
      interrupted: a.interrupted ? 1 : 0,
      compactions: a.compactions,
      subagent_calls: a.subagentCalls,
      origin,
      entrypoint,
      _injected: metaSet.has(ai) ? 1 : 0,       // this row's anchor was an injected record
      _reportedS: reported === null ? null : sec(reported),
      _reportedMs: reported,                    // unrounded, so the DUR_TOL_S derivation is exact
      _invSpanMs: invSpanMs,
      _invDurMs: invDurMs,
      _negGaps: a.negGaps,
      // The identity only closes if the first billed call's trigger IS the anchor. It would not be
      // if a span opened on a tool_result -- an anchor injected mid-tool-loop -- so this is tracked
      // rather than assumed.
      _triggerIsAnchor: a.firstTrigger === startMs,
      _modelMs: a.modelMs, _waitMs: a.waitMs, _tailMs: a.tailMs, _spanMs: spanMs,
      // The four window components, their window counts, how many of each window ran negative, and
      // the same sums with the negative windows dropped -- the overlap sizing, which the telescoping
      // identity is blind to by construction.
      _compMs: a.compMs, _compN: a.compN, _compNegN: a.compNegN, _compPosMs: a.compPosMs,
      _maxGapMs: a.maxGapMs, _maxGapAllMs: a.maxGapAllMs,
      // Span indices, so an audit can re-read this row's raw records without replicating the
      // anchor scan and drifting from it.
      _ai: ai, _to: to, _si: si,
      // The pre-lastWorkRecord end of the span, kept for the before/after re-report. It differs
      // only on no_stop_event rows; where a stop event exists both resolve to the same record.
      _endOldTs: (endOldRec && endOldRec.timestamp) || '',
      _spanOldMs: (!isNaN(startMs) && !isNaN(tsOf(endOldRec))) ? tsOf(endOldRec) - startMs : NaN,
      _tailOldMs: (!isNaN(a.tailMs) && !isNaN(endMs) && !isNaN(tsOf(endOldRec)))
        ? tsOf(endOldRec) - (endMs - a.tailMs) : NaN,
      // Instrumentation for the lead_s / harness_s decision and for the throughput numerator.
      _leadMs: a.leadMs, _leadKind: a.leadKind,
      _harnessMidMs: a.harnessMidMs, _harnessMidN: a.harnessMidN,
      _kindMs: a.kindMs, _kindN: a.kindN, _overlapN: a.overlapN,
      _sideTok: a.sideTok, _sideCalls: a.sideCalls,
    });
  }
  // Marker guard inputs. Counted over the ANCHOR population, both ways, so the start-anchored rule
  // can be compared against the substring rule it replaces instead of merely asserted.
  // taskPop/xsessPop are what the guard reads: the SUBSTRING population minus the enumerated
  // exemptions, so the guard's population never comes from the predicate it is checking. Counting
  // it with `starts` made g1/g2 self-confirming -- pre-fix, `cross_session raw 0 == 0 + 0` passed
  // while all 338 cross-session rows sat in injected_other. taskStart/xsessStart are kept for the
  // start-anchored-vs-substring diff report only.
  const raw = { taskStart: 0, taskIncl: 0, taskPop: 0,
                xsessStart: 0, xsessIncl: 0, xsessPop: 0, leak: 0 };
  const rawDiff = [];                                              // anchors the two rules disagree on
  for (const ai of anchors) {
    const t = textOf(recs[ai].message);
    const ts = startsMarker(t, TASK_NOTIF), ti = t.includes(TASK_NOTIF);
    const xs = startsXsession(t), xi = t.includes(XSESSION);
    if (ts) raw.taskStart++;
    if (ti) raw.taskIncl++;
    if (ti && !markerExempt(t, 'task_notification')) raw.taskPop++;
    if (xs) raw.xsessStart++;
    if (xi) raw.xsessIncl++;
    if (xi && !markerExempt(t, 'cross_session')) raw.xsessPop++;
    // Third guard: no anchor that opens with either marker may end up in the default population.
    if (ts || xs) {
      const o = metaSet.has(ai) ? originOfMeta(recs, ai) : originOfReal(recs[ai], enqueues);
      if (DEFAULT_ORIGINS.has(o)) raw.leak++;
    }
    if (ts !== ti || xs !== xi) {
      rawDiff.push({ session_id: sessionId, idx: ai, isMeta: recs[ai].isMeta === true,
        marker: ts !== ti ? 'task_notification' : 'cross_session',
        head: t.trimStart().slice(0, 90).replace(/\n/g, ' ') });
    }
  }

  // ---- Classifier-independent leak guard ------------------------------------------------------
  // g1/g2 above compare an anchor-derived count to a row-derived count, and BOTH read the
  // classifier, so they agree whenever the classifier is uniformly wrong -- pre-fix, `cross_session
  // raw 0 == 0 + 0` passed while all 338 cross-session rows sat in injected_other. This guard is
  // independent of it: it asks only whether a row's anchor text CONTAINS a marker, and fails when
  // the row's origin is not that marker's origin and the text is not one of the two contexts that
  // legitimately quote a marker.
  // Two exemptions, both narrow on purpose. The first is a compaction summary, which replays an
  // earlier conversation verbatim and is recognisable from its own opening. The second is a single
  // ENUMERATED precedence rule for one origin/marker pair: an autonomous-loop tick genuinely
  // carries the notification that woke it, and autonomous_loop is the more specific origin, so it
  // wins over task_notification there. Measured on the frozen corpus: exactly 5 rows, all of them
  // loop ticks in 2 files, opening `# Autonomous loop check` or `# Autonomous loop tick`. The rule
  // is written as that pair rather than as a general "quoting context" predicate, so no other
  // origin gets to contain a marker for free -- a new harness wrapper still trips the guard, which
  // is the classifier-miss detection this guard exists for.
  const leakRows = [];
  for (const r of rows) {
    const t = textOf(recs[r._ai].message);
    if (isCompactSummary(t)) continue;
    for (const [marker, morigin] of MARKER_TESTS) {
      if (!t.includes(marker) || r.origin === morigin) continue;
      if (morigin === 'task_notification' && r.origin === 'autonomous_loop') continue;
      leakRows.push({ session_id: sessionId, idx: r._ai, seq: r.turn_seq, marker: morigin,
        got: r.origin, head: t.trimStart().slice(0, 70).replace(/\n/g, ' ') });
    }
  }

  // ---- Per-marker reconciliation, counted from the records rather than from the rows -----------
  // The population is re-derived by scanning every user record, so a marker record the row builder
  // never saw shows up as `unaccounted` instead of being invisible to a rows-vs-anchors balance.
  // Identity: genuine == rows + zero_call + mid_turn + unprocessed + unaccounted, with unaccounted
  // expected 0. `unprocessed` is the one class that is unaccountable by construction rather than by
  // defect: a marker record with NO assistant record after it anywhere in the file arrived at a
  // session that was then closed, so no turn ran for it, it never got a stop event to anchor the
  // next injection behind, and it hides no billed work. Measured on the frozen corpus: 4 records,
  // one burst in one file, 0 api_calls and 0 billed between them and end of file. Kept separate
  // from zero_call, which means an ANCHORED record whose turn produced no billed call -- a
  // different statement about a record the builder did claim.
  let lastAssistant = -1, lastMainAssistant = -1;
  for (let i = recs.length - 1; i >= 0 && lastAssistant < 0; i--) {
    if (recs[i] && recs[i].type === 'assistant') lastAssistant = i;
  }
  for (let i = recs.length - 1; i >= 0 && lastMainAssistant < 0; i--) {
    if (recs[i] && recs[i].type === 'assistant' && recs[i].isSidechain !== true) lastMainAssistant = i;
  }
  const anchorSet = new Set(anchors);
  const covers = new Set();                                        // record indices inside some row's span
  for (const r of rows) for (let j = r._ai + 1; j <= r._to; j++) covers.add(j);
  const rowByAnchor = new Map(rows.map(r => [r._ai, r]));
  const recon = {};
  for (const [marker, morigin, starts] of MARKER_TESTS) {
    const c = { genuine: 0, rows: 0, wrongOrigin: 0, zeroCall: 0, midTurn: 0, unprocessed: 0,
                unprocessedMainOnly: 0, unaccounted: 0, quoted: 0, unanchored: 0 };
    for (let i = 0; i < recs.length; i++) {
      const o = recs[i];
      if (o.type !== 'user' || !o.message) continue;
      const t = textOf(o.message);
      if (!t.includes(marker)) continue;
      if (markerExempt(t, morigin)) { c.quoted++; continue; }       // enumerated exemption, not an injection
      // The population is fixed HERE, before `starts` is consulted, so `genuine` is substring hits
      // minus exemptions and never depends on the predicate under test. A classifier that stops
      // recognising the marker therefore moves its whole population into `unanchored` and breaks
      // the balance, instead of shrinking `genuine` to match and reporting OK.
      c.genuine++;
      if (!starts(t)) { c.unanchored++; continue; }                 // the classifier failed to recognise it
      const row = rowByAnchor.get(i);
      if (row) { c.rows++; if (row.origin !== morigin) c.wrongOrigin++; continue; }
      if (anchorSet.has(i)) { c.zeroCall++; continue; }             // anchored but produced no row
      if (covers.has(i)) { c.midTurn++; continue; }                 // arrived while a turn was running
      // Sidechain assistant records are subagent work, so the two variants are counted separately
      // and compared: if they ever disagree, an injection was followed by subagent activity only.
      if (i > lastMainAssistant) c.unprocessedMainOnly++;
      if (i > lastAssistant) { c.unprocessed++; continue; }          // session closed without a turn
      c.unaccounted++;
    }
    recon[morigin] = c;
  }

  const viol = rows.filter(r => !(r._invSpanMs <= INV_TOL_MS));
  return { rows, stats: { anchors: anchors.length, stops: stops.length, unmatchedStops, conflicts,
                          noStop: rows.filter(r => r.duration_src === 'no_stop_event').length,
                          mismatch: rows.filter(r => r.duration_src === 'dur_mismatch').length,
                          malformedStop: rows.filter(r => r.duration_src === 'malformed_stop').length,
                          invViol: viol.length,
                          invDurViol: rows.filter(r => !(r._invDurMs <= DUR_TOL_S * 1000)).length,
                          negGaps: rows.reduce((s, r) => s + r._negGaps, 0),
                          trigNotAnchor: rows.filter(r => !r._triggerIsAnchor).length,
                          injectedAnchors: metaSet.size,
                          violRows: viol.slice(0, 5),
                          entrypoint, entrypoints: [...entrypoints], zeroCall, raw, rawDiff,
                          leakRows, recon, types } };
}

function lastTimestamped(recs, from, to) {
  for (let i = Math.min(to, recs.length - 1); i >= from; i--) if (recs[i] && recs[i].timestamp) return recs[i];
  return null;
}

// The last record in the span that is the turn WORKING: an assistant record (a synthetic one
// included -- it marks the interruption point, which is where the work stopped) or a tool_result
// being fed back. Everything else is bookkeeping and may trail the turn by minutes.
function lastWorkRecord(recs, from, to) {
  for (let i = Math.min(to, recs.length - 1); i >= from; i--) {
    const o = recs[i];
    if (!o || !o.timestamp || o.isSidechain === true) continue;
    if (o.type === 'assistant' && o.message) return o;
    if (o.type === 'user' && o.message && isToolResultOnly(o.message)) return o;
  }
  return lastTimestamped(recs, from, to);
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
function transcripts() {
  return fs.readdirSync(PROJECT_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(PROJECT_DIR, f))
    .map(p => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map(x => x.p);
}

function resolveFile() {
  if (!SESSION) return transcripts()[0];
  if (SESSION.endsWith('.jsonl')) return SESSION;
  return path.join(PROJECT_DIR, `${SESSION}.jsonl`);
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

const MARK = { harness: '', no_stop_event: '*', dur_mismatch: '!', malformed_stop: '?' };

function printRows(rows, stats, file) {
  const cols = [['seq', 4], ['dur_s', 9], ['model_s', 8], ['wait_s', 8], ['cmpct_s', 8], ['inj_s', 7],
    ['tail_s', 7], ['maxgap', 7],
    ['api', 4], ['tools', 6], ['cmp', 4], ['sub', 4], ['out_tok', 8], ['billed', 10],
    ['class', 12], ['int', 4], ['start_ts', 20]];
  console.log(`file: ${file}`);
  console.log(`anchors=${stats.anchors} stop_events=${stats.stops} unmatched_stops=${stats.unmatchedStops}` +
              ` conflicts=${stats.conflicts} rows=${rows.length}` +
              ` no_stop=${stats.noStop} dur_mismatch=${stats.mismatch}` +
              ` malformed_stop=${stats.malformedStop}`);
  console.log(`invariant: violations=${stats.invViol}/${rows.length} (vs span, tol ${INV_TOL_MS}ms)` +
              ` vs_duration_s=${stats.invDurViol} (tol ${DUR_TOL_S}s) neg_gaps=${stats.negGaps}` +
              ` trigger_not_anchor=${stats.trigNotAnchor}`);
  console.log('');
  console.log(cols.map(([h, w]) => pad(h, w)).join(' '));
  console.log(cols.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const r of rows.slice(0, PRINT_N)) {
    console.log([rpad(r.turn_seq, 4), rpad(r.duration_s + MARK[r.duration_src], 9),
      rpad(r.model_s, 8), rpad(r.tool_wait_s, 8), rpad(r.compact_s, 8), rpad(r.inject_s, 7),
      rpad(r.tail_s, 7), rpad(r.max_tool_gap_s, 7),
      rpad(r.api_calls, 4), rpad(r.tool_calls, 6), rpad(r.compactions, 4),
      rpad(r.subagent_calls, 4), rpad(r.output_tokens, 8), rpad(r.billed, 10),
      pad(r.dominant_class, 12), rpad(r.interrupted, 4), pad((r.start_ts || '').slice(0, 19), 20)].join(' '));
  }
  const bad = rows.slice(0, PRINT_N).filter(r => r.duration_src === 'dur_mismatch');
  console.log('');
  console.log('* duration_s reconstructed: the transcript has no turn_duration event for that turn.');
  console.log('? duration_s reconstructed: a turn_duration event was claimed but its durationMs is not');
  console.log('  a number -- a harness defect, kept apart from * so it cannot hide among those rows.');
  console.log(`! duration_s reconstructed: the harness reported a figure more than ${DUR_TOL_S}s off the`);
  console.log('  span this turn\'s own records cover, i.e. a prompt-to-idle measurement, so it was rejected.');
  for (const r of bad) console.log(`  turn ${r.turn_seq}: harness said ${r._reportedS}s, records span ${r.duration_s}s`);
  console.log('model_s + tool_wait_s + compact_s + inject_s + tail_s == the turn span EXACTLY, by');
  console.log('construction: model_s runs from each call\'s trigger (anchor / last tool_result of a batch)');
  console.log('so time-to-first-token is model time; the three window columns are last-record-to-next-');
  console.log('trigger split by what armed that trigger, the anchor-to-first-trigger window included on');
  console.log('the same rule; tail_s is last record to end_ts. max_tool_gap_s is over tool_wait windows.');
  console.log('vs_duration_s counts rows where the HARNESS figure differs from that sum -- harness jitter,');
  console.log(`bounded by DUR_TOL_S=${DUR_TOL_S}s on 'harness' rows, not a definition error.`);
  for (const r of (stats.violRows || [])) {
    console.log(`  INVARIANT VIOLATION ${r.session_id.slice(0, 8)} turn ${r.turn_seq}: ` +
      `model ${r._modelMs} + wait ${r._compMs.tool_wait} + compact ${r._compMs.compact}` +
      ` + inject ${r._compMs.inject} + other ${r._compMs.other} + tail ${r._tailMs}` +
      ` = ${r._modelMs + r._compMs.tool_wait + r._compMs.compact + r._compMs.inject + r._compMs.other + r._tailMs}` +
      ` vs span ${r._spanMs} (off by ${r._invSpanMs}ms, trigger_is_anchor=${r._triggerIsAnchor})`);
  }
  console.log(`dominant_class ties settle by priority ${JSON.stringify(CLASS_TIE_ORDER.slice(0, 4))}.`);
  printOrigin(rows, stats);
}

// The origin/entrypoint report: the two populations, the drop attribution, and the marker guards.
function printOrigin(rows, stats) {
  const tally = (xs, k) => xs.reduce((a, r) => { const v = String(k(r)); a[v] = (a[v] || 0) + 1; return a; }, {});
  const zc = stats.zeroCall || {};
  console.log('');
  console.log(`injected anchors: ${stats.injectedAnchors} (isMeta records that start a turn)`);
  if (stats.epFiles) {
    console.log(`entrypoint by file: ${Object.entries(stats.epFiles).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`).join('  ')}`);
  }
  for (const m of (stats.mixedFiles || []).slice(0, 10)) {
    console.log(`  MIXED ENTRYPOINT ${m.f}: ${m.v.join(',')} -- entrypoint reported as '' for it`);
  }
  // A record type absent from KNOWN_TYPES is PRINTED, never a hard fail -- unlike an unknown
  // entrypoint, which is silently mis-bucketed by an allow-list filter. Here the conversation
  // allow-list already handles an unknown type correctly (it is skipped as bookkeeping), so a new
  // harness type is a visibility matter, not a correctness risk, and failing the build on one
  // would break the sweep over a cosmetic harness change.
  const nt = Object.entries(stats.newTypes || {}).sort((a, b) => b[1].n - a[1].n);
  if (nt.length) {
    console.log(`record types not in KNOWN_TYPES (skipped as bookkeeping, add them to the list): ` +
                nt.map(([t, c]) => `${t} ${c.n}(${c.files}f)`).join('  '));
  }
  console.log('');
  const byOrigin = tally(rows, r => r.origin);
  const origins = [...new Set([...Object.keys(byOrigin), ...Object.keys(zc)])].sort();
  console.log(`${pad('origin', 20)} ${rpad('rows', 7)} ${rpad('zero_call', 10)} ${rpad('interactive', 12)}`);
  for (const o of origins) {
    const inter = rows.filter(r => r.origin === o && INTERACTIVE.has(r.entrypoint)).length;
    console.log(`${pad(o, 20)} ${rpad(byOrigin[o] || 0, 7)} ${rpad(zc[o] || 0, 10)} ${rpad(inter, 12)}`);
  }
  console.log('');
  // Each drop attributed to ONE term, so the two exclusions can be read apart rather than summed.
  const nEp = rows.filter(r => !INTERACTIVE.has(r.entrypoint)).length;
  const nOr = rows.filter(r => INTERACTIVE.has(r.entrypoint) && !DEFAULT_ORIGINS.has(r.origin)).length;
  const kept = rows.filter(inDefault).length;
  console.log(`default filter: entrypoint in {${[...INTERACTIVE].join(',')}} AND origin in ` +
              `{${[...DEFAULT_ORIGINS].join(',')}}`);
  console.log(`  ${rows.length} rows - ${nEp} (not interactive) - ${nOr} (interactive, other origin)` +
              ` = ${kept} kept  [check ${rows.length - nEp - nOr === kept ? 'OK' : 'FAIL'}]`);
  console.log('');
  const g1 = stats.raw.taskPop === (byOrigin.task_notification || 0) + (zc.task_notification || 0);
  const g2 = stats.raw.xsessPop === (byOrigin.cross_session || 0) + (zc.cross_session || 0);
  console.log(`marker guard (substring population minus enumerated exemptions, raw == rows + zero_call):`);
  console.log(`  task_notification  raw ${stats.raw.taskPop} == ${byOrigin.task_notification || 0}` +
              ` + ${zc.task_notification || 0}  [${g1 ? 'OK' : 'FAIL'}]`);
  console.log(`  cross_session      raw ${stats.raw.xsessPop} == ${byOrigin.cross_session || 0}` +
              ` + ${zc.cross_session || 0}  [${g2 ? 'OK' : 'FAIL'}]`);
  console.log(`  marker-opening anchors leaking into (human,queued): ${stats.raw.leak}` +
              `  [${stats.raw.leak === 0 ? 'OK' : 'FAIL'}]`);
  const leaks = stats.leakRows || [];
  console.log(`classifier-independent leak guard: ${leaks.length} row(s) whose anchor contains a` +
              ` marker but is classified otherwise, outside a quoting context` +
              `  [${leaks.length === 0 ? 'OK' : 'FAIL'}]`);
  for (const l of leaks.slice(0, 12)) {
    console.log(`  ${l.session_id.slice(0, 8)} seq ${l.seq} want ${l.marker} got ${l.got}: ${l.head}`);
  }
  console.log('');
  console.log(`per-marker reconciliation (population re-scanned from records, not read off rows):`);
  console.log(`  ${pad('marker', 20)}${rpad('genuine', 9)}${rpad('rows', 7)}${rpad('zero_call', 11)}` +
              `${rpad('mid_turn', 10)}${rpad('unproc', 8)}${rpad('unacct', 8)}${rpad('quoted', 8)}` +
              `${rpad('unanch', 8)}  balance`);
  for (const [m, c] of Object.entries(stats.recon || {})) {
    // unprocessed is reported, never a FAIL: it is the one class that cannot be accounted for by
    // construction. The identity must still close over every class, so it is summed here.
    // unanch is now INSIDE the identity and enforced at 0: it is the bucket a classifier miss lands
    // in once `genuine` stopped being derived from the classifier, so leaving it merely reported
    // would print OK for a marker whose entire population went unrecognised.
    const ok = c.genuine === c.rows + c.zeroCall + c.midTurn + c.unprocessed + c.unaccounted
                             + c.unanchored
               && c.unaccounted === 0 && c.unanchored === 0 && c.wrongOrigin === 0;
    console.log(`  ${pad(m, 20)}${rpad(c.genuine, 9)}${rpad(c.rows, 7)}${rpad(c.zeroCall, 11)}` +
                `${rpad(c.midTurn, 10)}${rpad(c.unprocessed, 8)}${rpad(c.unaccounted, 8)}` +
                `${rpad(c.quoted, 8)}${rpad(c.unanchored, 8)}  [${ok ? 'OK' : 'FAIL'}]` +
                (c.wrongOrigin ? ` wrong_origin=${c.wrongOrigin}` : '') +
                (c.unprocessed !== c.unprocessedMainOnly
                  ? ` unproc_main_only=${c.unprocessedMainOnly}` : ''));
  }
  console.log('');
  console.log(`start-anchored vs substring: task_notification ${stats.raw.taskStart} vs ${stats.raw.taskIncl}` +
              `, cross_session ${stats.raw.xsessStart} vs ${stats.raw.xsessIncl}` +
              `  (${(stats.rawDiff || []).length} anchors differ)`);
  for (const d of (stats.rawDiff || []).slice(0, 12)) {
    console.log(`  ${d.session_id.slice(0, 8)} idx ${d.idx} isMeta=${d.isMeta} ${d.marker}: ${d.head}`);
  }
}

const csvCell = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// The keys of turnsOf's stats that are NOT a per-file count and so cannot be summed: arrays that
// concatenate, objects that merge key by key, and the per-file entrypoint label. Everything else is
// summed automatically. The set is checked in BOTH directions -- an undeclared non-numeric key
// fails, and a declared key that stats no longer has fails too, because a stale declaration would
// silently exempt a future key of that name from the sum, which is the failure this replaces.
const STATS_HANDLED_SEPARATELY = new Set(['violRows', 'entrypoint', 'entrypoints', 'zeroCall',
  'raw', 'rawDiff', 'leakRows', 'recon', 'types']);

// Sum every numeric key of `src` into `into`. `declared` names the keys to skip, or null when every
// key must be numeric. A non-numeric key that was not declared fails the build rather than
// accumulating as NaN or undefined: a sweep figure that is wrong is worse than one that is absent,
// because it prints alongside correct figures and is read as one of them.
function sumNumeric(into, src, declared, label) {
  for (const [k, v] of Object.entries(src)) {
    if (declared && declared.has(k)) continue;
    if (typeof v === 'number' && isFinite(v)) { into[k] = (into[k] || 0) + v; continue; }
    console.error(`${label}.${k} is ${typeof v === 'number' ? v : typeof v}, which the sweep cannot sum.`);
    console.error(`  Make it a per-file count, or declare it in STATS_HANDLED_SEPARATELY and merge it by hand.`);
    process.exit(1);
  }
  if (!declared) return;
  for (const k of declared) {
    if (k in src) continue;
    console.error(`STATS_HANDLED_SEPARATELY declares \`${k}\`, but ${label} has no such key.`);
    console.error(`  Drop it: a stale declaration exempts a future key of that name from the sum.`);
    process.exit(1);
  }
}

function main() {
  const files = ALL ? transcripts() : [resolveFile()];
  const all = [];
  const agg = {};
  const violRows = [];
  const zeroCall = {}, raw = {};
  const rawDiff = [], epFiles = {}, mixedFiles = [], unknownEp = [];
  const leakRows = [], recon = {};
  const newTypes = {};                                             // unrecognised type -> {n, files}
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`no such transcript: ${f}`); process.exit(1); }
    const { rows, stats } = turnsOf(f);
    all.push(...rows);
    // The sum set is DERIVED from the data, never restated as a literal key list here. A literal
    // list is a second place to remember, and the thing it forgets is silent: a stat added to
    // turnsOf alone was never summed, so it read back as `undefined` rather than as a wrong number.
    // Anything not numeric has to be named in STATS_HANDLED_SEPARATELY, so a new one fails loudly.
    sumNumeric(agg, stats, STATS_HANDLED_SEPARATELY, 'stats');
    sumNumeric(raw, stats.raw, null, 'stats.raw');
    for (const r of stats.violRows) if (violRows.length < 10) violRows.push(r);
    for (const [k, v] of Object.entries(stats.zeroCall)) zeroCall[k] = (zeroCall[k] || 0) + v;
    for (const d of stats.rawDiff) rawDiff.push(d);
    for (const l of stats.leakRows) leakRows.push(l);
    for (const [m, c] of Object.entries(stats.recon)) {
      if (!recon[m]) recon[m] = {};
      for (const [k, v] of Object.entries(c)) recon[m][k] = (recon[m][k] || 0) + v;
    }
    for (const [t, n] of Object.entries(stats.types)) {
      if (KNOWN_TYPES.has(t)) continue;
      if (!newTypes[t]) newTypes[t] = { n: 0, files: 0 };
      newTypes[t].n += n; newTypes[t].files++;
    }
    const label = stats.entrypoint || `<${stats.entrypoints.length ? 'mixed' : 'none'}>`;
    epFiles[label] = (epFiles[label] || 0) + 1;
    if (stats.entrypoints.length > 1) mixedFiles.push({ f: path.basename(f), v: stats.entrypoints });
    for (const v of stats.entrypoints) if (!ENTRYPOINTS.has(v)) unknownEp.push({ f: path.basename(f), v });
  }
  agg.violRows = violRows;
  Object.assign(agg, { zeroCall, raw, rawDiff, epFiles, mixedFiles, leakRows, recon, newTypes });
  // An entrypoint value nobody has classified as interactive or headless would be silently dropped
  // from the default population, so it fails the build instead.
  if (unknownEp.length) {
    console.error(`unknown entrypoint value(s) -- classify them in ENTRYPOINTS/INTERACTIVE first:`);
    for (const u of unknownEp.slice(0, 10)) console.error(`  ${u.f}: ${u.v}`);
    process.exit(1);
  }
  if (!WRITE) { printRows(all, agg, files.length === 1 ? files[0] : `${files.length} transcripts`); return; }
  // Idempotent full rewrite, deduped on turn_start_uuid (the stable per-turn key).
  const seen = new Set();
  const lines = [HEADER.join(',')];
  for (const r of all) {
    if (!r.turn_start_uuid || seen.has(r.turn_start_uuid)) continue;
    seen.add(r.turn_start_uuid);
    lines.push(HEADER.map(h => csvCell(r[h])).join(','));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`${OUT}: ${lines.length - 1} turns from ${files.length} transcripts` +
              ` (no_stop=${agg.noStop}, dur_mismatch=${agg.mismatch}, malformed_stop=${agg.malformedStop},` +
              ` unmatched_stops=${agg.unmatchedStops})`);
}

// Only when run directly: turnsOf is imported by the validation scripts, which must not trigger a
// full sweep (nor have main() read THEIR argv) as an import side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
