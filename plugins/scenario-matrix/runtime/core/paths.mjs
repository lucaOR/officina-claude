// The one place the harness works out where it is on disk. Every path is
// derived from this file's own location, so a clone runs wherever it sits, and
// a move of the harness needs one edit here rather than one per module.
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const SCENARIOS = join(REPO, '.claude/scenarios');
export const LIB = join(SCENARIOS, '_lib');
export const INFRA = join(SCENARIOS, '_infra');
export const SCRIPTS = join(SCENARIOS, '_scripts');
export const ARTIFACTS = join(SCENARIOS, '_artifacts');

// True when node was started on the module at `url` (`node <that file> ...`), so a CLI module runs
// its command only then. Both sides are compared as real paths: a relative or symlinked invocation
// still matches, and a project script whose name merely ends the same way (my-run.mjs) never does.
export function isMain(url) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
