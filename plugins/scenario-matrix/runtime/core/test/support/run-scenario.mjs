// Drives the real scenario() export in-process. scenario() always ends in
// emit() + process.exit(), so both are patched on the process-global objects
// for the duration of one call and restored right after. node:test's reporter
// writes through the same process.stdout.write, so the patch forwards every
// write to the real stdout and keeps only the line that parses as JSON and
// carries this scenario's own id.
//
// Two overlapping calls would clobber each other's patches, so runScenario
// queues every call onto one promise chain instead of relying on tests running
// sequentially.
import { scenario } from '../../scenario.mjs';

class ExitSignal extends Error {}

function runScenarioOnce(id, fn, opts = {}) {
  const origExit = process.exit;
  const origWrite = process.stdout.write;
  let record, exitCode;
  process.exit = code => { exitCode = code; throw new ExitSignal(); };
  process.stdout.write = (chunk, ...rest) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.id === id) record = parsed;
      } catch { /* not our NDJSON line, e.g. interleaved reporter output */ }
    }
    return origWrite.call(process.stdout, chunk, ...rest);
  };
  return scenario(id, fn, { epic: 'probe', ...opts })
    .catch(err => { if (!(err instanceof ExitSignal)) throw err; })
    .finally(() => {
      process.exit = origExit;
      process.stdout.write = origWrite;
    })
    .then(() => ({ ...(record ?? {}), exit: exitCode }));
}

// Chained rather than awaited by each caller, and reset to a resolved promise
// after every link, so one test's rejection never wedges the tests queued after it.
let queue = Promise.resolve();

export function runScenario(id, fn, opts = {}) {
  const attempt = () => runScenarioOnce(id, fn, opts);
  const outcome = queue.then(attempt, attempt);
  queue = outcome.then(() => {}, () => {});
  return outcome;
}
