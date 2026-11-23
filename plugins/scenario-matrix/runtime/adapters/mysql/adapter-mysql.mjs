// The mysql adapter's contribution module: the `sql.mysql` dialect driver for the sql adapter's
// levers, the `schemaFreeze` fault, the sentinel reset steps, its lint rule, its selftest probes and
// the setup-SQL rehearsal command. The keys of `drivers` equal the `drivers` array of adapter.json.
//
// Loading this module also teaches the docker adapter two things that only this client knows: which
// of its failures say the environment is absent (addEnvironmentFailure), and how to ask a database
// container whether it is answering (addReadyProbe).
import { spawn, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { Blocked } from './errors.mjs';
import { adapterConfig, config } from './config.mjs';
import { addEnvironmentFailure, addReadyProbe } from './docker.mjs';
import { armRecovery, defaultReraiseSignal, requireOptIn } from './adapter-docker.mjs';
import { assertScnTarget, dockerRun, parseDbEntry, parseRows, scalar, sql } from './db.mjs';

export const name = 'mysql';

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --- environment failure ---

// The one client error that is a statement about the environment rather than about the data: the
// target database is absent. assertScnTarget() has already proved the target carries the scenario
// prefix, i.e. it is the harness's own registry argument and never a name the product chose, so "it
// isn't there" means the scenario stack was never provisioned. The text is anchored on the prefix so
// a database the PRODUCT failed to create cannot launder itself out of KO.
addEnvironmentFailure(new RegExp(`Unknown database '${escapeRe(config().dbPrefix)}`, 'i'));

// --- sql.mysql ---

// The client reads the SQL from stdin, so `args` never includes the text.
const sqlMysql = {
  clients: /^(mysql|mariadb)$/,
  args: target => ['exec', '-i', target.container, ...target.client, target.db],
  parse: parseRows,
};

// --- the client's companion tools ---

// mysqladmin and mysqldump connect the way the db entry's client does: they get every argument that
// follows the client binary (its user, password, host and the like), so those arguments must be
// connection options all three tools accept. A `mariadb` client pairs with mariadb-admin and
// mariadb-dump, which recent mariadb images ship in place of the mysql-named tools.
export function companion(client, tool) {
  const [binary, ...args] = client;
  return [basename(binary) === 'mariadb' ? `mariadb-${tool}` : `mysql${tool}`, ...args];
}

// --- ready probe ---

// The containers the registry's `db` entries name that this adapter drives, with their client argv.
function mysqlTargets(reg) {
  const out = new Map();
  for (const [db, entry] of Object.entries(reg?.raw?.db ?? {})) {
    try {
      const target = parseDbEntry(db, entry);
      if (target.dialect === 'mysql') out.set(target.container, target.client);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e; // an entry no dialect drives is simply not ours
    }
  }
  return out;
}

// "Running" is not "accepting connections". mysqladmin ping is the cheapest question that tells them
// apart, and it runs INSIDE a container, so it needs no host client. It connects with the db entry's
// own client arguments, because a server that requires a password never says "alive" to a ping it
// denies. A database container is asked directly. A container whose `ready_via` is one of ours is
// asked through that one, with `-h`. Anything else is not ours: null.
export async function readyProbe(container, run, readyVia, reg) {
  const ours = mysqlTargets(reg);
  const ping = (via, ...host) => {
    const [admin, ...credentials] = companion(ours.get(via), 'admin');
    return ['exec', via, admin, 'ping', ...host, ...credentials];
  };
  let args;
  if (ours.has(container)) args = ping(container);
  else if (readyVia && ours.has(readyVia)) args = ping(readyVia, '-h', container);
  else return null;
  return /mysqld is alive/i.test(String(await run(args) ?? ''));
}

addReadyProbe(readyProbe);

// --- schemaFreeze ---

// Freezes ONE schema, and nothing else, by holding a WRITE lock on every one of its base tables from
// a single long-lived client. Every query that touches that schema waits on the lock; every other
// schema, and every other service in the shared containers, carries on. This is the shared-container
// replacement for pausing a service's container: pausing a shared one would freeze every worker, and
// with them the phase of the row under test.
//
// The lock lives as long as the client's connection, so the safety net is server-side: the exit and
// signal recovery issues `KILL <connection id>` through a SECOND connection (killSync), because
// killing only the local docker client is not guaranteed to close the server-side session promptly.
async function schemaFreeze(reg, schema, {
  run = dockerRun,
  spawnClient = defaultSpawnClient,
  killSync = defaultKillSync,
  reraiseSignal = defaultReraiseSignal,
  timeoutMs = 15000,
} = {}) {
  assertScnTarget(schema);
  requireOptIn('schemaFreeze');
  // The db entry's own client, so a password-protected server is locked the way scenarios reach it.
  const { container, client: argv } = reg.dbTarget(schema);

  const listing = await run(['exec', '-i', container, ...argv, '-N'],
    `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' `
    + "AND table_type = 'BASE TABLE' ORDER BY table_name;");
  const tables = String(listing ?? '').split('\n').map(t => t.trim()).filter(Boolean);
  if (tables.length === 0) {
    throw new Blocked(`schemaFreeze() found no base tables in ${schema}, so there is nothing to lock`);
  }

  let connectionId = null;
  const client = spawnClient(['exec', '-i', container, ...argv, '-N', '--unbuffered']);
  // An emitter with no 'error' listener throws, so a client that fails to spawn, or a write to one
  // that already died (EPIPE from restore()), would crash the row inside its own cleanup. The error
  // is kept and named instead.
  let clientError = null;
  const noteError = err => { clientError ??= err; };
  client.on('error', noteError);
  client.stdin.on('error', noteError);
  const why = () => (clientError ? ` (the client failed: ${clientError.message})` : '');
  const reader = markerReader(client);
  // The id is taken the moment its line arrives, not once SCN_FROZEN does: LOCK TABLES can wait on
  // another session's lock, and a stop or a timeout during that wait must still be able to KILL the
  // connection server-side.
  let idBuffer = '';
  const readId = chunk => {
    idBuffer += chunk;
    const id = idBuffer.split('\n').slice(0, -1).map(l => l.trim()).find(l => /^\d+$/.test(l));
    if (id === undefined) return;
    connectionId = id;
    client.stdout.off('data', readId);
  };
  client.stdout.on('data', readId);
  const recoverSync = () => {
    if (connectionId !== null) killSync(['exec', container, ...argv, '-e', `KILL ${connectionId}`]);
    client.kill();
  };
  const disarm = armRecovery(recoverSync, reraiseSignal);

  const lockList = tables.map(t => `\`${schema}\`.\`${t}\` WRITE`).join(', ');
  client.stdin.write(`SELECT CONNECTION_ID();\nLOCK TABLES ${lockList};\nSELECT 'SCN_FROZEN';\n`);
  const frozen = await reader.until('SCN_FROZEN', timeoutMs);
  if (frozen === null) {
    recoverSync();
    disarm();
    throw new Blocked(
      `schemaFreeze() did not see the SCN_FROZEN marker within ${timeoutMs}ms, so the lock on ${schema} `
      + `is not confirmed; the locking client was killed${why()}`,
    );
  }

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    client.stdin.write("UNLOCK TABLES;\nSELECT 'SCN_THAWED';\n");
    const thawed = await reader.until('SCN_THAWED', timeoutMs);
    client.stdin.end();
    if (thawed === null) {
      // The safety net stays armed: the lock may still be held.
      throw new Blocked(`schemaFreeze().restore() did not see SCN_THAWED within ${timeoutMs}ms; ${schema} may still be locked${why()}`);
    }
    disarm();
  };
  return { restore };
}

function defaultSpawnClient(args) {
  return spawn('docker', args, { stdio: ['pipe', 'pipe', 'inherit'] });
}

function defaultKillSync(args) {
  spawnSync('docker', args);
}

// Accumulates a client's stdout and resolves once a marker line has arrived, returning everything
// read up to and including it, or null on timeout. A client that has closed or failed will never
// print the marker, so a wait then resolves null at once instead of at its timeout.
function markerReader(client) {
  let buffer = '';
  let ended = false;
  const waiters = [];
  const checkAll = () => { for (const w of [...waiters]) w.check(); };
  client.stdout.on('data', chunk => {
    buffer += chunk;
    checkAll();
  });
  const end = () => { ended = true; checkAll(); };
  client.on('close', end);
  client.on('error', end);
  return {
    until(marker, timeoutMs) {
      return new Promise(resolve => {
        const settle = value => {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          resolve(value);
        };
        const waiter = {
          check: () => {
            const at = buffer.indexOf(marker);
            if (at === -1 && ended) {
              settle(null);
              return;
            }
            if (at === -1) return;
            const upTo = buffer.slice(0, at + marker.length);
            buffer = buffer.slice(at + marker.length);
            settle(upTo);
          },
        };
        const timer = setTimeout(() => settle(null), timeoutMs);
        waiters.push(waiter);
        waiter.check();
      });
    },
  };
}

export const drivers = {
  'sql.mysql': sqlMysql,
  schemaFreeze,
};

// --- reset: the sentinel ---

// A table only this adapter creates. A real restore (drop and reload the database) removes it, and a
// silent no-op leaves it behind, so a baseline that did nothing is caught instead of trusted. Both
// steps are skipped when no sentinel database is configured.
const SENTINEL = 'scn_reset_probe';
const sentinelDb = () => adapterConfig('mysql').sentinelDb ?? null;

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
      const rows = await sql(reg, db, `SHOW TABLES LIKE '${SENTINEL}'`);
      if (rows.length > 0) {
        throw new Blocked('reset did not take effect: sentinel table survived the baseline restore');
      }
    },
  },
];

// --- lint ---

export const lint = [
  { id: 'mysql-cli', kind: 'code', re: /\bmysql\s+-u/, msg: 'raw mysql client — use sql()' },
];

// --- log patterns ---

export const fatalLogPatterns = ['SQLSTATE'];

// --- rehearse and verify ---

export const rehearse = {
  command: 'node .claude/scenarios/_lib/rehearse-sql.mjs {matrix} [--family {family}] [--mutates]',
};

// `{container}` and `{client}` come from `reg.dbTarget('{db}')`.
export const verify = {
  command: "docker exec {container} {client} -N -e \"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='{db}' AND table_name='{table}'\"",
};

// --- selftest ---

export const selftest = [
  {
    name: 'sql: positive',
    needs: ['adapters.mysql.selftest.db'],
    run: async (reg, cfg) => (await scalar(reg, cfg.adapters.mysql.selftest.db, 'SELECT 1')) === '1',
  },
  {
    // Not a real database: the guard rejects on the prefix alone, so a name that cannot possibly
    // resolve exercises the same code path without ever letting a guard regression run a query
    // against real data. It reaches nothing, so it needs no configured database.
    name: 'sql: guard refuses a dev database',
    needs: [],
    run: async (reg) => {
      try {
        await sql(reg, 'not_scn_selftest_should_never_resolve', 'SELECT 1');
        return false;
      } catch (e) {
        return /refusing non-.+ target/.test(e.message);
      }
    },
  },
];
