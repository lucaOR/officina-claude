#!/usr/bin/env node
// Upsert EXACT per-session token metrics into a set of CSVs keyed by session_id, AND
// maintain an hourly time-bucketed rollup for plotting. Works as a SessionEnd hook AND
// as a manual backfill/rescan. Read-only on the logs; does not read stdin.
// A lockfile serializes the read-modify-write so concurrent (parallel-session) runs
// can't lose updates on the rewrite.
//
// A session_id is not guaranteed to produce exactly one SessionEnd event: if the harness
// fires SessionEnd mid-session (idle timeout, backgrounding, a resumed/continued session
// reusing the same id) the transcript keeps growing under the same file afterward. A prior
// version treated a session_id as finished forever after its first recorded row, which
// silently dropped everything the session did after that point -- for one real session this
// lost 90%+ of its true token cost (2026-08-03 finding). Growth is now detected by comparing
// each transcript file's byte size against the size recorded at last scan; a size change
// triggers a full rescan and REPLACES that session_id's rows everywhere (sessions/segments/
// activity/session_hours), rather than appending a second, non-deduplicated copy.
const fs = require('fs'), path = require('path'), readline = require('readline');

const HOME = process.env.HOME;
// Project transcript dir = ~/.claude/projects/<slug>, where <slug> is the project root path with
// '/' and '.' replaced by '-' (Claude Code's encoding). Derived from CLAUDE_PROJECT_DIR (set by the
// harness for hooks) or cwd, so this hook is portable across clones/users -- NOT hardcoded to one home.
// The CSVs stay under ~/.claude/metrics (per-user personal usage data; never committed to the repo).
const PROJ_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SLUG = PROJ_ROOT.replace(/[/.]/g, '-');
const PROJECT_DIR = path.join(HOME, '.claude/projects', SLUG);
// Ledger generation suffix. Each generation fixes a counting bug in its predecessor, and every
// older generation is FROZEN -- never rewritten, never summed with a newer one -- because it is the
// only surviving record of sessions whose transcripts have since rotated away.
//   (none) pre-2026-07-28: per-RECORD counter, inflated ~2.1x with a carry-skewed class split.
//   .v2    2026-07-28: grouped by message.id, but still flushed a response on every intervening
//          `user` record. Parallel tool calls interleave their tool_result records BETWEEN sibling
//          assistant records of one response, so those responses were emitted twice and their usage
//          re-billed: +8.3% responses, +6.3% billed over 142 transcripts, 110 of them affected.
//   .v3    2026-08-07: a response is closed only by a NEW message.id, a compaction boundary, or EOF.
//   .v4    2026-08-20: counts SUBAGENT transcripts. Agent-tool spawns and Workflow agents run their
//          own API loops, billed to the same cap, but their records live under
//          <session>/subagents/[workflows/<wf>/]agent-*.jsonl -- files no earlier generation ever
//          opened. Measured on one /readiness-sweep run (session a8b72b22, 2026-08-19): 101,107,553
//          billed of which the ledger saw 5,509,383, so 94.5% of that session was invisible. In .v4
//          turns/total_billed/input/cache_read/cache_creation/output and the hourly rollup are
//          main + subagents; sub_agents/sub_turns/sub_billed break the delegated share back out,
//          subagents<V>.csv carries one row per agent, and the activity ledger gains a `delegate`
//          class so its per-segment reconciliation still holds. Main-thread-only by construction and
//          deliberately left that way: peak_context (an agent's context is its own, not resident in
//          the parent), init_context, handoff, breaks/break_cc, model_switches, and the rebuild curve.
// Override with METRICS_SUFFIX (e.g. '.v2' or '' to inspect a frozen generation).
const V = process.env.METRICS_SUFFIX !== undefined ? process.env.METRICS_SUFFIX : '.v4';
// METRICS_RESCAN=1 reparses every transcript instead of skipping the ones whose byte size is
// unchanged. Needed only to backfill a newly-added ledger over sessions already recorded; the
// rewrite is an upsert keyed by session_id from the transcripts themselves, so it is idempotent
// and CANNOT resurrect or drop a session whose transcript has rotated away (the scan loop only
// visits files that still exist -- rows for absent transcripts are carried through untouched).
const RESCAN = process.env.METRICS_RESCAN === '1';
const MET = p => path.join(HOME, '.claude/metrics', p);
const OUT     = MET(`sessions${V}.csv`);           // per-session ledger (one row per session_id)
const SEG     = MET(`segments${V}.csv`);           // per-compaction-segment ledger (one row per (session,seg))
const ACT     = MET(`activity${V}.csv`);           // per-(session,seg,class) token-attribution ledger
const SESSHR  = MET(`session_hours${V}.csv`);      // per-(session,hour) ledger -- source of truth for HOURLY
const REB     = MET(`rebuild${V}.csv`);            // per-(session,compaction,k) ledger -- the post-compaction rebuild curve
const BRK     = MET(`breaks${V}.csv`);             // per-cache-write-event ledger -- cold boots, compaction rebuilds, mid-session breaks
const SUB     = MET(`subagents${V}.csv`);          // per-(session,agent) ledger -- delegated work, one row per subagent run
const HOURLY  = MET(`hourly${V}.csv`);             // per-hour rollup (local time; pure fn of session_hours.csv)
const DAILY   = MET(`daily${V}.csv`);              // per-day duration-weighted rollup (pure fn of sessions.csv)
const LOCK    = MET('.metrics.lock');              // shared across generations: serializes all metric writes
// Columns 0..19 keep their .v3 positions and order -- buildDaily and build-dashboard.mjs both read
// this ledger positionally in places -- and the .v4 subagent columns are APPENDED at 20..23.
const HEADER  = ['session_id','date','turns','total_billed','input','cache_read',
  'cache_creation','output','fresh_per_min','active_min','peak_context','compactions','recorded_at','src_bytes',
  'init_context','handoff','parent_session','breaks','break_cc','model_switches',
  'sub_agents','sub_turns','sub_billed','sub_bytes'];
const HRHEADER = ['session_id','hour','input','cache_read','cache_creation','output','turns'];
const SHEADER = ['session_id','seg','date','turns','total_billed','input','cache_read',
  'cache_creation','output','fresh_per_min','active_min','peak_context','recorded_at','init_context',
  'sub_agents','sub_turns','sub_billed'];
// One row per subagent run. `kind` is 'agent' (an Agent/Task tool spawn from the main thread) or
// 'workflow' (one agent of a Workflow run, `workflow` naming the wf_ run id). `seg` is the parent
// segment the run is attributed to -- the last segment open at the agent's first response -- which
// is what keeps the per-session segment sums reconciling once delegated cost is folded in. `model`
// is the model of the agent's first billed response: subagents frequently run on a different (often
// cheaper) model than the session that spawned them, and the session row cannot show that.
const SUBHEADER = ['session_id','agent_id','kind','workflow','seg','model','date','turns','total_billed',
  'input','cache_read','cache_creation','output','active_min','peak_context','first_ts','last_ts',
  'bytes','recorded_at'];
const AHEADER = ['session_id','seg','class','turns','out','ingest','replay','calls',
  'pct_seg','pct_session','recorded_at'];
const HHEADER = ['hour','input','cache_read','cache_creation','output','total_billed','turns'];
// Post-compaction rebuild curve: one row per (session, compaction, k) for the first REBUILD_K
// responses after each real `isCompactSummary` boundary. Compaction economics turn on three
// numbers -- the floor context it lands on (C0), how fast context regrows (g), and the one-shot
// cost of rebuilding orientation (O) -- and none of them are recoverable from the coarser ledgers:
// segments.csv holds only per-segment aggregates, so the 2026-08-07 analysis had to reconstruct
// the curve by re-parsing 142 transcripts. That is retro-only; transcripts rotate away. Recording
// the curve at scan time makes the model's inputs a standing measurement, so a change in
// compaction cadence (e.g. compacting at 120k instead of the ~188k auto-default) can be evaluated
// against data rather than re-extrapolated. `ctx_pre` is the resident context of the last response
// BEFORE the boundary -- i.e. the threshold the compaction actually fired at.
const REBUILD_K = 10;
const RHEADER = ['session_id','comp','k','ctx','billed','input','cache_read','cache_creation',
  'output','ctx_pre','summary_bytes','recorded_at'];

// Prompt-cache write events. cache_creation is ~31% of consumption once the 1h-write multiplier is
// applied, and it is NOT spread evenly: 3.5% of responses carried 40% of it (measured 2026-08-12
// over the 25 then-current transcripts). Those spikes are three different economic events that the
// aggregate cache_creation column fuses into one number, so the ledger cannot answer "was that
// avoidable":
//   cold    -- first response of a session: the unavoidable price of a boot (median ~25k)
//   compact -- first response after a real isCompactSummary boundary: the rebuild write (~41-46k)
//   ttl     -- a write that follows a long enough idle gap that the cached prefix had simply
//              expired. Nothing was thrown away; the entry was already gone. Unavoidable.
//   retry   -- the first write after a failed request. A request that errors bills nothing and
//              caches nothing, so the re-sent one pays for the prefix again. Nothing was thrown
//              away here either -- there was never an entry to throw away. Unavoidable.
//   growth  -- a write whose cached prefix did NOT shrink: cache_read held up against the previous
//              response, so the head still hit and the write is new content being cached for the
//              first time (a big tool result, a pasted file). The prefix GREW; nothing was thrown
//              away. Unavoidable in the same sense the three above are.
//   break   -- anything else: a mid-session prefix invalidation, i.e. cache thrown away while the
//              session was running and still inside the TTL. Avoidable, and the only kind worth
//              alerting on.
// severity separates a total miss (cache_read == 0, the whole prefix rewritten) from a partial one
// (a prefix suffix rewritten while the head still hit). model_changed is recorded because the model
// id is part of what the request hashes -- switching mid-session invalidates everything, which is
// how one observed break cost 130,457 write tokens on a 134k context.
const BREAK_MIN_CC = +(process.env.METRICS_BREAK_MIN_CC || 20000);   // ignore ordinary per-turn delta writes (median ~1.2k)
// The ttl/break line. Upstream sets `gapThresholdMinutes: 60` in src/services/compact/
// timeBasedMCConfig.ts, commented "60 is the safe choice: the server's 1h cache TTL is guaranteed
// expired for all users" -- so a gap at or past 60 minutes is expiry with certainty. Shorter gaps
// CAN also be expiry (a request served under the 5m TTL dies far sooner), but the transcript never
// says which TTL applied, so those stay in `break`. The split is deliberately one-sided: `ttl`
// never absorbs an event that might have been avoidable, it only removes ones that certainly were
// not. Measured 2026-08-12 over the then-current ledger, it moves 31 of 281 breaks (4.98M of
// 26.1M write tokens, ~19% of the bucket) out of the actionable column.
const TTL_GAP_MIN = +(process.env.METRICS_TTL_GAP_MIN || 60);
// The growth/break line. Upstream never looks at cache_creation to decide whether a break happened;
// it asks whether the cached prefix SHRANK -- `cacheReadTokens < prevCacheRead * 0.95` AND an
// absolute drop of at least MIN_CACHE_MISS_TOKENS (src/services/api/promptCacheBreakDetection.ts:
// 485-489, the constant at :120). Both gates matter: the ratio ignores a prefix that merely stopped
// growing, and the floor ignores the few-hundred-token jitter between adjacent turns. A large write
// whose cache_read held up is therefore not cache thrown away at all -- it is new content entering
// the prefix for the first time, which costs the same to write but is not a fault and cannot be
// tuned away. Measured 2026-08-13 over the then-current ledger, it moves 63 of 213 reachable breaks
// (2.91M of 18.3M write tokens, ~16% of the bucket) out of the actionable column, spread over 32
// sessions rather than concentrated in one workload. 62 of those 63 are partial misses, which is
// the tell: the head still hit.
const GROWTH_READ_RATIO = +(process.env.METRICS_GROWTH_READ_RATIO || 0.95);
const GROWTH_MIN_DROP   = +(process.env.METRICS_GROWTH_MIN_DROP || 2000);
// The model id the harness stamps on a placeholder record it wrote itself rather than received from
// the API (src/utils/messages.ts:300). Deliberately NOT configurable: it is a literal in upstream,
// not a tunable, and an env override would only let a typo silently disable the skip.
const SYNTHETIC_MODEL = '<synthetic>';
const BHEADER = ['session_id','seq','kind','severity','cache_creation','cache_read','ctx_pre',
  'model','prev_model','model_changed','gap_min','ts','recorded_at'];

// Activity-class attribution. Each assistant RESPONSE (not transcript record -- see the grouping
// note in metricsFor) is classed by the tools it invoked:
// author (mutates files) > investigate (reads/searches/runs) > reason (thinks/plans, no tools).
// carry is NOT a turn class -- it's the ambient scaffolding bucket (system prompt + tool defs +
// CLAUDE.md, compaction summaries, user-typed text) that costs cap but isn't an activity you tune.
// out    = output+input tokens, bucketed by the TURN's class (generation effort). Never carry --
//          reason therefore ends up ~pure model thinking; reasoning creates little cache.
// ingest = cache_creation, split by the byte-share of the tool_results (each mapped to its tool's
//          class) / user-text+summary (-> carry) it ingests. Unmapped cc (turn-1 scaffolding) -> carry.
// replay = cache_read, split by RESIDENCY: proportional to cumulative cache_creation per class so
//          far in the segment (compaction resets it). Heuristic -- the transcript doesn't tag which
//          cached bytes belong to which class. Totals reconcile to billed exactly; split is modeled.
// delegate is the fifth class (.v4): every token a SUBAGENT billed, whether it was spawned by the
// Agent tool or by a Workflow. It is deliberately NOT folded into investigate. The main thread's own
// Agent call already lands in investigate -- that is the cost of asking -- whereas this is the cost
// of the work being done in another context entirely, and the two tune differently: investigate
// shrinks by reading less, delegate shrinks by spawning fewer or smaller agents. Its three columns
// keep their usual meanings within the agent's own loop (out = its generation, ingest = its cache
// writes, replay = its cache reads), so the per-segment reconciliation Sigma-class(out+ingest+replay)
// == segment billed still holds exactly once delegated cost is folded into the segment.
const CLASSES = ['reason','investigate','author','carry','delegate'];
const AUTHOR_TOOLS      = new Set(['Edit','Write','NotebookEdit']);
const INVESTIGATE_TOOLS = new Set(['Read','Grep','Glob','Bash','WebSearch','WebFetch',
  'Agent','Explore','ToolSearch','TaskOutput','TaskList','TaskGet']);
const toolClassOf = n => AUTHOR_TOOLS.has(n) ? 'author' : INVESTIGATE_TOOLS.has(n) ? 'investigate' : 'reason';
const turnClassOf = names =>                                    // whole-turn class for output attribution
  names.some(n => AUTHOR_TOOLS.has(n)) ? 'author'
  : names.some(n => INVESTIGATE_TOOLS.has(n)) ? 'investigate'
  : 'reason';
const newCls = () => ({ turns:0, out:0, ingest:0, replay:0, calls:0 });
const blen = c => c == null ? 0 : (typeof c === 'string' ? c.length : JSON.stringify(c).length);
// Split `amount` across classes by a {class: weight} map; fallback to `fb` class if all-zero.
function splitBy(cls, key, amount, weights, fb) {
  let tot = 0; for (const c of CLASSES) tot += weights[c] || 0;
  if (tot <= 0) { cls[fb][key] += amount; return; }
  for (const c of CLASSES) cls[c][key] += amount * ((weights[c] || 0) / tot);
}
const LOCK_STALE_MS = 60000, LOCK_WAIT_MS = 10000;         // crit section is <1s; steal after 60s, give up after 10s

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pidAlive = pid => { try { process.kill(pid,0); return true; } catch(e){ return e.code==='EPERM'; } };

// Atomic O_EXCL lock with stale recovery. Returns true if acquired, false on timeout.
async function acquireLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx');                  // create-exclusive: fails EEXIST if held
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, time: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let h = null; try { h = JSON.parse(fs.readFileSync(LOCK,'utf8')); } catch {}
      const stale = !h || (Date.now()-h.time > LOCK_STALE_MS) || !pidAlive(h.pid);
      if (stale) { try { fs.unlinkSync(LOCK); } catch {} await sleep(Math.random()*100); continue; }
      if (Date.now() > deadline) return false;
      await sleep(120 + Math.random()*180);                // jittered backoff
    }
  }
}
const releaseLock = () => { try { fs.unlinkSync(LOCK); } catch {} };

function localHour(ts) {                                    // UTC ISO -> LOCAL "YYYY-MM-DD HH" (system TZ)
  const d = new Date(ts); if (isNaN(d)) return null;
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}`;
}

// Derived per-scope fields (fresh burn rate, active span, billed) from a raw accumulator.
function derive(a) {
  const fresh = a.input + a.cc + a.out;                          // non-cache-read tokens; what the strategies target
  const activeMin = (a.firstTs && a.lastTs) ? (Date.parse(a.lastTs) - Date.parse(a.firstTs)) / 60000 : 0;
  const freshPerMin = activeMin >= 1 ? Math.round(fresh / activeMin) : fresh;   // burn rate; sub-minute span -> raw fresh
  return { ...a, billed:a.input+a.cr+a.cc+a.out, fresh, activeMin, freshPerMin };
}

// `seen` (optional) is a session-wide Set of message ids already counted, shared across the main
// transcript and every subagent transcript under it. See the dedup note in flushResponse.
async function metricsFor(file, seen) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let input=0,cr=0,cc=0,out=0,turns=0,peak=0,comps=0,lastTs=null,firstTs=null,firstModel=null;
  const hours = new Map();
  const newSeg = () => ({ turns:0, input:0, cr:0, cc:0, out:0, peak:0, init:0, firstTs:null, lastTs:null,
    cls: Object.fromEntries(CLASSES.map(c => [c, newCls()])),      // per-class token attribution
    cumCC: Object.fromEntries(CLASSES.map(c => [c, 0])) });        // running cache_creation per class (residency proxy)
  const segments = [];                                           // raw per-compaction-segment accumulators
  let seg = newSeg();
  const rebuilds = [];                                           // one window per compaction: { comp, ctxPre, summaryBytes, rows[] }
  let reb = null;                                                // window currently collecting (null before the first compaction)
  let lastCtx = 0;                                               // resident context of the most recently flushed response
  const breaks = [];                                             // large cache-write events, classed cold/compact/break
  let brkCount=0, brkCC=0, modelSwitches=0;                      // session aggregates (break kind only, for brkCount/brkCC)
  let respIdx = -1;                                              // 0-based index of the billed response being flushed
  let afterCompact = false;                                      // set at a compaction boundary, cleared by the next flush
  // Armed by a skipped API-error placeholder; consumed by the NEXT response to open a buffer, which
  // carries it to its own flush. It cannot be a bare "cleared by the next flush" flag like
  // afterCompact: a synthetic can land between two sibling records of a response that is still open
  // (see the interleaving note below), and that response is flushed AFTER the arming record is read
  // even though it ran BEFORE the failure. Handing the flag to the buffer at open time attaches it
  // to the response that actually re-sent the request, whatever order the records arrive in.
  let pendingApiError = false;
  let prevModel = null, prevTs = null;
  // cache_read of the previously flushed response -- the baseline the shrink test measures against.
  // Updated on EVERY billed response, not only the ones large enough to be logged: an ordinary small
  // write still moves the resident prefix, so skipping those would compare a large write against a
  // stale figure from several turns back and call an untouched prefix a break.
  let prevCacheRead = null;
  // A pasted /handoff pointer carries a machine-readable sentinel. Without it the ledger
  // cannot tell a handoff-seeded session from a cold /clear, which is the entire comparison the
  // init_context column exists to support.
  // Deliberately UNANCHORED. The pointer leads with the note's path and carries the sentinel
  // after it, so that the path -- the only part whose loss costs content -- sits inside the first
  // 80 columns where a wrapped-line mis-copy cannot reach it. Anchoring to ^ would match the old
  // pasted-note form only and score every pointer-seeded session as a cold /clear.
  const HANDOFF_RE = /HANDOFF v1 mode=(boundary|mid) parent=([0-9a-fA-F-]{8,})/;
  let handoff = null;                                            // { mode, parent } once seen
  const toolClass = new Map();                                   // tool_use_id -> class of the tool that produced it
  let pending = { reason:0, investigate:0, author:0, carry:0 };  // tool_result / user-text bytes awaiting next turn's cc split
  // ONE API response is written as SEVERAL assistant records sharing message.id -- one per content
  // block (the text, then each tool_use) -- and every record repeats the SAME usage object. Counting
  // per record therefore (a) multiplies turns and every token total by the block count (~2.1x
  // measured over 108 transcripts) and (b) wrecks the class split: the first record consumes
  // `pending` and zeroes it, so the sibling records hit the all-zero fallback and dump their whole
  // cache_creation into `carry`. Buffer the records of a response, flush once.
  //
  // Those sibling records are NOT always contiguous: with parallel tool calls the harness writes
  // each tool_result as soon as it lands, so a `user` record can sit BETWEEN two assistant records
  // of the same response. v2 flushed on every user record and therefore still split those responses
  // in two, re-billing their usage (+6.3% billed, +8.3% responses over 142 transcripts). A response
  // is now closed only by a new message.id, a compaction boundary, or EOF.
  //
  // That split the tool_result accounting in two, because a result arriving mid-response is ingested
  // by the NEXT response, not the open one: `pending` holds what the response being flushed ingested,
  // `staging` collects what arrives while it is still open and is promoted to `pending` on flush.
  let buf = null;                                                // { mid, usage, ts, names[] }
  let staging = { reason:0, investigate:0, author:0, carry:0 };
  const promote = () => {                                        // staged results become the next response's ingest
    pending = staging;
    staging = { reason:0, investigate:0, author:0, carry:0 };
  };
  const flushResponse = () => {
    if (!buf) return;
    const u = buf.usage, names = buf.names, ts = buf.ts, model = buf.model, retry = buf.retry, mid = buf.mid;
    buf = null;
    if (!u) { promote(); return; }                               // no usage: not a billed turn, but its results still carry forward
    // A subagent transcript opens with a COPY of the parent response that SPAWNED it -- the main-
    // thread response carrying the Agent tool_use, complete with its usage -- and when one response
    // spawns several agents at once, every one of their files carries that same copy. Counting per
    // file would therefore re-bill one real response two to four times over, each at full resident
    // context: 29 such copies across the 53 sessions that had a subagents/ directory when this was
    // written, at 100-150k cache_read apiece. `seen` makes the rule exact instead of heuristic --
    // a session's billed is the sum over UNIQUE message.id across its main transcript and every
    // agent transcript beneath it. run() parses the main transcript first, so the original is always
    // the copy that counts. (Workflow agents showed zero overlap; the shape is specific to the
    // Agent/Task spawn, but the guard costs nothing and does not care which shape produced it.)
    if (seen && mid) {
      if (seen.has(mid)) { promote(); return; }                  // already billed elsewhere in this session
      seen.add(mid);
    }
    turns++;
    const i=u.input_tokens||0, r=u.cache_read_input_tokens||0, c=u.cache_creation_input_tokens||0, og=u.output_tokens||0;
    input+=i; cr+=r; cc+=c; out+=og;
    const ctx = i+r+c; if (ctx>peak) peak=ctx;
    // Cache-write event classification. Runs BEFORE lastCtx is overwritten, because ctx_pre is the
    // resident context of the PREVIOUS response -- the size of the prefix this write replaced.
    respIdx++;
    const modelChanged = !!(prevModel && model && model !== prevModel);
    if (modelChanged) modelSwitches++;
    if (c >= BREAK_MIN_CC) {
      // Precedence is compact > cold > ttl > retry > growth > break. A post-compaction rebuild stays `compact`
      // even after a long idle gap, because the summary is the reason that write is large; a first
      // response has no previous timestamp to measure a gap against anyway. `ttl` outranks `retry`
      // because expiry is CERTAIN at that gap while the failure is only the last thing that happened
      // before it -- and the two collide often, since 81 of the 89 observed error placeholders are
      // rate-limit hits, which get waited out for hours.
      // `growth` sits LAST because it is the weakest claim of the four unavoidable kinds: it only
      // says no shrink was observed, whereas compact/cold/ttl/retry each name a cause. Where they
      // collide the named cause is the better label, and the actionable column is unaffected either
      // way -- all five are non-actionable, only `break` feeds the aggregates.
      const gapMin = (prevTs && ts) ? (Date.parse(ts) - Date.parse(prevTs)) / 60000 : null;
      const expired = gapMin != null && gapMin >= TTL_GAP_MIN;
      const shrank = prevCacheRead != null
        && r < prevCacheRead * GROWTH_READ_RATIO
        && (prevCacheRead - r) >= GROWTH_MIN_DROP;
      const kind = afterCompact ? 'compact'
                 : respIdx === 0 ? 'cold'
                 : expired ? 'ttl'
                 : retry ? 'retry'
                 : !shrank ? 'growth'
                 : 'break';
      breaks.push([respIdx, kind, r === 0 ? 'full' : 'partial', c, r, lastCtx,
        model || '', prevModel || '', modelChanged ? 1 : 0,
        gapMin == null ? '' : gapMin.toFixed(1), ts || '']);
      if (kind === 'break') { brkCount++; brkCC += c; }
    }
    afterCompact = false;
    if (!firstModel && model) firstModel = model;                // the model this transcript opened on (subagents often differ from their parent)
    prevModel = model || prevModel;                              // a response with no model id must not read as a switch
    prevTs = ts || prevTs;
    prevCacheRead = r;                                           // baseline for the next response's shrink test
    lastCtx = ctx;                                               // read at the next compaction boundary as ctx_pre
    if (reb && reb.rows.length < REBUILD_K) reb.rows.push([reb.rows.length, ctx, ctx+og, i, r, c, og]);
    seg.turns++; seg.input+=i; seg.cr+=r; seg.cc+=c; seg.out+=og; if (ctx>seg.peak) seg.peak=ctx;
    if (!seg.init) seg.init = ctx;                               // opening resident context = the floor this segment starts from
    if (!seg.firstTs) seg.firstTs = ts; seg.lastTs = ts;
    const tc = turnClassOf(names), C = seg.cls;
    C[tc].out += og + i; C[tc].turns++;                          // generation (output+input) -> response's class
    for (const n of names) C[toolClassOf(n)].calls++;
    splitBy(C, 'ingest', c, pending,   'carry');                 // this response's cache_creation, by ingested byte-share; unmapped -> carry (scaffolding)
    splitBy(C, 'replay', r, seg.cumCC, 'carry');                 // this response's cache_read, by residency BEFORE it
    let ptot=0; for (const cl of CLASSES) ptot += pending[cl];   // grow residency by this response's cc (same split as ingest)
    if (ptot>0) for (const cl of CLASSES) seg.cumCC[cl] += c * (pending[cl]/ptot);
    else seg.cumCC.carry += c;
    promote();
    const h = ts && localHour(ts);
    if (h) { const b = hours.get(h) || [0,0,0,0,0]; b[0]+=i; b[1]+=r; b[2]+=c; b[3]+=og; b[4]+=1; hours.set(h,b); }
  };
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp && (!lastTs  || o.timestamp > lastTs))  lastTs  = o.timestamp;
    if (o.timestamp && (!firstTs || o.timestamp < firstTs)) firstTs = o.timestamp;
    // Real compaction boundary: a user record flagged isCompactSummary closes the current
    // segment. The marker itself carries no usage; the summary's cost lands on the next
    // assistant turn's input/cache_creation, so it attributes to the new segment. This is
    // exact (unlike a token-drop proxy, which also fires on /clear or any big context drop).
    if (o.type === 'user' && o.isCompactSummary === true) {
      flushResponse();                                           // the pre-compaction response belongs to the OLD segment
      comps++;
      if (seg.turns) segments.push(seg);                         // don't emit an empty leading segment (resumed transcript)
      seg = newSeg();
      const summaryBytes = blen(o.message && o.message.content);
      // ctx_pre is 0 when the transcript OPENS on a summary (a resumed session): there is no
      // pre-compaction response in this file, so the threshold it fired at is unobservable here.
      reb = { comp: comps-1, ctxPre: lastCtx, summaryBytes, rows: [] };
      rebuilds.push(reb);
      afterCompact = true;                                       // the next flushed response pays the rebuild write
      pending = { reason:0, investigate:0, author:0, carry: summaryBytes };  // summary -> carry, cached next turn
      staging = { reason:0, investigate:0, author:0, carry:0 };  // results staged pre-compaction are not in the new context
      continue;
    }
    // Non-summary user record: accumulate the byte-share of its tool_results (each mapped to its
    // own tool's class) and typed text (-> carry, ambient). Consumed by the next assistant turn's
    // cache_creation split. Carries the "how heavy is each activity" footprint signal.
    if (o.type === 'user' && o.message) {
      // Deliberately does NOT flush -- see the interleaving note above. While a response is open its
      // results are STAGED (they belong to the next response's ingest); with none open they are
      // already the next response's pending.
      const tgt = buf ? staging : pending;
      const content = o.message.content;
      if (Array.isArray(content)) for (const b of content) {
        if (!b) continue;
        if (b.type === 'tool_result') tgt[toolClass.get(b.tool_use_id) || 'investigate'] += blen(b.content);
        else if (b.type === 'text')   { tgt.carry += blen(b.text); if (!handoff) { const mt = HANDOFF_RE.exec(b.text || ''); if (mt) handoff = { mode: mt[1], parent: mt[2] }; } }
      } else if (typeof content === 'string') {
        tgt.carry += content.length;
        if (!handoff) { const mt = HANDOFF_RE.exec(content); if (mt) handoff = { mode: mt[1], parent: mt[2] }; }
      }
      continue;
    }
    if (o.type !== 'assistant' || !o.message) continue;
    // A `<synthetic>` record is a harness placeholder, not a billed response: the model minted
    // nothing. Claude Code writes one for an API error AND for interrupt / cancel / reject / no-
    // response-requested (src/utils/messages.ts:302-308, all via the factory at :388-400), stamping
    // `model: '<synthetic>'` and a fresh randomUUID id. Its `usage` slot is always PRESENT and always
    // all-zero, so the `if (!u)` check in flushResponse admits it, and four things then break at
    // once: it counts as a turn; it latches prevModel (guarded only against an EMPTY id, and
    // '<synthetic>' is non-empty) so the next real response reads as a model switch; it overwrites
    // lastCtx with 0 so the next break records a replaced prefix of nothing; and its unique id closes
    // an open response, letting a sibling reopen the same message.id and re-bill it. Measured over
    // 190 transcripts: 50 placeholders, 50 phantom turns, 31 of 49 model_changed rows false, 35
    // ctx_pre destroyed -- and those 35 are the LARGEST writes in the ledger (170k, 151k, 110k).
    // Skipping without flushing is what upstream does: getTokenUsage (src/utils/tokens.ts:8-20) and
    // getAssistantMessageId (:22-38) both return undefined for these, and stats.ts:314 skips them
    // "they are internal and shouldn't appear in stats". The SKIP is keyed on the model id, NOT on
    // isApiErrorMessage (interrupts carry no such flag) and NOT on an all-zero usage (a real response
    // may legitimately bill no new cache).
    //
    // The `retry` LABEL is keyed the other way, on isApiErrorMessage, because only a FAILED request
    // explains the next write: an interrupt is user-caused and the prefix it abandons really was
    // thrown away, so that write stays avoidable. Both flag shapes appear in the wild -- 89 of 97
    // observed placeholders carry `true`, the other 8 an explicit `false` ("No response requested.")
    // -- so this tests for `true` rather than for the key's presence. Arming is cumulative because
    // repeated attempts write one placeholder each (60 of the 89 are the same spend-limit message),
    // and it is the first failure of a run that stops the prefix from being cached.
    if (o.message.model === SYNTHETIC_MODEL) {
      pendingApiError = pendingApiError || o.isApiErrorMessage === true;
      continue;
    }
    // Accumulate into the response buffer. Sibling records of the same response carry duplicate
    // usage (ignored) and one content block each -- their tool_use names must all reach the SAME
    // flush, or the response gets misclassed (a text block alone reads as `reason`).
    const mid = o.message.id;
    if (!buf || !mid || buf.mid !== mid) {
      flushResponse();
      buf = { mid, usage:null, ts:o.timestamp, names:[], model:null, retry: pendingApiError };
      pendingApiError = false;                                   // one failed run explains one rewrite
    }
    if (!buf.usage && o.message.usage) buf.usage = o.message.usage;
    if (!buf.model && o.message.model) buf.model = o.message.model;
    const content = o.message.content;
    if (Array.isArray(content)) for (const b of content) {
      if (b && b.type === 'tool_use') { buf.names.push(b.name); if (b.id) toolClass.set(b.id, toolClassOf(b.name)); }
    }
  }
  flushResponse();                                               // last response of the transcript
  if (seg.turns) segments.push(seg);
  if (!turns) return null;
  const s = derive({ input, cr, cc, out, turns, peak, firstTs, lastTs });
  return { date:(lastTs||'').slice(0,10), turns, billed:s.billed, input, cr, cc, out,
           freshPerMin:s.freshPerMin, activeMin:s.activeMin, peak, comps, firstTs, lastTs, hours, rebuilds, handoff,
           breaks, brkCount, brkCC, modelSwitches, firstModel,
           subAgents:0, subTurns:0, subBilled:0,                 // filled by mergeSubagents; 0 for a session that delegated nothing
           segments: segments.map(derive) };
}

// Subagent transcripts of one session, in the two shapes the harness writes:
//   <session>/subagents/agent-<id>.jsonl                   -- an Agent/Task tool spawn from the main thread
//   <session>/subagents/workflows/<wf>/agent-<id>.jsonl    -- one agent of a Workflow run
// journal.jsonl in a workflow directory is the runtime's own log and carries no usage, so the
// agent- prefix is the filter rather than the extension alone. Returns file paths plus the byte
// sizes that feed the growth check -- a session's agent set GROWS (a new agent is a new file), which
// the main transcript's own size never reflects, so a session already in the ledger has to be
// rescanned when its subagent bytes move even if its main transcript did not.
function subagentFiles(sessionId) {
  const root = path.join(PROJECT_DIR, sessionId, 'subagents');
  if (!fs.existsSync(root)) return [];
  const found = [];
  const collect = (dir, wf) => {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (!e.startsWith('agent-') || !e.endsWith('.jsonl')) continue;
      const p = path.join(dir, e);
      let bytes = 0;
      try { bytes = fs.statSync(p).size; } catch { continue; }
      found.push({ file:p, agentId:e.slice(6, -6), kind: wf ? 'workflow' : 'agent', workflow: wf || '', bytes });
    }
  };
  collect(root, '');
  const wfRoot = path.join(root, 'workflows');
  if (fs.existsSync(wfRoot)) {
    for (const wf of fs.readdirSync(wfRoot)) {
      const d = path.join(wfRoot, wf);
      try { if (fs.statSync(d).isDirectory()) collect(d, wf); } catch {}
    }
  }
  return found;
}
const subBytesOf = subs => subs.reduce((n, s) => n + s.bytes, 0);

// Fold each subagent run into the parent session and into ONE of its segments, mutating `m` in
// place. Segment attribution is by the agent's first response: the last segment already open at
// that moment owns it. That is what keeps the .v3-era invariant intact -- per-session sums over
// segments.csv still reconcile exactly to the sessions.csv row -- now that the session row counts
// delegated cost. An agent whose first response predates every segment (possible only in a
// transcript that opens on a compaction summary) falls to segment 0; one that starts after the last
// response falls to the final segment, which is the truthful place for a background agent that
// outlived the conversation.
//
// The session's active span is extended to the last agent response for the same reason: a Workflow
// can still be running minutes after the main thread went quiet, and fresh_per_min over a span that
// ends before the burn did would read high for the wrong reason.
function mergeSubagents(m, subs) {
  if (!subs.length) return;
  const segs = m.segments;
  for (const s of subs) {
    const g = s.g;
    let ix = 0;
    for (let i = 0; i < segs.length; i++) if (segs[i].firstTs && g.firstTs && segs[i].firstTs <= g.firstTs) ix = i;
    s.seg = segs.length ? ix : 0;
    if (segs.length) {
      const sg = segs[ix];
      sg.turns += g.turns; sg.input += g.input; sg.cr += g.cr; sg.cc += g.cc; sg.out += g.out;
      sg.subAgents = (sg.subAgents || 0) + 1;
      sg.subTurns  = (sg.subTurns  || 0) + g.turns;
      sg.subBilled = (sg.subBilled || 0) + g.billed;
      const D = sg.cls.delegate;                                 // out = the agent's own generation, ingest = its writes, replay = its reads
      D.turns += g.turns; D.out += g.out + g.input; D.ingest += g.cc; D.replay += g.cr;
      segs[ix] = derive(sg);                                     // billed/fresh/fresh_per_min recomputed from the new raw sums
    }
    m.turns += g.turns; m.input += g.input; m.cr += g.cr; m.cc += g.cc; m.out += g.out;
    m.subAgents++; m.subTurns += g.turns; m.subBilled += g.billed;
    if (g.lastTs && (!m.lastTs || g.lastTs > m.lastTs)) m.lastTs = g.lastTs;
    for (const [h, b] of g.hours) {                              // delegated burn lands in the hour it happened
      const t = m.hours.get(h) || [0,0,0,0,0];
      t[0]+=b[0]; t[1]+=b[1]; t[2]+=b[2]; t[3]+=b[3]; t[4]+=b[4];
      m.hours.set(h, t);
    }
  }
  const d = derive({ input:m.input, cr:m.cr, cc:m.cc, out:m.out, firstTs:m.firstTs, lastTs:m.lastTs });
  m.billed = d.billed; m.activeMin = d.activeMin; m.freshPerMin = d.freshPerMin;
  m.date = (m.lastTs || '').slice(0, 10);
}

// Per-day duration-weighted rollup. PURE function of sessions.csv (the durable record), so it can be
// fully rebuilt every run with no transcript dependency and no double-count risk. fresh_per_min here is
// sum(fresh)/sum(active_min) across the day's sessions -- NOT the mean of per-session rates, which would
// let a short high-rate burst dominate. Rows whose active_min is blank (transcript rotated away) are skipped.
const DHEADER = ['date','sessions','turns','total_billed','fresh','output','active_min','fresh_per_min','sub_billed'];
function buildDaily() {
  if (!fs.existsSync(OUT)) return;
  const day = new Map();                                   // date -> [sessions,turns,billed,fresh,output,activeMin,subBilled]
  for (const l of fs.readFileSync(OUT,'utf8').split('\n').slice(1)) {
    if (!l) continue;
    const c = l.split(',');                                // 1 date,2 turns,3 billed,4 in,6 cc,7 out,9 active_min,22 sub_billed
    const date = c[1], am = parseFloat(c[9]);
    if (!date || !am || isNaN(am)) continue;               // no active_min -> pre-rotation history, skip
    const out = (+c[7]||0);
    const fresh = (+c[4]||0) + (+c[6]||0) + out;
    const b = day.get(date) || [0,0,0,0,0,0,0];
    b[0]+=1; b[1]+=(+c[2]||0); b[2]+=(+c[3]||0); b[3]+=fresh; b[4]+=out; b[5]+=am; b[6]+=(+c[22]||0);
    day.set(date,b);
  }
  const rows = [...day.entries()].sort((a,b)=>a[0]<b[0]?-1:1)
    .map(([d,b]) => [d,b[0],b[1],b[2],b[3],b[4],b[5].toFixed(1), Math.round(b[3]/b[5]), b[6]].join(','));
  fs.writeFileSync(DAILY, DHEADER.join(',')+'\n'+rows.join('\n')+(rows.length?'\n':''));
  return rows.length;
}

// Per-hour rollup. PURE function of session_hours.csv, same reasoning as buildDaily: rebuilding
// it in full every run is what makes an upsert-by-id (rather than append-only) SESSHR safe -- a
// grown session's old hour contribution is never double-counted because it's replaced, not added to.
function buildHourly() {
  if (!fs.existsSync(SESSHR)) return;
  const hour = new Map();                                   // hour -> [input,cache_read,cache_creation,output,turns]
  for (const l of fs.readFileSync(SESSHR,'utf8').split('\n').slice(1)) {
    if (!l) continue;
    const c = l.split(',');                                 // 1 hour,2 input,3 cache_read,4 cache_creation,5 output,6 turns
    const h = c[1]; if (!h) continue;
    const b = hour.get(h) || [0,0,0,0,0];
    b[0]+=(+c[2]||0); b[1]+=(+c[3]||0); b[2]+=(+c[4]||0); b[3]+=(+c[5]||0); b[4]+=(+c[6]||0);
    hour.set(h,b);
  }
  const rows = [...hour.entries()].sort((a,b)=>a[0]<b[0]?-1:1)
    .map(([h,b]) => [h,b[0],b[1],b[2],b[3], b[0]+b[1]+b[2]+b[3], b[4]].join(','));
  fs.writeFileSync(HOURLY, HHEADER.join(',')+'\n'+rows.join('\n')+(rows.length?'\n':''));
}

// Read an id-keyed ledger into a Map<session_id, string[]> of its raw data lines (header stripped),
// creating the file with just a header if it doesn't exist yet.
function readLedger(file, header) {
  if (!fs.existsSync(file)) { fs.writeFileSync(file, header.join(',')+'\n'); return new Map(); }
  const m = new Map();
  for (const l of fs.readFileSync(file,'utf8').split('\n').slice(1)) {
    if (!l) continue;
    const id = l.split(',')[0]; if (!id) continue;
    (m.get(id) || m.set(id, []).get(id)).push(l);
  }
  return m;
}
const writeLedger = (file, header, byId) =>
  fs.writeFileSync(file, header.join(',')+'\n'+[...byId.values()].flat().join('\n')+(byId.size?'\n':''));

async function run() {
  const sessions = readLedger(OUT, HEADER);           // id -> [row] (exactly one row per id)
  const segsById = readLedger(SEG, SHEADER);          // id -> [seg rows]
  const actById  = readLedger(ACT, AHEADER);          // id -> [activity rows]
  const hrsById  = readLedger(SESSHR, HRHEADER);      // id -> [hour rows]
  const rebById  = readLedger(REB, RHEADER);          // id -> [rebuild-curve rows]
  const brkById  = readLedger(BRK, BHEADER);          // id -> [cache-write-event rows]
  const subById  = readLedger(SUB, SUBHEADER);        // id -> [subagent rows]

  const recordedBytes = new Map();                   // id -> file size at last scan (col 13; NaN/missing -> 0, forces a rescan)
  const recordedSubBytes = new Map();                // id -> total subagent bytes at last scan (col 23; absent on .v3-era rows -> 0)
  for (const [id, rows] of sessions) {
    const c = rows[0].split(',');
    recordedBytes.set(id, +c[13] || 0);
    recordedSubBytes.set(id, +c[23] || 0);
  }

  const now = Date.now(); let added=0, grown=0;
  for (const f of fs.readdirSync(PROJECT_DIR).filter(f=>f.endsWith('.jsonl'))) {
    const id = f.replace(/\.jsonl$/,'');
    const filePath = path.join(PROJECT_DIR,f);
    const isNew = !sessions.has(id);
    const subs = subagentFiles(id), subBytes = subBytesOf(subs);
    if (!isNew && !RESCAN) {
      const bytes = fs.statSync(filePath).size;
      // BOTH sizes have to match. A session's main transcript can sit byte-stable while a Workflow
      // it launched is still writing agent files, so the main-transcript check alone would freeze
      // the session at whatever its delegated cost happened to be on the scan that first saw it.
      if (bytes === recordedBytes.get(id) && subBytes === recordedSubBytes.get(id)) continue;
    }
    const seen = new Set();                           // message ids already billed anywhere in this session
    const m = await metricsFor(filePath, seen);       // main transcript FIRST: it owns every id it shares with an agent
    if (!m) continue;
    // Every plain subagent transcript opens with a COPY of the parent response that spawned it
    // (isSidechain, same message.id, full usage), and a parallel fan-out replicates that one record
    // into each agent file. Parsing all of them against the shared `seen` set bills each id exactly
    // once, to the main thread, so spawning N agents no longer multiplies its spawning turn by N.
    for (const s of subs) s.g = await metricsFor(s.file, seen);
    const live = subs.filter(s => s.g && s.g.turns);  // an agent whose every response was a duplicate adds nothing
    mergeSubagents(m, live);                          // m.lastTs may now extend past the main thread -- gate on it below
    const quiesced = m.lastTs && now - Date.parse(m.lastTs) > 120000;      // only fully-quiesced sessions
    if (!quiesced) continue;                          // still active (or just went quiet) -- catch it next run

    const bytes = fs.statSync(filePath).size, stamp = new Date().toISOString();
    sessions.set(id, [[id,m.date,m.turns,m.billed,m.input,m.cr,m.cc,m.out,
      m.freshPerMin,m.activeMin.toFixed(1),m.peak,m.comps,stamp,bytes,
      (m.segments[0] && m.segments[0].init) || 0,
      m.handoff ? 1 : 0, m.handoff ? m.handoff.parent : '',
      m.brkCount, m.brkCC, m.modelSwitches,
      m.subAgents, m.subTurns, m.subBilled, subBytes].join(',')]);
    segsById.set(id, m.segments.map((sg,ix) => [id,ix,(sg.lastTs||'').slice(0,10),sg.turns,sg.billed,
      sg.input,sg.cr,sg.cc,sg.out,sg.freshPerMin,sg.activeMin.toFixed(1),sg.peak,stamp,sg.init,
      sg.subAgents||0, sg.subTurns||0, sg.subBilled||0].join(',')));
    const actRows = [];
    m.segments.forEach((sg,ix) => {
      const segBilled = sg.billed || 1, sessBilled = m.billed || 1;
      for (const cl of CLASSES) {
        const k = sg.cls[cl], tot = k.out + k.ingest + k.replay;
        actRows.push([id,ix,cl,k.turns,Math.round(k.out),Math.round(k.ingest),Math.round(k.replay),
          k.calls,(100*tot/segBilled).toFixed(1),(100*tot/sessBilled).toFixed(1),stamp].join(','));
      }
    });
    actById.set(id, actRows);
    hrsById.set(id, [...m.hours.entries()].map(([h,b]) => [id,h,b[0],b[1],b[2],b[3],b[4]].join(',')));
    const rebRows = m.rebuilds.flatMap(rb => rb.rows.map(w =>
      [id,rb.comp,w[0],w[1],w[2],w[3],w[4],w[5],w[6],rb.ctxPre,rb.summaryBytes,stamp].join(',')));
    if (rebRows.length) rebById.set(id, rebRows); else rebById.delete(id);   // a session with no compaction contributes nothing
    const brkRows = m.breaks.map(b => [id, ...b, stamp].join(','));
    if (brkRows.length) brkById.set(id, brkRows); else brkById.delete(id);   // no large write -> no rows (upsert must clear stale ones)
    const subRows = live.map(s => { const g = s.g; return [id, s.agentId, s.kind, s.workflow, s.seg,
      g.firstModel||'', g.date, g.turns, g.billed, g.input, g.cr, g.cc, g.out,
      g.activeMin.toFixed(1), g.peak, g.firstTs||'', g.lastTs||'', s.bytes, stamp].join(','); });
    if (subRows.length) subById.set(id, subRows); else subById.delete(id);   // delegated nothing -> no rows
    if (isNew) added++; else grown++;
  }

  writeLedger(OUT, HEADER, sessions);
  writeLedger(SEG, SHEADER, segsById);
  writeLedger(ACT, AHEADER, actById);
  writeLedger(SESSHR, HRHEADER, hrsById);
  writeLedger(REB, RHEADER, rebById);
  writeLedger(BRK, BHEADER, brkById);
  writeLedger(SUB, SUBHEADER, subById);
  buildHourly();                                     // pure rebuild from session_hours.csv
  const dailyRows = buildDaily();                      // pure rebuild from sessions.csv
  if (process.stdout.isTTY) console.log(`recorded ${added} new session(s), ${grown} grown/updated session(s); daily rows: ${dailyRows}`);
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  if (!(await acquireLock())) { console.error('metrics: lock busy, skipping (next run will catch up)'); return; }
  try { await run(); } finally { releaseLock(); }
})();
