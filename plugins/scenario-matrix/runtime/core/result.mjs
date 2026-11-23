// The exit-code contract and NDJSON result record every compiled scenario
// script shares. See scenario.mjs for the lifecycle wrapper that produces
// these results.
// 5 is appended rather than slotted in: these codes are the shell contract the
// batch driver and any hand-run `node A-13.mjs; echo $?` depend on, so
// renumbering an existing outcome would silently change what a green run means.
import { config } from './config.mjs';

export const EXIT = Object.freeze({ OK: 0, KO: 1, INCONCLUSIVE: 2, STALE: 3, BLOCKED: 4, SKIPPED: 5 });

export function exitCodeFor(result) {
  if (!(result in EXIT)) throw new Error(`unknown result: ${result}`);
  return EXIT[result];
}

export function buildResult({ id, result, why, evidence, ms, attempts }) {
  const out = { id, result, ms };
  if (why) out.why = why;
  if (evidence) out.evidence = evidence;
  // Only when a retry actually happened (see scenario.mjs's opt-in `retries:`
  // field) — omitted for every row that never declares one, so this stays
  // invisible to the hundreds of existing NDJSON lines that never retry.
  // Load-bearing for triage: without it, a row that needed 2 attempts to pass
  // reads byte-for-byte identical to one that passed clean on the first try,
  // which is exactly the signal a retry policy risks hiding.
  if (attempts > 1) out.attempts = attempts;
  return out;
}

export function ndjson(result) {
  return JSON.stringify(result);
}

export function evidenceDir(epic, id, date) {
  return `${config().runsDir}/${epic}/${date}/${id}`;
}

export function emit(result) {
  process.stdout.write(`${ndjson(result)}\n`);
}
