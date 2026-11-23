// The postgres adapter's contribution module: the `sql.postgres` dialect driver for the sql
// adapter's levers, the sentinel reset steps and a readiness probe. The keys of `drivers` equal the
// `drivers` array of adapter.json. There is no schemaFreeze and no rehearsal in version 1.
import { Blocked } from './errors.mjs';
import { adapterConfig, config } from './config.mjs';
import { addEnvironmentFailure, addReadyProbe } from './docker.mjs';
import { parseDbEntry, parseRows, sql } from './db.mjs';

export const name = 'postgres';

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The one client error that is a statement about the environment: the target database is absent.
// assertScnTarget() has already proved the target carries the scenario prefix, so it is the
// harness's own registry argument and "it isn't there" means the stack was never provisioned. The
// text is anchored on the prefix so a database the PRODUCT failed to create cannot launder itself
// out of KO.
addEnvironmentFailure(new RegExp(`database "${escapeRe(config().dbPrefix)}[^"]*" does not exist`, 'i'));

// --- sql.postgres ---

// `-A -F <tab>` prints a header line and tab-separated rows, which is the shape parseRows reads.
// `-t` is deliberately absent because it drops the header, `-P footer=off` removes the "(N rows)"
// line, and `-P null=NULL` prints a NULL as the word the parser maps back to null. psql escapes
// nothing, so the rows are read with `escaped: false`: a backslash in a value stays a backslash. A
// tab or newline inside a value is unsupported, because it cannot be told from a delimiter.
const sqlPostgres = {
  clients: /^psql$/,
  args: (target, text) => [
    'exec', '-i', target.container, ...target.client,
    '-X', '-A', '-F', '\t', '-P', 'footer=off', '-P', 'null=NULL',
    '-v', 'ON_ERROR_STOP=1', '-d', target.db, '-c', text,
  ],
  parse: raw => parseRows(raw, { escaped: false }),
};

export const drivers = { 'sql.postgres': sqlPostgres };

// --- ready probe ---

// The containers the registry's `db` entries name that this adapter drives, with their client args.
function postgresTargets(reg) {
  const out = new Map();
  for (const [db, entry] of Object.entries(reg?.raw?.db ?? {})) {
    try {
      const target = parseDbEntry(db, entry);
      if (target.dialect === 'postgres') out.set(target.container, target.client);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e; // an entry no dialect drives is simply not ours
    }
  }
  return out;
}

// "Running" is not "accepting connections". pg_isready is the cheapest question that tells them
// apart and it runs INSIDE the container. It reuses the entry's client args (`-U <user>`), because
// they name the role the server was set up with. A container whose `ready_via` is one of ours is
// asked through that one, with `-h`. Anything else is not ours: null.
export async function readyProbe(container, run, readyVia, reg) {
  const ours = postgresTargets(reg);
  let args;
  if (ours.has(container)) args = ['exec', container, 'pg_isready', ...ours.get(container).slice(1)];
  else if (readyVia && ours.has(readyVia)) args = ['exec', readyVia, 'pg_isready', ...ours.get(readyVia).slice(1), '-h', container];
  else return null;
  return /accepting connections/i.test(String(await run(args) ?? ''));
}

addReadyProbe(readyProbe);

// --- reset: the sentinel ---

// A table only this adapter creates. A real restore removes it, and a silent no-op leaves it
// behind, so a baseline that did nothing is caught instead of trusted. Both steps are skipped when
// no sentinel database is configured.
const SENTINEL = 'scn_reset_probe';
const sentinelDb = () => adapterConfig('postgres').sentinelDb ?? null;

export const reset = [
  {
    phase: 'prepare',
    name: 'sentinel-plant',
    async run(reg) {
      const db = sentinelDb();
      if (db === null) return;
      await sql(reg, db, `CREATE TABLE IF NOT EXISTS ${SENTINEL} (id INT)`);
    },
  },
  {
    phase: 'probe',
    name: 'sentinel-check',
    async run(reg) {
      const db = sentinelDb();
      if (db === null) return;
      const rows = await sql(reg, db, `SELECT to_regclass('${SENTINEL}') AS t`);
      if (rows.some(r => r.t !== null && r.t !== undefined)) {
        throw new Blocked('reset did not take effect: sentinel table survived the baseline restore');
      }
    },
  },
];

// --- log patterns ---

// Two spaces: the server writes `ERROR:  <message>`.
export const fatalLogPatterns = ['ERROR:  '];
