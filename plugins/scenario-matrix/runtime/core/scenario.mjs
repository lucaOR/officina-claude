// The wrapper every compiled script runs inside. Owns: staleness gate, reset,
// timing, evidence-on-KO, an opt-in per-row KO retry, and the exit contract.
// A script body never calls process.exit itself.
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildResult, emit, evidenceDir, exitCodeFor } from './result.mjs';
import { loadRegistry } from './registry.mjs';
import { markLogSlice, captureLogs } from './observe.mjs';
import { Ko, Blocked, Inconclusive } from './errors.mjs';
import { hook, contributions } from './ext.mjs';

// Re-exported so scenario.mjs stays the one place a script (or a test) has to
// know about for the outcome classes; errors.mjs's header documents which
// class a lever should throw when.
export { Ko, Blocked, Inconclusive };

export const fail = why => { throw new Ko(why); };
export const blocked = why => { throw new Blocked(why); };
export const inconclusive = why => { throw new Inconclusive(why); };

export function epicFromScript(metaUrl) {
  // _scripts/<epic>/<id>.mjs — the epic is the parent directory name, so a
  // script never hardcodes it.
  return basename(dirname(fileURLToPath(metaUrl)));
}

// The default below is the reason every environment-reaching lever types what
// it throws (see errors.mjs): an untyped Error out of a lever is reported as a
// product bug. It stays KO rather than becoming something softer, because the
// alternative — defaulting to BLOCKED — would let a genuine unexpected failure
// in a script body disappear out of the KO count.
function classify(err) {
  if (err instanceof Ko) return 'KO';
  if (err instanceof Blocked) return 'BLOCKED';
  if (err instanceof Inconclusive) return 'INCONCLUSIVE';
  return 'KO'; // an unexpected throw is a failure, never a silent pass
}

// A private marker distinct from Ko/Blocked/Inconclusive: the staleness
// gate below throws it so the STALE path rejoins the same single
// classify -> evidence -> cleanups -> emit -> exit pipeline as every other
// outcome, instead of short-circuiting around cleanups the way an inline
// emit+exit would.
class Stale extends Error {}

async function checkStale(compiledFrom, reg, id) {
  // hash.mjs is loaded lazily, and only when a compiled script
  // actually carries a compiled_from stamp to check — an uncompiled
  // scenario() call (e.g. in tests) never touches it.
  if (!compiledFrom) return;
  const { compiledFrom: hashOf } = await import('./hash.mjs');
  const expected = hashOf(reg.row(id));
  if (compiledFrom === expected) return;
  throw new Stale(`compiled_from ${compiledFrom} != ${expected} — recompile`);
}

// The same private-marker pattern as Stale, and for the same reason: the
// SKIPPED path rejoins the single classify -> evidence -> cleanups -> emit ->
// exit pipeline instead of short-circuiting around cleanups.
class Skipped extends Error {}

// The project's requirementGate hook decides whether this environment can run
// a row that declares `requires`. A string is the reason to skip it, null runs
// it. A row with no `requires` returns before the hook is looked up, which is
// load-bearing twice over: a row that declares nothing must not need a gate,
// and every scenario unit test drives a stub registry that knows nothing else.
// A row that declares `requires` while the project has no gate is BLOCKED
// rather than silently run, because nothing could have checked it.
async function checkRequires(reg, id, ctx) {
  const row = reg.row(id);
  if (!(row.requires ?? []).length) return;
  const gate = hook('requirementGate');
  if (!gate) throw new Blocked(`row ${id} declares requires but hooks.mjs defines no requirementGate`);
  const why = await gate(row, reg, ctx);
  if (why) throw new Skipped(why);
}

// Runs fn and swallows whatever it throws or rejects with, always
// resolving to null on failure. `try/catch` (rather than `fn().catch(...)`)
// is required here: fn may be an ordinary synchronous function that
// returns a non-thenable (e.g. undefined, or a plain string) — calling
// `.catch` on that value throws a TypeError, which is the exact defect
// this wraps away. `await` on a non-promise value just resolves to that
// value, so this handles sync and async callers identically.
async function safe(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// Runs the cleanups pushed onto ctx.cleanups since index `from`, in reverse
// registration order, and returns the new high-water mark. Slicing by mark
// like this — rather than mutating ctx.cleanups, and rather than always
// running the whole array — is what lets a retry (the loop in scenario()
// below) restore each attempt's own state (closing that attempt's browser,
// restoring a SIGKILLed queue worker) BEFORE the next attempt starts, while
// every cleanup still runs exactly once: a later drain only sees what was
// registered after the mark it was handed. ctx.cleanups itself is never
// mutated, so a script or test that inspects it after scenario() returns
// still sees everything that was ever pushed, in registration order — only
// the running of them is sliced by attempt, not the record of what was
// registered. Each cleanup runs through safe() individually so one throwing
// cleanup can never stop the rest from running or change the verdict.
async function drainCleanupsFrom(ctx, from) {
  const pending = ctx.cleanups.slice(from).reverse();
  for (const cleanup of pending) await safe(cleanup);
  return ctx.cleanups.length;
}

export async function scenario(id, fn, deps = {}) {
  const {
    metaUrl,
    compiledFrom,
    reset = async () => {},
    captureEvidence = async () => null,
    // Same TEST SEAM convention as onCtx below: no compiled script passes it.
    captureServerLogs = captureLogs,
    today = () => new Date().toISOString().slice(0, 10),
    registry = loadRegistry,
    // TEST SEAM, not a runtime feature: no compiled script passes this. It
    // lets a unit test seed ctx (e.g. push a cleanup) before checkStale/
    // checkRequires/reset/fn run, which is otherwise unreachable from outside
    // — the gate below can reject a row before reset() or fn() ever see ctx.
    onCtx = () => {},
  } = deps;

  const epic = deps.epic ?? epicFromScript(metaUrl);
  const started = performance.now(); // monotonic: Date.now() can step backwards when WSL2 resyncs its clock
  const ctx = { epic, id, page: null, browser: null, cleanups: [] };

  let result = 'OK';
  let why;
  let evidence = null;
  let maxAttempts = 1;
  let retryDelayMs = 0;
  let attempt = 0;
  let cleanupMark = 0;
  let reg = null;

  try {
    // Inside the try, not before it: a throwing onCtx must be classified
    // like every other unexpected throw (KO by default), not crash the
    // process uncaught the way calling it ahead of the pipeline would.
    onCtx(ctx);
    reg = registry(epic);
    await checkStale(compiledFrom, reg, id);
    await checkRequires(reg, id, ctx);

    // Retries are opt-in per row (`retries: N` in the yaml; every row that
    // omits it keeps today's single-attempt behaviour exactly). Read once
    // here, from the same row the gate above already loaded — not re-read on
    // every attempt below. A malformed value is INCONCLUSIVE, not KO: per
    // errors.mjs, that class means "the scenario author asked for something
    // the library cannot honour" — the row itself is broken, so the product
    // was never reached and never misbehaved.
    const retriesRaw = reg.row(id).retries ?? 0;
    const retries = Number(retriesRaw);
    if (!Number.isInteger(retries) || retries < 0) {
      throw new Inconclusive(`row ${id} declares retries: ${JSON.stringify(retriesRaw)}, `
        + 'expected a non-negative integer');
    }
    maxAttempts = 1 + retries;

    const delayRaw = reg.row(id).retry_delay_ms ?? 0;
    retryDelayMs = Number(delayRaw);
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
      throw new Inconclusive(`row ${id} declares retry_delay_ms: ${JSON.stringify(delayRaw)}, `
        + 'expected a non-negative number');
    }
  } catch (err) {
    result = err instanceof Stale ? 'STALE' : err instanceof Skipped ? 'SKIPPED' : classify(err);
    // `throw 'boom'` is legal JS and `err.message` on it is undefined, which
    // buildResult() then drops — producing a KO with no explanation at all.
    // String(err) is the last resort that keeps every failure explained.
    why = err?.message ?? String(err);
    maxAttempts = 0; // the gate itself failed -- reset()/fn() never run at all
  }

  // Retries apply to KO and BLOCKED, never INCONCLUSIVE. INCONCLUSIVE means
  // "the scenario author asked for something the library cannot honour" (a
  // missing lever, a bad recipe parameter) -- a pure authoring defect that no
  // number of attempts can ever change, so retrying it is waste with zero
  // chance of converging. BLOCKED nominally means "the environment could not
  // honour the call", which sounds equally durable, but in practice its
  // single most common source is assertMarker() (login.mjs) timing out on the
  // post-login dashboard marker -- a real timing race, not an outage, and
  // exactly the kind of flake a fresh reset+relogin on the next attempt can
  // clear (rows are seen going BLOCKED on one replay and OK on the next). A
  // service that is genuinely down will still report BLOCKED on
  // every attempt and exhaust maxAttempts same as it would have with one --
  // the wasted attempts cost a few seconds, not correctness.

  for (let a = 1; a <= maxAttempts; a++) {
    attempt = a;
    // Cleared at the top of every attempt, not only the first: a retry must
    // not see a previous attempt's already-closed browser/page.
    ctx.page = null;
    ctx.browser = null;
    try {
      // Before reset(), not after: a stdout log source is sliced by time, and
      // reset() itself can make a service log. Each adapter's beforeAttempt
      // then runs ahead of reset, so a throw from either is classified alike.
      markLogSlice();
      for (const { fn: before } of contributions('beforeAttempt')) await before(ctx);
      await reset(ctx);
      await fn(ctx);
      result = 'OK';
      why = undefined;
    } catch (err) {
      result = classify(err);
      why = err?.message ?? String(err);
    }

    // Evidence must be captured while THIS attempt's browser/page context is
    // still alive, so this happens before this attempt's cleanups run below.
    // Each capture overwrites the last, so whatever is on disk once the loop
    // ends is always the LAST attempt that failed — never an earlier
    // failure's evidence left behind to be mistaken for why a scenario that
    // went on to pass (or to fail differently) actually did so. A final
    // passing attempt leaves no evidence at all (see below), even if an
    // earlier attempt in the same run captured some.
    //
    // BLOCKED as well as KO: assertMarker() (login.mjs) throws Blocked, and it
    // is the gate every browser scenario passes through, so a failed login —
    // the single most common browser failure — is a BLOCKED. A screenshot is
    // exactly what diagnoses it (which screen did the login actually land on),
    // and capturing only on KO left that case with an empty evidence
    // directory. INCONCLUSIVE, STALE, and SKIPPED get none: none of the three
    // reached the environment in a state worth photographing.
    const failing = result === 'KO' || result === 'BLOCKED';
    evidence = failing
      ? await safe(() => captureEvidence(ctx, evidenceDir(epic, id, today())))
      : null;
    // Every service's log slice beside the script's own evidence, without a
    // compiled script having to ask for it, then whatever each adapter adds.
    // Same failing-only rule and the same overwrite-per-attempt semantics as
    // the screenshot above. Each has its own safe(): a capture that fails must
    // never cost the screenshot, another capture or the verdict.
    if (failing && reg) {
      const dir = evidenceDir(epic, id, today());
      await safe(() => captureServerLogs(reg, dir));
      for (const { fn: capture } of contributions('evidence')) await safe(() => capture(reg, dir));
    }

    // This attempt's own cleanups — restoring whatever it faulted or opened
    // (a queue worker, a browser) BEFORE the next attempt gets a turn, rather
    // than leaving them stranded until the whole scenario ends, which would
    // make attempt 2 start from attempt 1's leftover state instead of a
    // clean one.
    cleanupMark = await drainCleanupsFrom(ctx, cleanupMark);

    if ((result !== 'KO' && result !== 'BLOCKED') || attempt === maxAttempts) break;
    if (retryDelayMs) await new Promise(r => setTimeout(r, retryDelayMs * attempt));
  }

  // Drains whatever the loop above didn't: an onCtx-registered cleanup when
  // the gate itself rejected the row before the loop ever ran (maxAttempts
  // is 0 in that case), or nothing at all on every ordinary path, since the
  // loop already drained up to cleanupMark itself. Runs on every exit path
  // (OK, KO, BLOCKED, INCONCLUSIVE, STALE, SKIPPED), after evidence capture
  // and before the result line is emitted, so nothing a cleanup prints can
  // land after the NDJSON line the batch driver parses as the last line of
  // stdout.
  await drainCleanupsFrom(ctx, cleanupMark);

  emit(buildResult({ id, result, why, evidence, ms: Math.round(performance.now() - started), attempts: attempt }));
  process.exit(exitCodeFor(result));
}
