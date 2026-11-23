#!/usr/bin/env node
/**
 * build-dashboard.mjs — render the token-consumption dashboard from the
 * metrics CSVs written by the token-hygiene plugin's hooks/record-session-metrics.js.
 *
 * The dashboard is a pure function of the CSVs: no model, no network, no state.
 * Re-run it whenever you want fresh numbers.
 *
 *   node skills/token-dashboard/scripts/build-dashboard.mjs
 *   node skills/token-dashboard/scripts/build-dashboard.mjs --since 2026-07-01 --json
 *
 * Flags
 *   --suffix <s>   metrics generation to read (default: $METRICS_SUFFIX or .v4).
 *                  Generations never mix. .v4 counts subagent transcripts (Agent-tool spawns and
 *                  Workflow agents) inside every session and segment total, which .v3 never opened,
 *                  so a .v4 number is LARGER than the .v3 number for the same day -- on the measured
 *                  corpus delegated work is ~36% of all billed tokens. .v3 closes a response only on
 *                  a new message.id; .v2 also split on interleaved tool_result records (+6.3% billed)
 *                  and the legacy unsuffixed CSVs double-count ~2.1x. The older sets are frozen; .v3
 *                  still holds sessions whose transcripts rotated away before .v4 existed.
 *   --since <date> ISO date, inclusive lower bound (default: earliest recorded)
 *   --until <date> ISO date, inclusive upper bound (default: latest recorded)
 *   --out <path>   output HTML (default: <project>/docs/token-dashboard<suffix>.html)
 *   --dir <path>   metrics directory (default: $METRICS_DIR or ~/.claude/metrics)
 *   --json         print the analysis summary as JSON instead of text
 *   --no-html      compute and print the summary without writing the HTML
 *   --help
 *
 * Exit codes: 0 ok · 1 bad usage or missing/empty inputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inDefault } from './build-turns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(HERE, 'dashboard.template.html');
const REQUIRED = ['sessions', 'segments', 'activity', 'daily', 'hourly'];

/* ---------- args ---------- */
function parseArgs(argv) {
  const o = { json: false, html: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-html') o.html = false;
    else if (a === '--suffix') o.suffix = next();
    else if (a === '--since') o.since = next();
    else if (a === '--until') o.until = next();
    else if (a === '--out') o.out = next();
    else if (a === '--dir') o.dir = next();
    else die(`unknown flag: ${a}`);
  }
  return o;
}
function die(msg) {
  process.stderr.write(`build-dashboard: ${msg}\n`);
  process.exit(1);
}
const isDate = s => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/* ---------- csv ---------- */
function readCsv(dir, name, suffix) {
  const file = path.join(dir, `${name}${suffix}.csv`);
  if (!fs.existsSync(file)) die(`missing ${file} — run a session with the record-session-metrics.js hook first`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  if (lines.length < 2) die(`${file} has no data rows`);
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map(line => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => {
      const v = cells[i];
      row[h] = (v !== '' && v !== undefined && !Number.isNaN(Number(v))) ? Number(v) : v;
    });
    return row;
  });
}

// The rebuild ledger arrived after the .v3 generation was cut, and older generations never had
// one, so its absence is normal rather than an error: return null and let the compaction block
// drop out of the summary.
function readCsvOptional(dir, name, suffix) {
  return fs.existsSync(path.join(dir, `${name}${suffix}.csv`)) ? readCsv(dir, name, suffix) : null;
}

/* ---------- date helpers ---------- */
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = iso => addDays(iso, -(((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7)));
const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
// Median of a numeric array. Medians, not means, throughout the compaction block: the rebuild
// spike and the occasional 500k-context outlier would drag a mean well off the typical case.
const med2 = xs => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

/* ---------- aggregation ---------- */
function build(opts) {
  const dir = opts.dir || process.env.METRICS_DIR || path.join(os.homedir(), '.claude', 'metrics');
  const suffix = opts.suffix !== undefined ? opts.suffix : (process.env.METRICS_SUFFIX ?? '.v4');
  const raw = Object.fromEntries(REQUIRED.map(n => [n, readCsv(dir, n, suffix)]));

  const inRange = d => (!opts.since || d >= opts.since) && (!opts.until || d <= opts.until);
  const sessions = raw.sessions.filter(s => inRange(s.date));
  const segments = raw.segments.filter(s => inRange(s.date));
  if (!sessions.length) die(`no sessions in range${opts.since ? ' since ' + opts.since : ''}${opts.until ? ' until ' + opts.until : ''}`);

  const keep = new Set(sessions.map(s => s.session_id));
  const activity = raw.activity.filter(a => keep.has(a.session_id));
  const dailyRows = raw.daily.filter(d => inRange(d.date));
  const hourlyRows = raw.hourly.filter(h => inRange(String(h.hour).slice(0, 10)));

  const dates = sessions.map(s => s.date).sort();
  const first = dates[0], last = dates[dates.length - 1];

  const timed = sessions.filter(s => typeof s.active_min === 'number');

  // Reset-floor comparison. A handoff-seeded session opened on a pasted note after /clear; a cold
  // one opened on nothing. Both are compared against the compaction floor computed further down,
  // which is the number this whole exercise is trying to beat. Medians for the same reason the
  // compaction block uses them: one 500k-context outlier would drag a mean off the typical case.
  const withFloor = sessions.filter(s => Number(s.init_context) > 0);
  const seeded = withFloor.filter(s => Number(s.handoff) === 1);
  const cold = withFloor.filter(s => Number(s.handoff) !== 1);
  const handoff = {
    n: seeded.length,
    cold_n: cold.length,
    floor_median: seeded.length ? Math.round(med2(seeded.map(s => Number(s.init_context)))) : null,
    cold_floor_median: cold.length ? Math.round(med2(cold.map(s => Number(s.init_context)))) : null,
  };

  const totals = {
    billed: sum(sessions, 'total_billed'),
    input: sum(sessions, 'input'),
    cache_read: sum(sessions, 'cache_read'),
    cache_creation: sum(sessions, 'cache_creation'),
    output: sum(sessions, 'output'),
    turns: sum(sessions, 'turns'),
    sessions: sessions.length,
    compactions: sum(sessions, 'compactions'),
    active_min: sum(timed, 'active_min'),
    days: new Set(sessions.map(s => s.date)).size,
    // Delegated share. Already INCLUDED in `billed`/`turns` above -- these break it back out rather
    // than adding to it. Zero on a .v3-era row, which is honest: that generation could not see it.
    sub_billed: sum(sessions, 'sub_billed'),
    sub_turns: sum(sessions, 'sub_turns'),
    sub_agents: sum(sessions, 'sub_agents'),
    first, last,
  };
  totals.fresh = totals.input + totals.cache_creation + totals.output;
  totals.fresh_per_min = totals.active_min ? totals.fresh / totals.active_min : 0;
  totals.billed_per_turn = totals.turns ? totals.billed / totals.turns : 0;

  // activity classes, joined to a date through the segment ledger
  const segDate = new Map(segments.map(s => [s.session_id + '|' + s.seg, s.date]));
  const classTot = {}, dayClass = {};
  for (const a of activity) {
    const v = (a.out || 0) + (a.ingest || 0) + (a.replay || 0);
    classTot[a.class] = (classTot[a.class] || 0) + v;
    const d = segDate.get(a.session_id + '|' + a.seg);
    if (!d) continue;
    dayClass[d] = dayClass[d] || {};
    dayClass[d][a.class] = (dayClass[d][a.class] || 0) + v;
  }
  const actTotal = Object.values(classTot).reduce((a, b) => a + b, 0);

  // per-day split of input/cache_read/cache_creation/compactions, from the
  // session ledger (daily.csv only carries total_billed/fresh/output) — needed
  // so the dashboard's client-side time filter can re-derive every KPI for an
  // arbitrary sub-range without a re-run of this script.
  const sessByDate = new Map();
  for (const s of sessions) {
    const acc = sessByDate.get(s.date) ||
      { input: 0, cache_read: 0, cache_creation: 0, compactions: 0, sub_billed: 0, sub_turns: 0, sub_agents: 0 };
    acc.input += s.input || 0;
    acc.cache_read += s.cache_read || 0;
    acc.cache_creation += s.cache_creation || 0;
    acc.compactions += s.compactions || 0;
    acc.sub_billed += s.sub_billed || 0;
    acc.sub_turns += s.sub_turns || 0;
    acc.sub_agents += s.sub_agents || 0;
    sessByDate.set(s.date, acc);
  }

  // Prompt-cache write events. cache_creation is heavily concentrated -- a small share of responses
  // carries most of it -- and the aggregate column cannot say whether a given spike was avoidable.
  // The ledger splits it six ways: `cold` (session boot, unavoidable), `compact` (post-compaction
  // rebuild, the price of not having cleared), `ttl` (the prefix had simply expired after a >=60min
  // idle gap, so nothing was thrown away), `retry` (the request before it FAILED, and a failed
  // request caches nothing, so there was no entry to throw away either), `growth` (cache_read held
  // up against the previous response, so the prefix GREW rather than being discarded -- new content
  // entering the cache for the first time) and `break` (a mid-session prefix invalidation inside the
  // TTL, i.e. cache genuinely discarded while the session ran -- the only avoidable kind). A kind absent from the CSV simply totals zero, so a ledger written before
  // that kind existed still renders. Events
  // carry their own ts, so unlike the rebuild ledger they date themselves; a row with no ts falls
  // back to its session's date so it still lands in the day series rather than vanishing.
  const brkRaw = (readCsvOptional(dir, 'breaks', suffix) || []).filter(b => keep.has(b.session_id));
  const sessDate = new Map(sessions.map(s => [s.session_id, s.date]));
  const newBrk = () => ({ cold_n: 0, cold_cc: 0, compact_n: 0, compact_cc: 0, ttl_n: 0, ttl_cc: 0,
    retry_n: 0, retry_cc: 0, growth_n: 0, growth_cc: 0, break_n: 0, break_cc: 0, model_n: 0, full_n: 0 });
  const brkByDate = new Map(), brkTot = newBrk();
  for (const b of brkRaw) {
    const d = (String(b.ts || '').slice(0, 10)) || sessDate.get(b.session_id);
    const cc = Number(b.cache_creation) || 0;
    for (const acc of [brkTot, d ? (brkByDate.get(d) || brkByDate.set(d, newBrk()).get(d)) : newBrk()]) {
      acc[`${b.kind}_n`]++; acc[`${b.kind}_cc`] += cc;
      if (Number(b.model_changed) === 1) acc.model_n++;
      if (b.severity === 'full') acc.full_n++;
    }
  }
  // Median per kind, not mean: one 500k-context event would drag a mean off the typical case, and
  // the typical cold boot is the number worth comparing a compaction rebuild against.
  for (const k of ['cold', 'compact', 'ttl', 'retry', 'growth', 'break']) {
    const xs = brkRaw.filter(b => b.kind === k).map(b => Number(b.cache_creation) || 0);
    brkTot[`${k}_median`] = xs.length ? Math.round(med2(xs)) : 0;
  }
  // Worst individual mid-session breaks, for the table. ctx_pre is the prefix that was discarded.
  const breakTop = brkRaw.filter(b => b.kind === 'break')
    .sort((a, b) => (Number(b.cache_creation) || 0) - (Number(a.cache_creation) || 0)).slice(0, 15)
    .map(b => ({ date: String(b.ts || '').slice(0, 10) || sessDate.get(b.session_id) || '',
      session: String(b.session_id).slice(0, 8), cc: Number(b.cache_creation) || 0,
      cr: Number(b.cache_read) || 0, ctx_pre: Number(b.ctx_pre) || 0, severity: b.severity,
      model_changed: Number(b.model_changed) === 1, model: b.model, prev_model: b.prev_model }));

  // gap-filled day series
  const dailyMap = new Map(dailyRows.map(d => [d.date, d]));
  const days = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const r = dailyMap.get(d) || {};
    const c = dayClass[d] || {};
    const sd = sessByDate.get(d) || {};
    days.push({
      date: d,
      sessions: r.sessions || 0,
      turns: r.turns || 0,
      billed: r.total_billed || 0,
      fresh: r.fresh || 0,
      output: r.output || 0,
      input: sd.input || 0,
      cache_read: sd.cache_read || 0,
      cache_creation: sd.cache_creation || 0,
      compactions: sd.compactions || 0,
      active_min: r.active_min || 0,
      fpm: r.fresh_per_min || 0,
      sub_billed: sd.sub_billed || 0,
      sub_turns: sd.sub_turns || 0,
      sub_agents: sd.sub_agents || 0,
      cls: {
        investigate: c.investigate || 0, carry: c.carry || 0,
        reason: c.reason || 0, author: c.author || 0, delegate: c.delegate || 0,
      },
      brk: brkByDate.get(d) || newBrk(),
    });
  }

  // hour grid + hour-of-day profile
  const grid = {}, hourProfile = new Array(24).fill(0);
  for (const h of hourlyRows) {
    const [d, hh] = String(h.hour).split(' ');
    const hi = Number(hh);
    grid[d] = grid[d] || new Array(24).fill(0);
    grid[d][hi] += h.total_billed || 0;
    hourProfile[hi] += h.total_billed || 0;
  }

  const segPts = segments.filter(s => s.turns > 0 && s.peak_context > 0).map(s => ({
    ctx: s.peak_context, per_turn: s.total_billed / s.turns, turns: s.turns, date: s.date, seg: s.seg,
  }));

  // weekly rollup
  const wk = new Map();
  for (const d of days) {
    const k = mondayOf(d.date);
    const w = wk.get(k) || { week: k, billed: 0, fresh: 0, turns: 0, active_min: 0, sessions: 0, days: 0 };
    w.billed += d.billed; w.fresh += d.fresh; w.turns += d.turns;
    w.active_min += d.active_min; w.sessions += d.sessions;
    if (d.billed > 0) w.days++;
    wk.set(k, w);
  }
  const weekly = [...wk.values()].map(w => ({
    ...w,
    fpm: w.active_min ? Math.round(w.fresh / w.active_min) : 0,
    billed_per_turn: w.turns ? Math.round(w.billed / w.turns) : 0,
  }));

  // Post-compaction rebuild curves, one per compaction event, restricted to the in-range sessions.
  // The ledger has no date column of its own -- a compaction belongs to the date of its session.
  const rebRaw = readCsvOptional(dir, 'rebuild', suffix) || [];
  const inScope = new Set(sessions.map(s => s.session_id));
  const wmap = new Map();
  for (const r of rebRaw) {
    if (!inScope.has(r.session_id)) continue;
    const k = `${r.session_id}|${r.comp}`;
    const w = wmap.get(k) || { ctx_pre: Number(r.ctx_pre) || 0, rows: [] };
    w.rows.push({ k: Number(r.k), ctx: Number(r.ctx) || 0, cc: Number(r.cache_creation) || 0 });
    wmap.set(k, w);
  }
  const rebuild = [...wmap.values()].map(w => ({ ...w, rows: w.rows.sort((a, b) => a.k - b.k) }));

  // Delegated work, one row per subagent run. The ledger arrived with .v4, so its absence means an
  // older generation is being read and the whole block drops out rather than rendering as zeros --
  // which would read as "nothing was delegated" when the truth is "this generation could not see
  // it". Workflow runs are grouped by their wf_ id: a single Workflow call is one economic event
  // even though it writes one transcript per agent, and its cost is the group's, not any agent's.
  const subRaw = (readCsvOptional(dir, 'subagents', suffix) || []).filter(r => inScope.has(r.session_id));
  let delegation = null;
  if (subRaw.length) {
    const kind = { agent: { n: 0, billed: 0, turns: 0 }, workflow: { n: 0, billed: 0, turns: 0 } };
    const wfMap = new Map();
    for (const r of subRaw) {
      const k = kind[r.kind] || (kind[r.kind] = { n: 0, billed: 0, turns: 0 });
      k.n++; k.billed += r.total_billed || 0; k.turns += r.turns || 0;
      if (r.kind !== 'workflow' || !r.workflow) continue;
      const w = wfMap.get(r.workflow) ||
        wfMap.set(r.workflow, { workflow: r.workflow, session: String(r.session_id).slice(0, 8),
                                date: r.date, agents: 0, turns: 0, billed: 0 }).get(r.workflow);
      w.agents++; w.turns += r.turns || 0; w.billed += r.total_billed || 0;
    }
    const byModel = {};
    for (const r of subRaw) {
      const m = r.model || 'unknown';
      byModel[m] = byModel[m] || { n: 0, billed: 0 };
      byModel[m].n++; byModel[m].billed += r.total_billed || 0;
    }
    delegation = {
      agents: subRaw.length,
      sessions: new Set(subRaw.map(r => r.session_id)).size,
      billed: sum(subRaw, 'total_billed'),
      turns: sum(subRaw, 'turns'),
      kind, by_model: byModel,
      top_workflows: [...wfMap.values()].sort((a, b) => b.billed - a.billed).slice(0, 10),
      // 25, not 5: the dashboard filters this list by the client-side date range, so a short list
      // would empty out the panel for any range that excludes the all-time heaviest runs.
      top_agents: [...subRaw].sort((a, b) => (b.total_billed || 0) - (a.total_billed || 0)).slice(0, 25)
        .map(r => ({ date: r.date, session: String(r.session_id).slice(0, 8), kind: r.kind,
                     workflow: r.workflow || '', model: r.model || '', turns: r.turns || 0,
                     billed: r.total_billed || 0, active_min: r.active_min || 0, peak_context: r.peak_context || 0 })),
    };
  }

  // Per-response scatter points (model time vs. output volume), one row per turns.v4.csv response.
  // Optional: dashboards built before build-turns.mjs --write ever ran, or against an older
  // generation that predates it, must still render. Restricted to in-range, in-scope sessions and
  // to inDefault -- the population build-turns.mjs itself defines as the one a human was actually
  // waiting on -- so a headless or queued/injected response doesn't sit on a chart about that wait.
  // model_s/output_tokens are filtered to strictly positive because both axes render log scale.
  const turnsRaw = (readCsvOptional(dir, 'turns', suffix) || [])
    .filter(r => inScope.has(r.session_id) && inRange(String(r.start_ts || '').slice(0, 10)) && inDefault(r));
  const turnPts = turnsRaw.filter(r => Number(r.model_s) > 0 && Number(r.output_tokens) > 0).map(r => ({
    date: String(r.start_ts || '').slice(0, 10), model_s: Number(r.model_s), output_tokens: Number(r.output_tokens),
    dominant_class: r.dominant_class || '', session: String(r.session_id).slice(0, 8), seq: Number(r.turn_seq),
  }));

  // Same population as turnPts, but without its positive-value filter: tool_wait_s, duration_s and
  // interrupted are meaningful even on a turn whose model_s or output_tokens rounds to zero, and the
  // three per-class panels (model-vs-tool-wait split, interrupt rate, turn-length distribution) need
  // every row to get honest quantiles. duration_s occasionally rounds slightly negative from clock
  // skew near zero -- left raw here, clamped only at render time for the log-scale box plots.
  const latencyPts = turnsRaw.map(r => ({
    date: String(r.start_ts || '').slice(0, 10), dominant_class: r.dominant_class || '',
    model_s: Number(r.model_s) || 0, tool_wait_s: Number(r.tool_wait_s) || 0,
    duration_s: Number(r.duration_s) || 0, interrupted: Number(r.interrupted) || 0,
  }));

  const meta = {
    project: path.basename(process.env.CLAUDE_PROJECT_DIR || process.cwd()),
    dir: dir.replace(os.homedir(), '~'),
    suffix,
    generation: suffix.replace(/^\./, '') || 'legacy',
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    since: opts.since || null,
    until: opts.until || null,
  };

  return { meta, totals, classTot, actTotal, days, grid, hourProfile, segPts, turnPts, latencyPts, weekly, rebuild,
           handoff, brkTot, breakTop, delegation };
}

/* ---------- analysis summary (what a reader/model needs, not the whole dataset) ---------- */
function summarize(D) {
  const T = D.totals;
  const active = D.days.filter(d => d.billed > 0);
  const sorted = [...active].sort((a, b) => b.billed - a.billed);
  const med = [...active].map(d => d.billed).sort((a, b) => a - b)[active.length >> 1] || 0;
  const pct = (a, b) => b ? +(100 * a / b).toFixed(1) : 0;

  // least squares: billed-per-response against peak resident context
  const n = D.segPts.length;
  let slope = null, r2 = null;
  if (n > 2) {
    const mx = D.segPts.reduce((a, p) => a + p.ctx, 0) / n;
    const my = D.segPts.reduce((a, p) => a + p.per_turn, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const p of D.segPts) {
      sxy += (p.ctx - mx) * (p.per_turn - my);
      sxx += (p.ctx - mx) ** 2;
      syy += (p.per_turn - my) ** 2;
    }
    slope = sxx ? +(sxy / sxx).toFixed(3) : null;
    r2 = (sxx && syy) ? +((sxy * sxy) / (sxx * syy)).toFixed(3) : null;
  }

  const weeks = D.weekly;
  const wow = weeks.length >= 2 ? (() => {
    const [prev, cur] = weeks.slice(-2);
    const delta = (a, b) => b ? +(100 * (a - b) / b).toFixed(1) : null;
    return {
      current_week: cur.week, previous_week: prev.week,
      billed_pct: delta(cur.billed, prev.billed),
      fresh_per_min_pct: delta(cur.fpm, prev.fpm),
      turns_pct: delta(cur.turns, prev.turns),
      billed_per_turn_pct: delta(cur.billed_per_turn, prev.billed_per_turn),
      note: 'the latest week may be partial — check its days count before reading the delta as a trend',
    };
  })() : null;

  const peakHour = D.hourProfile.indexOf(Math.max(...D.hourProfile));

  // Compaction economics. Cost per response is essentially resident context, so a session's bill is
  // the area under its context curve; the three numbers that set the optimal compaction threshold
  // are the floor it lands on (C0), how fast context regrows (g) and the one-shot rebuild spike (O).
  // g is measured WITHIN a window (paired consecutive responses), which removes the session-length
  // confound that makes a naive across-segment comparison say post-compaction segments cost more.
  const compaction = (() => {
    const W = D.rebuild || [];
    const full = W.filter(w => w.rows.length >= 4);         // need a few responses to see the curve
    if (full.length < 5) return null;
    const fired = W.map(w => w.ctx_pre).filter(v => v > 0); // 0 = transcript opened on a summary
    const deltas = full.flatMap(w => w.rows.slice(1).map((r, i) => r.ctx - w.rows[i].ctx));
    const tail = full.flatMap(w => w.rows.slice(-2).map(r => r.cc));
    const steady = med2(tail);
    const kMax = Math.max(...full.map(w => w.rows.length));
    let overhead = 0;
    for (let k = 0; k < kMax; k++) {
      const at = full.filter(w => w.rows.length > k).map(w => w.rows[k].cc);
      if (at.length) overhead += Math.max(0, med2(at) - steady);
    }
    return {
      compactions: W.length,
      fired_at_median: fired.length ? Math.round(med2(fired)) : null,
      fired_at_min: fired.length ? Math.min(...fired) : null,
      floor_median: Math.round(med2(full.map(w => w.rows[0].ctx))),
      growth_per_response: Math.round(med2(deltas)),
      rebuild_overhead: Math.round(overhead),
      steady_cache_creation: Math.round(steady),
      window: kMax,
      note: 'rebuild_overhead is excess cache_creation over the steady-state rate, summed across the window',
    };
  })();

  return {
    span: {
      first: T.first, last: T.last,
      active_days: T.days, span_days: D.days.length,
      sessions: T.sessions, turns: T.turns,
      generation: D.meta.generation,
    },
    totals: {
      billed: T.billed, fresh: T.fresh, output: T.output,
      active_min: Math.round(T.active_min),
      compactions: T.compactions, segments: D.segPts.length,
    },
    rates: {
      fresh_per_min: Math.round(T.fresh_per_min),
      billed_per_turn: Math.round(T.billed_per_turn),
      mean_resident_context: Math.round(T.cache_read / (T.turns || 1)),
      billed_per_active_day: Math.round(T.billed / (T.days || 1)),
    },
    share_pct: {
      cache_replay: pct(T.cache_read, T.billed),
      cache_creation: pct(T.cache_creation, T.billed),
      input_output: pct(T.input + T.output, T.billed),
    },
    class_pct: Object.fromEntries(
      ['investigate', 'carry', 'reason', 'author', 'delegate'].map(k => [k, pct(D.classTot[k] || 0, D.actTotal)])),
    weekly: weeks.map(w => ({
      week: w.week, active_days: w.days, sessions: w.sessions, turns: w.turns,
      billed: w.billed, fresh_per_min: w.fpm, billed_per_turn: w.billed_per_turn,
    })),
    week_over_week: wow,
    top_days: sorted.slice(0, 5).map(d => ({
      date: d.date, billed: d.billed, turns: d.turns, sessions: d.sessions,
      fresh_per_min: Math.round(d.fpm),
      class_pct: Object.fromEntries(Object.entries(d.cls).map(([k, v]) =>
        [k, pct(v, Object.values(d.cls).reduce((a, b) => a + b, 0))])),
    })),
    median_active_day_billed: med,
    peak_hour_local: { hour: peakHour, billed: D.hourProfile[peakHour] },
    context_fit: { slope_billed_per_turn_per_context_token: slope, r2, n },
    compaction,
    handoff: D.handoff,
    // Where the cache_creation went, split by whether it was avoidable. `break` is the actionable
    // bucket: a prefix invalidated mid-session while it was still cached. `ttl` and `retry` are
    // deliberately carved out of it -- a write after a >=60min idle gap rewrites a prefix that had
    // already expired, and a write after a failed request rewrites one the failure never cached, so
    // counting either as avoidable overstates the lever. `growth` is carved out for the same reason
    // from the other direction: its cache_read held up, so the write is new content entering the
    // prefix rather than a prefix being discarded. `model_switch_events` counts breaks
    // where the model id changed from the previous response, which invalidates the prefix on its own.
    cache_writes: (() => {
      const b = D.brkTot;
      const tracked = b.cold_cc + b.compact_cc + b.ttl_cc + b.retry_cc + b.growth_cc + b.break_cc;
      return {
        cold: { n: b.cold_n, cc: b.cold_cc, median_cc: b.cold_median },
        compact: { n: b.compact_n, cc: b.compact_cc, median_cc: b.compact_median },
        ttl: { n: b.ttl_n, cc: b.ttl_cc, median_cc: b.ttl_median },
        retry: { n: b.retry_n, cc: b.retry_cc, median_cc: b.retry_median },
        growth: { n: b.growth_n, cc: b.growth_cc, median_cc: b.growth_median },
        break: { n: b.break_n, cc: b.break_cc, median_cc: b.break_median },
        break_pct_of_large_writes: pct(b.break_cc, tracked),
        break_pct_of_all_cache_creation: pct(b.break_cc, T.cache_creation),
        full_miss_events: b.full_n,
        model_switch_events: b.model_n,
        note: 'large writes only (cache_creation >= the hook threshold, default 20k); ordinary per-turn delta writes are excluded',
      };
    })(),
    // Delegated cost. `billed` here is a SUBSET of totals.billed, not an addition to it: a subagent
    // is billed to the same cap as the thread that spawned it. null when reading a pre-.v4 ledger.
    delegation: D.delegation && {
      agents: D.delegation.agents, sessions: D.delegation.sessions, turns: D.delegation.turns,
      billed: D.delegation.billed, pct_of_billed: pct(D.delegation.billed, T.billed),
      by_kind: Object.fromEntries(Object.entries(D.delegation.kind).map(([k, v]) => [k, { n: v.n, billed: v.billed }])),
      top_workflows: D.delegation.top_workflows.slice(0, 5),
    },
    worst_breaks: D.breakTop.slice(0, 5),
    caveats: [
      'The per-class split of cache replay is a residency heuristic; output and cache-creation attribution are exact and the replay total is exact.',
      'Never compare or sum figures across metrics generations — the legacy unsuffixed CSVs double-count ~2.1x.',
      'A turn is one assistant API response, not one user message; each tool round-trip is its own turn.',
      'Subagent cost is INSIDE every total here, not beside it; `delegation` breaks that share back out. Pre-.v4 generations never counted it at all.',
    ],
  };
}

/* ---------- render ---------- */
function renderHtml(D, outPath) {
  if (!fs.existsSync(TEMPLATE)) die(`missing template ${TEMPLATE}`);
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  // The marker must appear EXACTLY once. replace() with a string pattern substitutes only the
  // first occurrence, so a second copy anywhere above the real one (a comment mentioning it, say)
  // silently swallows the payload and leaves `const DATA = /*__DATA__*/;` inert -- which renders a
  // structurally perfect but completely empty dashboard, with no error at build or load time.
  const marker = '/*__DATA__*/';
  const hits = tpl.split(marker).length - 1;
  if (hits === 0) die(`template lost its ${marker} marker`);
  if (hits > 1) die(`template has ${hits} copies of ${marker}; exactly one is required ` +
    `(only the first is substituted, so the others would leave the page dataless)`);
  const html = tpl.replace(marker, () => JSON.stringify(D));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  return outPath;
}

const fmt = n => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
};

function printText(s, out) {
  const L = [];
  L.push(`span        ${s.span.first} → ${s.span.last} · ${s.span.active_days} active days of ${s.span.span_days} · generation ${s.span.generation}`);
  L.push(`volume      ${fmt(s.totals.billed)} billed · ${fmt(s.totals.fresh)} fresh · ${s.span.turns} responses · ${s.span.sessions} sessions`);
  L.push(`rates       ${s.rates.fresh_per_min}/min fresh · ${fmt(s.rates.billed_per_turn)} billed per response · ${fmt(s.rates.mean_resident_context)} mean resident context`);
  L.push(`mix         replay ${s.share_pct.cache_replay}% · creation ${s.share_pct.cache_creation}% · in+out ${s.share_pct.input_output}%`);
  L.push(`activity    ${Object.entries(s.class_pct).map(([k, v]) => `${k} ${v}%`).join(' · ')}`);
  L.push('weekly      week        days  sessions  turns   billed   fresh/min  billed/turn');
  for (const w of s.weekly) {
    L.push(`            ${w.week}  ${String(w.active_days).padStart(4)}  ${String(w.sessions).padStart(8)}  ${String(w.turns).padStart(5)}  ${fmt(w.billed).padStart(7)}  ${String(w.fresh_per_min).padStart(9)}  ${fmt(w.billed_per_turn).padStart(11)}`);
  }
  if (s.week_over_week) {
    const w = s.week_over_week;
    L.push(`week/week   billed ${w.billed_pct}% · fresh/min ${w.fresh_per_min_pct}% · turns ${w.turns_pct}% (${w.previous_week} → ${w.current_week}; latest week may be partial)`);
  }
  L.push(`top days    ${s.top_days.map(d => `${d.date} ${fmt(d.billed)}`).join(' · ')}`);
  L.push(`median day  ${fmt(s.median_active_day_billed)} · peak hour ${String(s.peak_hour_local.hour).padStart(2, '0')}:00 (${fmt(s.peak_hour_local.billed)})`);
  if (s.context_fit.slope_billed_per_turn_per_context_token !== null) {
    L.push(`context fit billed/response ≈ ${s.context_fit.slope_billed_per_turn_per_context_token} x peak context (R² ${s.context_fit.r2}, n=${s.context_fit.n} segments)`);
  }
  if (s.compaction) {
    const c = s.compaction;
    L.push(`compaction  fired at ${fmt(c.fired_at_median)} median (min ${fmt(c.fired_at_min)}) · lands on ${fmt(c.floor_median)} · regrows ${c.growth_per_response}/response`);
    L.push(`            rebuild costs ${fmt(c.rebuild_overhead)} one-shot over ${c.window} responses · n=${c.compactions} compactions`);
  }
  if (s.handoff && (s.handoff.n || s.handoff.cold_n)) {
    const h = s.handoff;
    const vs = s.compaction ? ` vs compaction ${fmt(s.compaction.floor_median)}` : '';
    if (!h.n) {
      // Primary case on a fresh ledger: no handoff note has been pasted yet. Say so plainly and
      // still surface the one number that already exists — the cold /clear floor — rather than
      // omitting the line, and rather than calling fmt() on the null floor_median/n=0 seeded side.
      L.push(`handoff     no handoff-seeded sessions yet · cold /clear floor ${fmt(h.cold_floor_median)} · n=${h.cold_n} cold`);
    } else if (!h.cold_n) {
      // Mirror case: every floor-bearing session so far is handoff-seeded. cold_floor_median is
      // null here, so it must not reach fmt() (Math.round(null) === 0 would print a fake "0").
      L.push(`handoff     lands on ${fmt(h.floor_median)}${vs} · no cold /clear sessions yet · n=${h.n} seeded`);
    } else {
      L.push(`handoff     lands on ${fmt(h.floor_median)}${vs} · cold /clear ${fmt(h.cold_floor_median)} · n=${h.n} seeded, ${h.cold_n} cold`);
    }
  }
  if (s.cache_writes && s.cache_writes.break.n + s.cache_writes.cold.n + s.cache_writes.compact.n + s.cache_writes.ttl.n + s.cache_writes.retry.n + s.cache_writes.growth.n) {
    const w = s.cache_writes;
    L.push(`cache writes cold ${fmt(w.cold.cc)} (n=${w.cold.n}, median ${fmt(w.cold.median_cc)}) · rebuild ${fmt(w.compact.cc)} (n=${w.compact.n}, median ${fmt(w.compact.median_cc)}) · ttl ${fmt(w.ttl.cc)} (n=${w.ttl.n}, median ${fmt(w.ttl.median_cc)}) · retry ${fmt(w.retry.cc)} (n=${w.retry.n}, median ${fmt(w.retry.median_cc)}) · growth ${fmt(w.growth.cc)} (n=${w.growth.n}, median ${fmt(w.growth.median_cc)}) · break ${fmt(w.break.cc)} (n=${w.break.n}, median ${fmt(w.break.median_cc)})`);
    L.push(`            avoidable breaks are ${w.break_pct_of_large_writes}% of large writes, ${w.break_pct_of_all_cache_creation}% of all cache creation · ${w.full_miss_events} total misses · ${w.model_switch_events} after a model switch`);
  }
  if (s.delegation) {
    const g = s.delegation;
    const k = g.by_kind;
    L.push(`delegated   ${fmt(g.billed)} (${g.pct_of_billed}% of billed) · ${g.agents} subagent runs over ${g.sessions} sessions · ${fmt(g.turns)} responses`);
    L.push(`            agent spawns ${fmt((k.agent||{}).billed||0)} (n=${(k.agent||{}).n||0}) · workflow agents ${fmt((k.workflow||{}).billed||0)} (n=${(k.workflow||{}).n||0})`);
    if (g.top_workflows.length) L.push(`            heaviest workflow ${g.top_workflows[0].workflow} ${fmt(g.top_workflows[0].billed)} over ${g.top_workflows[0].agents} agents (${g.top_workflows[0].date})`);
  }
  if (out) L.push(`dashboard   ${out}`);
  process.stdout.write(L.join('\n') + '\n');
}

/* ---------- main ---------- */
const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, '') + '\n');
  process.exit(0);
}
for (const k of ['since', 'until']) if (opts[k] && !isDate(opts[k])) die(`--${k} must be YYYY-MM-DD`);
if (opts.since && opts.until && opts.since > opts.until) die('--since is after --until');

const data = build(opts);
const summary = summarize(data);
let outPath = null;
if (opts.html) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const stem = `token-dashboard${data.meta.suffix.replace(/\./g, '-')}`;
  outPath = path.resolve(opts.out || path.join(projectDir, 'docs', `${stem}.html`));
  renderHtml(data, outPath);
}
if (opts.json) process.stdout.write(JSON.stringify({ ...summary, dashboard: outPath }, null, 2) + '\n');
else printText(summary, outPath);
