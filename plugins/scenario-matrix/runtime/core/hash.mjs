// compiled_from: a short sha256 over the BEHAVIOURAL fields of a scenario row.
// status/last_run/bug_ref/provenance/script are excluded — stamping a run must
// not invalidate every compiled script. `priority` is excluded too: it ranks
// run order, not behaviour. `steps` is excluded as well: once a scenario is
// compiled, the script is the authority on HOW — so editing a row's `steps`
// after compiling it will NEVER mark the compiled script stale. Only a
// change to id/behaviour/reach/env/setup/expected trips the staleness gate.
import { createHash } from 'node:crypto';
import { isMain } from './paths.mjs';

const FIELDS = ['id', 'behaviour', 'reach', 'env', 'setup', 'expected'];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function compiledFrom(row) {
  const subset = Object.fromEntries(FIELDS.map(f => [f, row?.[f] ?? null]));
  return createHash('sha256').update(canonical(subset)).digest('hex').slice(0, 12);
}

// CLI entry: `node _lib/hash.mjs <epic> <id>` prints the row's compiled_from
// hash, which a compile writes into BOTH the script's header line and its
// scenario() third argument. Same guard idiom as run.mjs's own entry check.
// The registry import is dynamic and inside the guard so importing this module
// stays free of the matrix read. It is not awaited at the top level: the
// registry loads the project's hooks.mjs, a hook may import lint.mjs, and
// lint.mjs imports this module, so this module sits in an import cycle, where a
// top-level await never settles.
if (isMain(import.meta.url)) {
  const [, , epic, id] = process.argv;
  if (!epic || !id) {
    console.error('usage: hash.mjs <epic> <id>');
    process.exit(2);
  }
  // The catch covers the import itself too (a hooks.mjs that throws on load), so every failure
  // prints its message instead of an unhandled-rejection stack.
  import('./registry.mjs').then(({ loadRegistry }) => {
    console.log(compiledFrom(loadRegistry(epic).row(id)));
  }).catch(err => {
    console.error(err?.message ?? String(err));
    process.exit(2);
  });
}
