// The sql adapter's contribution module: the `db` registry key and its `dbTarget` accessor, and the
// lint rules that keep a scenario inside the scenario databases. It holds no dialect: a dialect
// adapter requires this one and provides the `sql.<dialect>` driver that `db.mjs` dispatches to.
import { Blocked } from './errors.mjs';
import { adapterConfig, config } from './config.mjs';
import { parseDbEntry } from './db.mjs';

export const name = 'sql';

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- registry: db ---

function entryProblem(db, entry) {
  if (typeof entry === 'string') {
    return entry.trim().split(/\s+/).length >= 2 ? null : `${db} must be "<container> <client...>" (got ${JSON.stringify(entry)})`;
  }
  if (!isMapping(entry)) return `${db} must be a "<container> <client...>" string or a mapping with container and client`;
  if (typeof entry.container !== 'string' || entry.container === '') return `${db}.container must be a non-empty container name`;
  const client = entry.client;
  if (!(typeof client === 'string' && client.trim() !== '') && !(Array.isArray(client) && client.length > 0)) {
    return `${db}.client must be a client command (a string or a list of arguments)`;
  }
  if (entry.dialect !== undefined && (typeof entry.dialect !== 'string' || entry.dialect === '')) {
    return `${db}.dialect must be a non-empty dialect name`;
  }
  return null;
}

const containerOf = entry => (isMapping(entry) ? entry.container : String(entry ?? '').trim().split(/\s+/)[0]);

export const registry = {
  keys: {
    db: {
      validate(value) {
        if (!isMapping(value)) return 'must be a mapping of database name to its container and client';
        for (const [db, entry] of Object.entries(value)) {
          const problem = entryProblem(db, entry);
          if (problem) return problem;
        }
        return null;
      },
    },
  },
  accessors: raw => ({
    dbTarget(db) {
      const entry = raw.db?.[db];
      if (!entry) throw new Blocked(`unknown db target: ${db}`);
      return parseDbEntry(db, entry);
    },
  }),
  // The containers the `db` entries name, for the fault perimeter other adapters check.
  containers: raw => Object.values(raw?.db ?? {}).map(containerOf).filter(c => typeof c === 'string' && c !== ''),
};

// --- lint ---

// The ambient-database rule. A database named inside the SQL reaches the developer's real data, and
// the target-argument guard cannot see it. The prefixes come from the adapter config and the match is
// case-sensitive on purpose: every database name is lowercase, whereas a SCREAMING_SNAKE constant that
// merely begins with the same word is not a database. Comments count, because naming it has leaked it.
const ambientDb = {
  id: 'ambient-db', kind: 'source',
  check(source) {
    const prefixes = adapterConfig('sql').ambientDbPrefixes ?? ['local'];
    if (prefixes.length === 0) return [];
    const re = new RegExp(`\\b(?:${prefixes.map(escapeRe).join('|')})_[a-z0-9_]+`);
    const msg = `ambient database name — a scenario reaches ${config().dbPrefix}* databases only, through sql()/one()/scalar()`;
    return source.split('\n').flatMap((line, i) => (re.test(line) ? [`${i + 1}: ${msg}`] : []));
  },
};

// Heuristic, not a position check: it compares the TOTAL count of prefixed string literals in the
// source against the count that appear as a sql()/one()/scalar()/schemaFreeze() target argument, and
// flags a positive difference. It catches a stray 'scn_...' literal built into something that is not
// a target, but it works on raw source text with no awareness of comments, so treat a hit as "go
// look", not as a precise diagnosis.
const prefixLiteral = {
  id: 'prefix-literal', kind: 'source',
  check(source) {
    const prefix = config().dbPrefix;
    const literal = escapeRe(prefix);
    const literals = [...source.matchAll(new RegExp(`['"]${literal}[a-z]+['"]`, 'g'))];
    const targets = [...source.matchAll(new RegExp(`\\b(?:sql|one|scalar|schemaFreeze)\\([^,]+,\\s*['"]${literal}[a-z]+['"]`, 'g'))];
    return literals.length > targets.length
      ? [`${literals.length - targets.length} ${prefix} literal(s) outside a sql() target argument`]
      : [];
  },
};

export const lint = [ambientDb, prefixLiteral];
