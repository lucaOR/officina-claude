#!/usr/bin/env node
// Batch driver. Owns what is genuinely per-run: the lock, provisioning,
// sequencing, aggregation, teardown. Per-scenario reset/cleanup lives in the
// scripts themselves, so solo and batch runs execute identical code.
// Everything that touches the stack goes through the project's lifecycle hooks
// (hooks.mjs `lifecycle.*`), each with a neutral default built on config().
import { spawnSync as realSpawnSync } from 'node:child_process';
import { existsSync, mkdirSync as realMkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { loadRegistry as realLoadRegistry } from './registry.mjs';
import { compiledFrom } from './hash.mjs';
import { defaultBaseline } from './reset.mjs';
import { Blocked } from './errors.mjs';
import { hook } from './ext.mjs';
import { config, fill, repoPath } from './config.mjs';
import { REPO, SCENARIOS, SCRIPTS, isMain } from './paths.mjs';

// The node already running this driver, so a child scenario cannot end up on a
// different version than the batch that spawned it.
const NODE = process.execPath;

// Keep-warm mode. Bringing a stack up from nothing is usually the dominant
// per-invocation cost. Setting the keep-warm environment variable skips the
// TEARDOWN, and a following run that finds the stack still warm skips the
// bring-up -- but never the baseline restore, which still runs every
// invocation. Skipping that would let one run's leftovers satisfy the next
// run's assertions, which is a far worse failure than the seconds it saves.
//
// Opt-in, and deliberately not the default: while the stack is warm it keeps
// serving test state until the teardown runs. The marker records that fact for
// the next invocation and for a human wondering why their stack looks wrong.
const keepWarm = () => process.env[config().lifecycle.keepWarmEnv] === '1';

// Both are defaults, not constants the callers below close over: the lock
// path and the compiled-script root are injectable specifically so the unit
// tests never touch either real one. The lock is the only thing standing
// between two drivers mutating the same stack, and a test that deletes it
// unconditionally can cut a long background run loose mid-flight; the scripts
// root is versioned space, and a killed test run would leave throwaway
// directories inside the tracked tree.
const LOCK = join(SCENARIOS, '_lib/.lock');
const SCRIPTS_ROOT = SCRIPTS;

const PER_ROW_TIMEOUT_MS = 15 * 60 * 1000;

// Stopping a run (Ctrl-C, or a killed background task) would take node's
// default signal action: the process dies on the spot, the finally in main()
// never runs, and the stack is left up with a stale lock the next run refuses
// to start past. main() traps these and turns them into a flag, so a stop ends
// the row loop and falls through the same teardown and lock release a normal
// exit takes.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'];

// Every row and every stack step runs through spawnSync, which blocks the event
// loop, and a signal handler is only dispatched from the event loop. Without an
// explicit yield the handler would not run until main() had finished every
// remaining row, which defeats the point. One setImmediate turn is enough for
// libuv to deliver a pending signal.
const yieldToSignals = () => new Promise(resolve => setImmediate(resolve));

// Shell convention for "terminated by signal N", so a caller chaining runs sees
// a stopped run as stopped rather than as a clean exit.
export function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] ?? 0);
}

// A row that produced no result line has to say WHY, because a raw
// `exit null` is the single most confusing outcome to diagnose: spawnSync's
// timeout kills with SIGTERM, so `status` is null and the only trace of the
// timeout is in `signal`. The distinction matters -- a timed-out row means
// "this scenario hangs", a spawn error means "the runner could not start it",
// and a plain non-zero exit means "it died before printing". They lead to
// three different places.
export function whyNoResultLine({ status, signal, error }, timeoutMs = PER_ROW_TIMEOUT_MS) {
  if (error) return `could not run the script: ${error.message}`;
  if (signal === 'SIGTERM' && status === null) {
    return `no result line — killed after the ${Math.round(timeoutMs / 60000)}-minute per-row timeout`;
  }
  if (signal) return `no result line — killed by ${signal}`;
  return `no result line (exit ${status})`;
}

// Accepts one selection or several, because batching families into a SINGLE
// invocation is deliberate: stack bring-up and teardown are per-run, not
// per-row, so splitting families across runs buys nothing and costs a full
// bring-up each time. Truncating several selections to the first would run one
// family and report a clean wave while the others never executed, which is the
// worst possible failure for a gate.
export function selectRows(rows, selection) {
  const selections = (Array.isArray(selection) ? selection : [selection]).filter(Boolean);
  if (selections.length === 0) return rows;
  const chosen = new Set();
  for (const sel of selections) {
    const exact = rows.filter(r => r.id === sel);
    const family = rows.filter(r => r.id.startsWith(`${sel}-`));
    const picked = exact.length > 0 ? exact : family;
    if (picked.length === 0) throw new Error(`selection ${sel} matches no scenario`);
    for (const r of picked) chosen.add(r.id);
  }
  // Registry order, not the order the selections were typed: run order is a
  // property of the matrix, and two operators passing the same families in a
  // different order must get the same sequence. Dedupes overlapping
  // selections (`E E-06`) for free.
  return rows.filter(r => chosen.has(r.id));
}

export function scriptState(currentHash, exists, headerHash) {
  if (!exists) return 'uncompiled';
  return headerHash === currentHash ? 'fresh' : 'stale';
}

export function lastJsonLine(stdout) {
  const lines = String(stdout).trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); } catch { continue; } // human output, keep walking up
    // JSON.parse happily accepts a bare scalar (42, null, "done") or an
    // array, none of which is ever this script's own result line -- only an
    // object carrying a `result` property is, so anything else keeps the
    // walk going upward instead of being mistaken for the result.
    if (parsed && typeof parsed === 'object' && 'result' in parsed) return parsed;
  }
  return null;
}

// `extras` is what the project's summaryExtras hook returned; its truthy values
// are copied into the summary.
export function summarize(results, extras = {}) {
  const key = {
    OK: 'ok', KO: 'ko', INCONCLUSIVE: 'inconclusive',
    STALE: 'stale', BLOCKED: 'blocked', SKIPPED: 'skipped',
  };
  const s = { ok: 0, ko: 0, inconclusive: 0, stale: 0, blocked: 0, skipped: 0, total: results.length };
  const skippedIds = [];
  for (const r of results) {
    const k = key[r.result];
    // An unrecognized result must fail loudly here rather than silently
    // corrupt the summary: s[key[r.result]] += 1 with an unmapped result
    // evaluates s[undefined] + 1 (NaN) and then writes an `undefined` key
    // onto s -- a script that prints an off-contract result would otherwise
    // pass through as a wrong number nobody notices.
    if (!k) throw new Error(`summarize(): unrecognized result ${JSON.stringify(r.result)} (id: ${r.id ?? '?'})`);
    s[k] += 1;
    if (k === 'skipped') skippedIds.push(r.id);
  }
  // The ids, not just the count: a variant that skips rows has NARROWER
  // coverage than one that does not, and a bare number in the summary reads as
  // equivalent. Same "no silent caps" rule the rest of the harness follows.
  s.skipped_ids = skippedIds;
  for (const [k, v] of Object.entries(extras ?? {})) if (v) s[k] = v;
  return s;
}

// A driver killed hard (SIGKILL, a closed terminal, a crashed session) never
// reaches the finally that releases the lock, and every later run would then
// refuse to start until a human deleted the file. A lock whose pid no longer
// exists is reclaimed once, here. A live pid, or a lock that can't be parsed
// (another driver between openSync and its write), still refuses: deleting a
// live lock would let two drivers interleave on the same stack.
function holderIsDead(lockPath) {
  let pid;
  try { pid = JSON.parse(readFileSync(lockPath, 'utf8')).pid; } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
}

export function takeLock(epic, lockPath = LOCK, { reclaimed = false } = {}) {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, epic }));
    closeSync(fd);
    return () => { try { unlinkSync(lockPath); } catch { /* best effort */ } };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const held = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '?';
    if (!reclaimed && holderIsDead(lockPath)) {
      console.error(`reclaiming stale lock ${lockPath}: holder ${held} is no longer running`);
      try { unlinkSync(lockPath); } catch { /* another driver got there first; retry decides */ }
      return takeLock(epic, lockPath, { reclaimed: true });
    }
    throw new Error(`another run holds the scn stack: ${held} (remove ${lockPath} if that pid is dead)`);
  }
}

// Runs from the project root, because config commands are relative to it.
function defaultBash(cmd, { check = true } = {}) {
  const r = realSpawnSync('bash', ['-c', cmd], { stdio: 'inherit', cwd: REPO });
  if (check && r.status !== 0) throw new Error(`command failed (${r.status}): ${cmd}`);
  return r.status;
}

function headerHashOf(path) {
  if (!existsSync(path)) return null;
  const m = /\/\/ scenario: \S+ compiled_from: (\S+)/.exec(readFileSync(path, 'utf8'));
  return m ? m[1] : null;
}

function plan(reg, rows, scriptsRoot) {
  const out = { fresh: [], stale: [], uncompiled: [] };
  for (const row of rows) {
    const path = join(scriptsRoot, reg.epic, `${row.id}.mjs`);
    out[scriptState(compiledFrom(row), existsSync(path), headerHashOf(path))].push(row.id);
  }
  return out;
}

// deps is the testing seam: `bash` and `spawnSync` are the two things that
// reach outside this process -- the shell runner behind the default lifecycle
// commands, and the process spawner that runs each compiled script. Both
// default to the real implementations for actual CLI use; a test supplies
// fakes so a batch run never touches a live stack while still exercising the
// real per-row execution and aggregation logic. `loadRegistry` is the same
// injectable seam scenario.mjs uses, so a test never needs a real registry on
// disk. `mkdirSync` is injectable purely so a test can prove the lock still
// gets released when the run directory can't be created. `lock`, `scriptsRoot`
// and `warmMarker` are injectable for a different reason: they are the paths a
// test would otherwise share with a live run, and none is safe to share.
// Deleting the real lock mid-run lets a second driver start against the same
// stack, and a developer with a genuinely warm stack would flip the tests onto
// the warm path.
export async function main(argv = process.argv, deps = {}) {
  const {
    bash = defaultBash,
    warmMarker = repoPath(config().lifecycle.warmMarker),
    spawnSync: spawn = realSpawnSync,
    loadRegistry: loadReg = realLoadRegistry,
    mkdirSync = realMkdirSync,
    lock = LOCK,
    scriptsRoot = SCRIPTS_ROOT,
    // Where the stop handlers are installed. A test passes its own
    // EventEmitter and emits on it, so it never signals the test runner.
    signals = process,
  } = deps;

  const [, , epic, ...rest] = argv;
  if (!epic) { console.error('usage: run.mjs <epic> [selection...] [--plan]'); process.exit(64); }

  // Unknown flags are REJECTED, never ignored. `selection` below filters out
  // anything starting with `--`, so without this guard a typo -- or a
  // plausible flag this driver simply does not have, like `--list` -- would
  // silently become "no selection", which means the WHOLE epic, on the
  // destructive path.
  //
  // Rejecting rather than defaulting to `--plan` is the deliberate choice.
  // Treating an unknown flag as plan-only would be safe for this one typo and
  // wrong in general, because it makes a typo change what the command DOES
  // rather than making it fail -- the worse cure, and one that hides the typo
  // instead of naming it. Placed before takeLock and before anything that can
  // reach the stack, so a rejected invocation cannot have touched the lock,
  // the registry or a container.
  const KNOWN_FLAGS = new Set(['--plan']);
  const unknown = rest.filter(a => a.startsWith('--') && !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    console.error(`run.mjs: unknown flag(s) ${unknown.join(' ')} — known: ${[...KNOWN_FLAGS].join(' ')}`);
    console.error('usage: run.mjs <epic> [selection...] [--plan]');
    process.exit(64);
  }

  const planOnly = rest.includes('--plan');
  const selection = rest.filter(a => !a.startsWith('--'));
  // results.json records what was asked for, not what matched, so a wave's
  // evidence file says which families it covered. An empty selection means the
  // whole epic.
  const selectionLabel = selection.length > 0 ? selection.join(' ') : 'all';
  const reg = loadReg(epic);
  const rows = selectRows(reg.rows, selection);

  if (planOnly) {
    const p = plan(reg, rows, scriptsRoot);
    console.log(`fresh ${p.fresh.length} · stale ${p.stale.length} · uncompiled ${p.uncompiled.length}`);
    for (const k of ['stale', 'uncompiled']) if (p[k].length) console.log(`${k}: ${p[k].join(' ')}`);
    process.exit(0);
  }

  // The project's lifecycle hooks (signatures in hooks.mjs), each with a
  // neutral default used when hooks.mjs defines no such function.
  const lc = config().lifecycle;
  const isWarm = hook('lifecycle.isWarm', async () => existsSync(warmMarker));
  const warmUp = hook('lifecycle.warmUp', async ({ reg: r }) => hook('reset.baseline', defaultBaseline)({ reg: r }));
  const bringUp = hook('lifecycle.bringUp', async () => {
    if (lc.up == null) return { ok: true };
    const status = bash(lc.up, { check: false });
    // A signal-killed command has status null, which must not match an unset refusedExit.
    if (lc.refusedExit != null && status === lc.refusedExit) {
      return { refused: `${lc.up} refused before changing anything (its reason is printed above), so this run tore nothing down` };
    }
    if (status !== 0) throw new Error(`command failed (${status}): ${lc.up}`);
    return { ok: true };
  });
  const verifyUp = hook('lifecycle.verifyUp', async () => {});
  const runFacts = hook('lifecycle.runFacts', async () => ({}));
  const tearDown = hook('lifecycle.tearDown', async () => {
    if (lc.down) bash(lc.down, { check: false });
  });
  const summaryExtras = hook('summaryExtras', () => ({}));

  const release = takeLock(epic, lock);
  // Installed right after the lock is taken, because from here on a stop must
  // run the finally below. They stay installed through teardown and are only
  // removed once the lock is released: removing them earlier restores the
  // default action, and a second stop would then kill node mid-teardown and
  // leak the lock. The price is that a second stop during teardown does not
  // force an exit. In a terminal it still reaches the teardown's own child
  // processes, which share node's process group.
  let interrupted = null;
  const onStop = (signal) => {
    if (interrupted) { console.error(`${signal} again — teardown already in progress, waiting for it to finish`); return; }
    interrupted = signal;
    console.error(`${signal} received — stopping after the current step, then tearing down and releasing the lock`);
  };
  for (const s of STOP_SIGNALS) signals.on(s, onStop);
  const date = new Date().toISOString().slice(0, 10);
  const runDir = join(REPO, config().runsDir, epic, date);
  const resultsPath = join(runDir, 'results.json');
  // Run output (logs, dumps, evidence) may hold secrets, so the runs root
  // ignores itself: a `.gitignore` of `*`, written only when none exists, so a
  // project that wants to version runs just replaces its content. Called after
  // each run-directory creation. A failure warns once and never aborts the run
  // or skips the lock release, because the run's safety does not depend on it.
  let ignoreWarned = false;
  const keepRunsIgnored = () => {
    try {
      writeFileSync(join(REPO, config().runsDir, '.gitignore'), '*\n', { flag: 'wx' });
    } catch (err) {
      if (err?.code === 'EEXIST' || ignoreWarned) return;
      ignoreWarned = true;
      console.error(`could not write the runs .gitignore: ${err.message}`);
    }
  };
  const results = [];
  // Wall-clock accounting, written into results.json alongside the verdicts.
  // Without it the harness's own cost claims are unfalsifiable: the per-row
  // `ms` each script self-reports would be the only timing on disk, so the
  // fixed per-invocation overhead -- the number that decides whether a wave
  // batches into one run or many -- could only be eyeballed. Every field below
  // is derived, never estimated.
  const timing = { startedAt: new Date().toISOString(), bringUpMs: null, rowsMs: null, wallMs: null, overheadMs: null };
  const t0 = performance.now(); // monotonic, so no duration can come out negative
  let tRowsStart = null;
  let tRowsEnd = null;
  // Set when the bring-up is refused before anything changed. The finally below
  // then tears nothing down, because the teardown would change the very stack
  // the refusal left alone.
  let refused = null;
  let facts = {};

  try {
    // Inside the try, not between takeLock() succeeding and here: left
    // outside, a failure creating runDir (e.g. a permission error) would
    // skip the finally below entirely and leak the lock with no
    // diagnostic -- the next run then fails naming a pid that is long dead.
    mkdirSync(runDir, { recursive: true });
    keepRunsIgnored();

    // A warm stack is a CLAIM, not a fact: the marker survives a reboot or a
    // manual teardown. So the marker only decides which bring-up path to try,
    // and verifyUp below runs on BOTH paths -- a warm start that fails
    // verification stops the run rather than running rows against a half-dead
    // stack.
    if (await isWarm({ reg })) {
      console.log(`stack is warm (${lc.keepWarmEnv}) — skipping bring-up, restoring the baseline only`);
      // NOT tolerant of failure: if the baseline restore fails here, every row
      // afterwards runs against whatever the previous run left behind, and a
      // row can pass on stale state it did not create. A failed clean must
      // abort the run, not degrade it.
      await warmUp({ reg });
    } else {
      let up;
      try {
        up = await bringUp({ epic, rows, reg });
      } catch (err) {
        if (err instanceof Blocked) refused = err.message;
        throw err;
      }
      if (up?.refused) {
        refused = up.refused;
        throw new Blocked(refused);
      }
    }
    // Provisioning verification is deliberately explicit: a zero exit code is
    // not proof that the stack is usable.
    await verifyUp({ reg });

    // Bring-up ends where the first row can start: after verification, not
    // after the bring-up command returns. A stack that is up but not yet
    // verified is not ready to run a row, so counting verification as overhead
    // is what makes overheadMs mean "time no row could have used".
    tRowsStart = performance.now();

    for (const row of rows) {
      // The checkpoint sits before each row, so the first one also covers a
      // stop that arrived during bring-up. A row already running is never cut
      // short from here. In a terminal, Ctrl-C reaches it directly, because
      // the child shares node's process group. A SIGTERM sent to node alone
      // lets the row finish, bounded by PER_ROW_TIMEOUT_MS.
      await yieldToSignals();
      if (interrupted) break;
      const path = join(scriptsRoot, epic, `${row.id}.mjs`);
      const state = scriptState(compiledFrom(row), existsSync(path), headerHashOf(path));
      if (state === 'uncompiled') {
        // Printed for an operator to paste verbatim.
        console.log(`${row.id} UNCOMPILED — run: ${fill(config().compileHint, { epic, id: row.id })}`);
        results.push({ id: row.id, result: 'BLOCKED', why: 'uncompiled' });
        continue;
      }
      const r = spawn(NODE, [path], { encoding: 'utf8', timeout: PER_ROW_TIMEOUT_MS });
      process.stdout.write(r.stdout ?? '');
      const parsed = lastJsonLine(r.stdout) ?? { id: row.id, result: 'BLOCKED', why: whyNoResultLine(r) };
      console.log(`${parsed.id} ${parsed.result}${parsed.why ? ` — ${parsed.why}` : ''}`);
      results.push(parsed);
    }
    tRowsEnd = performance.now();
  } finally {
    // A Ctrl-C during bring-up kills the bring-up command, and that step's
    // failure throws straight here before the handler has had a turn to run.
    // Yielding once lets the pending signal be recorded, so results.json and
    // the log say the run was stopped rather than showing a bare "command
    // failed".
    await yieldToSignals();
    // Read for the SUMMARY only, so a failing facts hook degrades the report
    // rather than discarding a completed sweep's results. Captured HERE,
    // before the teardown below runs, because a teardown may remove the very
    // state these facts are read from.
    try { facts = (await runFacts({ reg })) ?? {}; } catch (err) { console.error(`runFacts hook failed: ${err?.message ?? err}`); facts = {}; }

    // A refused bring-up skips all of it, the warm marker included: nothing
    // was brought up, so there is nothing to keep warm or to tear down.
    if (refused) {
      console.log('bring-up refused: nothing was changed, so nothing is torn down');
    } else if (keepWarm()) {
      // Leave the stack up for the next invocation. Written INSIDE the finally
      // so it lands whether the rows passed, failed, or threw -- the stack is
      // warm either way, and a marker that only appears on success would leave
      // a live stack with nothing recording it.
      try { writeFileSync(warmMarker, `${new Date().toISOString()} pid ${process.pid}\n`); } catch { /* advisory only */ }
      console.log(`stack left UP (${lc.keepWarmEnv}=1)${lc.down ? `\n  ${lc.down}` : ''}`);
    } else {
      // Teardown is best-effort: a throw (a missing binary, a shell error)
      // must not skip releasing the lock or writing the results.
      try { await tearDown({ reg }); } catch (err) { console.error(`teardown step failed: ${err.message}`); }
      try { if (existsSync(warmMarker)) unlinkSync(warmMarker); } catch { /* advisory only */ }
    }

    // The collected results are this run's evidence, and must be durable
    // before anything below can still throw and take them down with it.
    // summarize() rejects an off-contract result on purpose
    // -- untrusted, since it comes straight from a script's own stdout --
    // and computing it BEFORE this write would let one malformed row discard
    // the whole run's results. This write is itself wrapped so a failure here
    // (e.g. the mkdirSync above having failed) still can't skip releasing the
    // lock below.
    // Computed HERE, after teardown, so wallMs covers the whole invocation the
    // operator actually waited on -- bring-up, rows and teardown -- and
    // overheadMs is everything that was not a row. tRowsStart/tRowsEnd stay
    // null when the try threw before reaching them, and a null must NOT become
    // a plausible-looking number: an overheadMs computed against a missing
    // rows window would read as a measurement when it is an artefact.
    timing.wallMs = Math.round(performance.now() - t0);
    if (tRowsStart !== null) timing.bringUpMs = Math.round(tRowsStart - t0);
    if (tRowsStart !== null && tRowsEnd !== null) {
      timing.rowsMs = Math.round(tRowsEnd - tRowsStart);
      timing.overheadMs = timing.wallMs - timing.rowsMs;
    }

    // `interrupted` names the signal that stopped the run, and `refused` the
    // reason a bring-up was refused. Without them, a stopped or refused run's
    // results.json would look like a complete one that simply selected fewer
    // rows.
    const record = (extra = {}) => JSON.stringify(
      { epic, date, selection: selectionLabel, ...(interrupted && { interrupted }), ...(refused && { refused }),
        timing, results, ...extra }, null, 2);

    try {
      mkdirSync(runDir, { recursive: true });
      keepRunsIgnored();
      writeFileSync(resultsPath, record());
    } catch (err) {
      console.error(`failed to persist results.json: ${err.message}`);
    }

    release();
    for (const s of STOP_SIGNALS) signals.off(s, onStop);

    // summarize() can still throw here, after the results are already
    // durable on disk -- so an off-contract result only costs the operator a
    // computed count, not the run's evidence, and it is still as loud as
    // summarize() means it to be: caught just long enough to make the failure
    // visible IN results.json (an absent summary key would read as "the
    // driver forgot to compute it," not "a row was off-contract"), then
    // re-thrown.
    let summary;
    try {
      let extras = {};
      try { extras = summaryExtras(facts) ?? {}; } catch (err) { console.error(`summaryExtras hook failed: ${err?.message ?? err}`); extras = {}; }
      summary = summarize(results, extras);
    } catch (err) {
      try {
        writeFileSync(resultsPath, record({ summary: { error: err.message } }));
      } catch { /* best effort -- the raw results above already survived */ }
      throw err;
    }
    try {
      writeFileSync(resultsPath, record({ summary }));
    } catch (err) {
      // Must not throw here: a throw in a finally block REPLACES whatever
      // exception is already propagating from the try above (e.g. the
      // mkdirSync failure this whole block exists to survive), silently
      // swapping a meaningful error for a confusing downstream ENOENT.
      console.error(`failed to persist results.json with summary: ${err.message}`);
    }
    console.log(JSON.stringify(summary));
  }
  // After the finally, never inside it: a return inside a finally would
  // swallow any error that is already propagating.
  return { interrupted };
}

// A Blocked raised during bring-up must read as an operator instruction, not
// an unhandled rejection's raw stack. Only Blocked is caught here: it is the
// one typed error whose whole message IS the remedy (errors.mjs's own class
// contract), so printing just err.message loses nothing. Anything else keeps
// propagating -- a Ko/Inconclusive/plain bug is a genuine failure a developer
// needs the stack for, and swallowing it would hide exactly the kind of defect
// this driver exists to catch.
if (isMain(import.meta.url)) {
  try {
    const { interrupted } = await main();
    if (interrupted) process.exitCode = signalExitCode(interrupted);
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}
