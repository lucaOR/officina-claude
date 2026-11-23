// The sql.postgres dialect driver, the sentinel reset steps and the readiness probe, exercised
// through the real sql adapter and a fake docker on PATH. The last test needs a real Docker daemon
// and pulls postgres:16, so it runs only when SCN_DOCKER_TESTS=1: this file ships into a project's
// own test suite, which `setup verify` and `setup upgrade` run and which must stay offline.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';
import * as postgresAdapter from '../adapter-postgres.mjs';
import { parseDbEntry, sql, scalar } from '../db.mjs';
import { contributions, driver, __setForTest } from '../ext.mjs';
import { reset } from '../reset.mjs';
import { Blocked } from '../errors.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

const dialect = postgresAdapter.drivers['sql.postgres'];
const ADAPTERS = { docker: dockerAdapter, sql: sqlAdapter, postgres: postgresAdapter };
const RAW = { db: { scn_app: 'app_db psql -U postgres' } };
const reg = { raw: RAW, ...sqlAdapter.registry.accessors(RAW) };

let restoreExt;
const install = postgres => { restoreExt = __setForTest({ adapters: ADAPTERS, providers: {}, hooks: {}, config: { adapters: { postgres } } }); };
beforeEach(() => install({ sentinelDb: 'scn_app' }));
afterEach(() => restoreExt());

const tmpLog = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'calls.log');
};

test('the dialect claims the psql client and nothing else', () => {
  assert.equal(dialect.clients.test('psql'), true);
  assert.equal(dialect.clients.test('pg_isready'), false);
  assert.equal(dialect.clients.test('xpsql'), false);
  assert.equal(dialect.clients.test('mysql'), false);
});

test('psql args carry ON_ERROR_STOP and the target db', () => {
  const args = dialect.args({ container: 'app_db', client: ['psql', '-U', 'postgres'], db: 'scn_app' }, 'SELECT 1');
  assert.deepEqual(args.slice(0, 6), ['exec', '-i', 'app_db', 'psql', '-U', 'postgres']);
  assert.ok(args.includes('-X') && args.includes('-A'));
  assert.equal(args[args.indexOf('-F') + 1], '\t');
  assert.equal(args[args.indexOf('-v') + 1], 'ON_ERROR_STOP=1');
  assert.equal(args[args.indexOf('-d') + 1], 'scn_app');
  assert.deepEqual(args.slice(-2), ['-c', 'SELECT 1']);
});

test('psql prints a header and NULL as NULL, so the parser can use the shared conventions', () => {
  const args = dialect.args({ container: 'c', client: ['psql'], db: 'scn_app' }, 'SELECT 1');
  assert.equal(args.includes('-t'), false, '-t would drop the header line the parser needs');
  assert.ok(args.includes('footer=off'));
  assert.ok(args.includes('null=NULL'));
});

test('parse turns psql tab output into rows, keeping every backslash as psql printed it', () => {
  // psql -A escapes nothing, so a backslash in its output is a backslash in the value.
  assert.deepEqual(dialect.parse('id\tval\n1\tC:\\new\n2\tNULL\n3\t{"a":"x\\ny"}\n4\ta\\tb\n'), [
    { id: '1', val: 'C:\\new' },
    { id: '2', val: null },
    { id: '3', val: '{"a":"x\\ny"}' },
    { id: '4', val: 'a\\tb' },
  ]);
  assert.deepEqual(dialect.parse('id\n'), []);
  assert.deepEqual(dialect.parse('CREATE TABLE\n'), []);
  assert.deepEqual(dialect.parse(''), []);
});

test('a db entry whose client is psql infers the postgres dialect', () => {
  assert.equal(parseDbEntry('scn_app', 'app_db psql -U postgres').dialect, 'postgres');
});

test('the adapter declares exactly the drivers adapter.json lists', () => {
  assert.deepEqual(Object.keys(postgresAdapter.drivers), ['sql.postgres']);
});

test('sql() runs docker exec with psql arguments and parses the rows', async (t) => {
  const log = tmpLog(t, 'scn-dialect-postgres-');
  installFakeDocker(t, `printf '%s\\n' "$*" >> ${JSON.stringify(log)}\nprintf 'n\\n7\\n'`);
  assert.deepEqual(await sql(reg, 'scn_app', 'SELECT 7 AS n'), [{ n: '7' }]);
  assert.equal(await scalar(reg, 'scn_app', 'SELECT 7 AS n'), '7');
  const call = readFileSync(log, 'utf8').split('\n')[0];
  assert.match(call, /^exec -i app_db psql -U postgres -X -A -F\s.* -v ON_ERROR_STOP=1 -d scn_app -c SELECT 7 AS n$/);
});

test('a missing scenario database is Blocked, a data error is not', async (t) => {
  installFakeDocker(t, `echo 'psql: error: connection to server failed: FATAL:  database "scn_app" does not exist' >&2; exit 2`);
  await assert.rejects(() => sql(reg, 'scn_app', 'SELECT 1'), e => e instanceof Blocked);
  installFakeDocker(t, `echo 'ERROR:  column "nope" does not exist' >&2; exit 3`);
  await assert.rejects(() => sql(reg, 'scn_app', 'SELECT nope'), e => !(e instanceof Blocked));
});

test('the fatal log pattern is the server error prefix', () => {
  assert.deepEqual(postgresAdapter.fatalLogPatterns, ['ERROR:  ']);
});

test('the adapter has no schemaFreeze and no rehearse', () => {
  // fault.mjs resolves schemaFreeze through driver(), which reads each adapter's `drivers` map, so
  // that map is where it must be absent; the lookup itself is the behaviour that matters.
  assert.equal(postgresAdapter.drivers.schemaFreeze, undefined);
  assert.throws(() => driver('schemaFreeze'), e => e instanceof Blocked);
  assert.equal(postgresAdapter.rehearse, undefined);
});

// --- reset sentinel ---

const PLANT = 'CREATE TABLE IF NOT EXISTS scn_reset_probe (id INT)';
const CHECK = "SELECT to_regclass('scn_reset_probe') AS t";

function resetDocker(t, shown) {
  const log = tmpLog(t, 'scn-reset-postgres-');
  installFakeDocker(t, `last=""; for a in "$@"; do last="$a"; done\nprintf 'CALL %s\\n' "$last" >> ${JSON.stringify(log)}\ncase "$last" in *to_regclass*) printf '${shown}';; esac`);
  return log;
}

test('the sentinel is planted in prepare and checked in probe', async (t) => {
  const log = resetDocker(t, 't\\nNULL\\n');
  const steps = contributions('reset');
  assert.deepEqual(steps.map(s => [s.phase, s.name, s.owner]), [['prepare', 'sentinel-plant', 'postgres'], ['probe', 'sentinel-check', 'postgres']]);
  await reset(reg, { baseline: async () => appendFileSync(log, 'BASELINE\n') });
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`CALL ${PLANT}`, 'BASELINE', `CALL ${CHECK}`]);
});

test('a sentinel that survives the restore is Blocked: a no-op restore is a broken environment', async (t) => {
  resetDocker(t, 't\\nscn_reset_probe\\n');
  await assert.rejects(() => reset(reg, { baseline: async () => {} }),
    e => e instanceof Blocked && e.message === 'reset did not take effect: sentinel table survived the baseline restore');
});

test('the sentinel steps are skipped without sentinelDb', async (t) => {
  restoreExt();
  install({ sentinelDb: null });
  const log = resetDocker(t, 't\\nscn_reset_probe\\n');
  await reset(reg, { baseline: async () => {} });
  assert.equal(existsSync(log), false, 'docker must not be reached when no sentinel database is configured');
});

// --- readiness probe ---

test('pg_isready inside the container answers readiness for a db container and for its ready_via users', async () => {
  const calls = [];
  const raw = { db: { scn_app: 'app_db psql -U postgres' } };
  assert.equal(await postgresAdapter.readyProbe('app_db', async a => { calls.push(a); return '/var/run:5432 - accepting connections\n'; }, undefined, { raw }), true);
  assert.deepEqual(calls[0], ['exec', 'app_db', 'pg_isready', '-U', 'postgres']);
  assert.equal(await postgresAdapter.readyProbe('app_db', async () => '/var/run:5432 - no response\n', undefined, { raw }), false);
  assert.equal(await postgresAdapter.readyProbe('web', async () => 'x', undefined, { raw }), null);
  calls.length = 0;
  assert.equal(await postgresAdapter.readyProbe('web', async a => { calls.push(a); return 'accepting connections'; }, 'app_db', { raw }), true);
  assert.deepEqual(calls[0], ['exec', 'app_db', 'pg_isready', '-U', 'postgres', '-h', 'web']);
});

// --- real server ---

const dockerUp = () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

test('sql round-trips against a postgres:16 container', async (t) => {
  if (process.env.SCN_DOCKER_TESTS !== '1') return t.skip('a Docker test: set SCN_DOCKER_TESTS=1 to run it');
  if (!dockerUp()) return t.skip('docker not available');
  const name = `scn-pgtest-${process.pid}-${Date.now()}`;
  const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
  t.after(() => { docker('rm', '-f', name); });
  const started = docker('run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=scn', '-e', 'POSTGRES_DB=scn_app', 'postgres:16');
  assert.equal(started.status, 0, started.stderr);
  // Poll for readiness. The image restarts its server once during initialisation, so a single
  // pg_isready is not enough and a real query is the proof.
  const deadline = Date.now() + 60000;
  const liveReg = { dbTarget: db => parseDbEntry(db, `${name} psql -U postgres`) };
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try { ready = (await scalar(liveReg, 'scn_app', 'SELECT 1 AS one')) === '1'; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  assert.ok(ready, 'the server never answered');
  await sql(liveReg, 'scn_app', 'CREATE TABLE scn_t (id INT, note TEXT)');
  await sql(liveReg, 'scn_app', "INSERT INTO scn_t VALUES (1, 'a'), (2, NULL)");
  assert.deepEqual(await sql(liveReg, 'scn_app', 'SELECT id, note FROM scn_t ORDER BY id'), [{ id: '1', note: 'a' }, { id: '2', note: null }]);
  assert.equal(await scalar(liveReg, 'scn_app', 'SELECT count(*) AS n FROM scn_t'), '2');
  await assert.rejects(() => sql(liveReg, 'scn_app', 'SELECT nope FROM scn_t'), e => !(e instanceof Blocked));
});
