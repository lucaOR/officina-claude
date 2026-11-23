import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { schemaFreeze, stopFault } from '../fault.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';
import * as mysqlAdapter from '../adapter-mysql.mjs';
import { addReadyProbe, registeredReady, __resetReadyProbesForTest } from '../docker.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';

const ADAPTERS = { docker: dockerAdapter, sql: sqlAdapter, mysql: mysqlAdapter };
const FAULT_FLAG = 'SCN_ALLOW_CONTAINER_FAULT';
let savedFaultFlag;
let restoreExt;
beforeEach(() => {
  savedFaultFlag = process.env[FAULT_FLAG];
  restoreExt = __setForTest({ adapters: ADAPTERS, providers: {}, hooks: {}, config: {} });
  // Other tests reset the probe list, so the probe the adapter registered at load is put back.
  __resetReadyProbesForTest();
  addReadyProbe(mysqlAdapter.readyProbe);
});
afterEach(() => {
  restoreExt();
  __resetReadyProbesForTest();
  if (savedFaultFlag === undefined) delete process.env[FAULT_FLAG];
  else process.env[FAULT_FLAG] = savedFaultFlag;
});

// The registry hands schemaFreeze the db entry's container and client, as reg.dbTarget() does.
const REG = { raw: {}, dbTarget: () => ({ container: 'app_db', client: ['mysql', '-uroot'] }) };
const PASSWORD_REG = { raw: {}, dbTarget: () => ({ container: 'app_db', client: ['mariadb', '-uroot', '-psecret'] }) };

// A scripted `docker exec -i <c> mysql` client: records stdin writes, answers each marker query on
// stdout once the statement that precedes it has arrived.
function fakeClient({ answer } = {}) {
  const client = new EventEmitter();
  client.writes = [];
  client.killed = false;
  client.ended = false;
  client.stdout = new EventEmitter();
  client.stdin = Object.assign(new EventEmitter(), {
    write(chunk) {
      client.writes.push(String(chunk));
      const out = answer?.(String(chunk), client);
      if (out) setImmediate(() => client.stdout.emit('data', Buffer.from(out)));
      return true;
    },
    end() { client.ended = true; },
  });
  client.kill = () => { client.killed = true; };
  return client;
}

const TABLES_RUN = async () => 'users\ncompanies\n';
const lockAnswer = (chunk) => {
  if (/SELECT CONNECTION_ID/.test(chunk) && /SCN_FROZEN/.test(chunk)) return '42\nSCN_FROZEN\n';
  if (/SCN_THAWED/.test(chunk)) return 'SCN_THAWED\n';
  return '';
};

// --- schemaFreeze ---

test('schemaFreeze refuses a non-scn_ schema and a missing opt-in without spawning', async () => {
  const spawnClient = () => { throw new Error('spawned'); };
  const run = async () => { throw new Error('docker reached'); };
  const killSync = () => { throw new Error('killed'); };
  process.env[FAULT_FLAG] = '1';
  await assert.rejects(() => schemaFreeze(REG, 'ambient_app', { run, spawnClient, killSync }),
    e => e instanceof Blocked && /non-scn_/.test(e.message));
  delete process.env[FAULT_FLAG];
  await assert.rejects(() => schemaFreeze(REG, 'scn_app', { run, spawnClient, killSync }),
    e => e instanceof Blocked && /SCN_ALLOW_CONTAINER_FAULT/.test(e.message));
});

test('schemaFreeze locks every base table and resolves only after SCN_FROZEN', async () => {
  process.env[FAULT_FLAG] = '1';
  const client = fakeClient({ answer: lockAnswer });
  const spawned = [];
  const spawnClient = (args) => { spawned.push(args); return client; };
  const fault = await schemaFreeze(REG, 'scn_app', { run: TABLES_RUN, spawnClient, killSync: () => {} });
  assert.deepEqual(spawned[0], ['exec', '-i', 'app_db', 'mysql', '-uroot', '-N', '--unbuffered']);
  const written = client.writes.join('');
  assert.match(written, /SELECT CONNECTION_ID\(\);/);
  assert.ok(written.includes('LOCK TABLES `scn_app`.`users` WRITE, `scn_app`.`companies` WRITE;'), written);
  assert.match(written, /SELECT 'SCN_FROZEN';/);
  await fault.restore();
});

test('schemaFreeze lists the base tables with one query piped over stdin', async () => {
  process.env[FAULT_FLAG] = '1';
  const calls = [];
  const run = async (args, stdin) => { calls.push({ args, stdin }); return 'users\n'; };
  const fault = await schemaFreeze(REG, 'scn_app', { run, spawnClient: () => fakeClient({ answer: lockAnswer }), killSync: () => {} });
  assert.deepEqual(calls[0].args, ['exec', '-i', 'app_db', 'mysql', '-uroot', '-N']);
  assert.match(calls[0].stdin, /table_schema = 'scn_app' AND table_type = 'BASE TABLE'/);
  await fault.restore();
});

test('schemaFreeze is Blocked when the schema has no base tables, and spawns no client', async () => {
  process.env[FAULT_FLAG] = '1';
  const spawnClient = () => { throw new Error('spawned'); };
  await assert.rejects(() => schemaFreeze(REG, 'scn_app', { run: async () => '\n', spawnClient, killSync: () => {} }),
    e => e instanceof Blocked && /no base tables in scn_app/.test(e.message));
});

test('schemaFreeze restore unlocks and ends the client; a second restore is a no-op', async () => {
  process.env[FAULT_FLAG] = '1';
  const client = fakeClient({ answer: lockAnswer });
  const fault = await schemaFreeze(REG, 'scn_app', { run: TABLES_RUN, spawnClient: () => client, killSync: () => {} });
  const before = client.writes.length;
  await fault.restore();
  assert.ok(client.writes.slice(before).join('').includes('UNLOCK TABLES;'));
  assert.match(client.writes.slice(before).join(''), /SELECT 'SCN_THAWED';/);
  assert.equal(client.ended, true);
  const after = client.writes.length;
  await fault.restore();
  assert.equal(client.writes.length, after);
});

test('schemaFreeze exit handler kills the locking connection server-side', async () => {
  process.env[FAULT_FLAG] = '1';
  const client = fakeClient({ answer: lockAnswer });
  const kills = [];
  const before = process.listeners('exit');
  const fault = await schemaFreeze(REG, 'scn_app', {
    run: TABLES_RUN, spawnClient: () => client, killSync: (args) => kills.push(args),
  });
  const onExit = process.listeners('exit').find(l => !before.includes(l));
  assert.ok(onExit, 'an exit handler must be armed');
  onExit();
  assert.deepEqual(kills[0], ['exec', 'app_db', 'mysql', '-uroot', '-e', 'KILL 42']);
  await fault.restore();
  assert.ok(!process.listeners('exit').includes(onExit), 'restore disarms the exit handler');
});

test('schemaFreeze lists, locks and kills through the db entry\'s own client, password included', async () => {
  process.env[FAULT_FLAG] = '1';
  const client = fakeClient({ answer: lockAnswer });
  const calls = [];
  const spawned = [];
  const kills = [];
  const before = process.listeners('exit');
  const fault = await schemaFreeze(PASSWORD_REG, 'scn_app', {
    run: async (args, stdin) => { calls.push(args); return TABLES_RUN(args, stdin); },
    spawnClient: (args) => { spawned.push(args); return client; },
    killSync: (args) => kills.push(args),
  });
  assert.deepEqual(calls[0], ['exec', '-i', 'app_db', 'mariadb', '-uroot', '-psecret', '-N']);
  assert.deepEqual(spawned[0], ['exec', '-i', 'app_db', 'mariadb', '-uroot', '-psecret', '-N', '--unbuffered']);
  process.listeners('exit').find(l => !before.includes(l))();
  assert.deepEqual(kills[0], ['exec', 'app_db', 'mariadb', '-uroot', '-psecret', '-e', 'KILL 42']);
  await fault.restore();
});

const recoveryListeners = () => ['exit', 'SIGTERM', 'SIGINT'].map(e => process.listenerCount(e));

test('schemaFreeze is Blocked when the lock is not confirmed in time, and kills the client', async () => {
  process.env[FAULT_FLAG] = '1';
  const client = fakeClient({ answer: () => '' });
  const before = recoveryListeners();
  await assert.rejects(
    () => schemaFreeze(REG, 'scn_app', { run: TABLES_RUN, spawnClient: () => client, killSync: () => {}, timeoutMs: 50 }),
    e => e instanceof Blocked && /SCN_FROZEN|lock/.test(e.message),
  );
  assert.equal(client.killed, true);
  assert.deepEqual(recoveryListeners(), before, 'the exit/signal safety net must be disarmed once the client is killed');
});

// LOCK TABLES can wait on another session. The connection id arrives before that wait, so a timeout
// (or a stop) during it must still KILL server-side; killing only the local docker client does not
// end the server session.
test('schemaFreeze kills the waiting connection server-side when the lock never confirms', async () => {
  process.env[FAULT_FLAG] = '1';
  const client = fakeClient({ answer: chunk => (/SELECT CONNECTION_ID/.test(chunk) ? '42\n' : '') });
  const kills = [];
  await assert.rejects(
    () => schemaFreeze(REG, 'scn_app', { run: TABLES_RUN, spawnClient: () => client, killSync: (args) => kills.push(args), timeoutMs: 50 }),
    e => e instanceof Blocked && /SCN_FROZEN/.test(e.message),
  );
  assert.deepEqual(kills[0], ['exec', 'app_db', 'mysql', '-uroot', '-e', 'KILL 42']);
});

// A client that dies after the freeze turns restore()'s write into an EPIPE 'error'. With no
// listener that error would be thrown inside the row's own cleanup; now restore() reports Blocked, at
// once rather than at its timeout, and keeps the safety net armed because the lock may still be held.
test('schemaFreeze restore reports a dead client as Blocked instead of crashing', async () => {
  process.env[FAULT_FLAG] = '1';
  const client = fakeClient({
    answer: (chunk, c) => {
      if (/SCN_FROZEN/.test(chunk)) return '42\nSCN_FROZEN\n';
      setImmediate(() => {
        c.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        c.emit('close', 1);
      });
      return '';
    },
  });
  const kills = [];
  const events = ['exit', 'SIGTERM', 'SIGINT'];
  const before = Object.fromEntries(events.map(e => [e, process.listeners(e)]));
  const added = e => process.listeners(e).filter(l => !before[e].includes(l));
  const fault = await schemaFreeze(REG, 'scn_app', {
    run: TABLES_RUN, spawnClient: () => client, killSync: (args) => kills.push(args), timeoutMs: 10000,
  });
  const started = Date.now();
  await assert.rejects(() => fault.restore(), e => e instanceof Blocked && /EPIPE/.test(e.message));
  assert.ok(Date.now() - started < 5000, 'a dead client must end the wait, not the 10s timeout');
  assert.equal(added('exit').length, 1, 'the safety net stays armed while the lock may be held');
  added('exit')[0]();
  assert.deepEqual(kills[0], ['exec', 'app_db', 'mysql', '-uroot', '-e', 'KILL 42']);
  for (const e of events) for (const l of added(e)) process.removeListener(e, l);
});

// --- the ready probe ---
// A running database is not an answering one. The probe claims the containers it understands, and
// answers null for everything else so docker's own judgement applies.

const probeReg = {
  raw: {
    db: { scn_app: 'app_db mysql -uroot', scn_other: { container: 'other_db', client: 'wrapper', dialect: 'other' } },
    fault_containers: { 'scn-replica': { ready_via: 'app_db' }, 'scn-cache': { ready_via: 'cache_probe' }, other_db: {} },
  },
};
const ALIVE = 'mysqld is alive\n';

test('the probe claims a mysql db container and pings it by name', async () => {
  const calls = [];
  const ready = await registeredReady('app_db', async (args) => { calls.push(args); return ALIVE; }, undefined, probeReg);
  assert.equal(ready, true);
  assert.deepEqual(calls, [['exec', 'app_db', 'mysqladmin', 'ping', '-uroot']]);
});

test('the probe claims a container whose ready_via is a mysql db container and pings it from there', async () => {
  const calls = [];
  const ready = await registeredReady('scn-replica', async (args) => { calls.push(args); return ALIVE; }, 'app_db', probeReg);
  assert.equal(ready, true);
  assert.deepEqual(calls, [['exec', 'app_db', 'mysqladmin', 'ping', '-h', 'scn-replica', '-uroot']]);
});

test('the probe connects with the db entry\'s own client arguments, so a password-protected root answers', async () => {
  const reg = { raw: { db: { scn_app: 'app_db mysql -uroot -psecret' }, fault_containers: { 'scn-replica': { ready_via: 'app_db' } } } };
  const calls = [];
  const run = async (args) => { calls.push(args); return ALIVE; };
  assert.equal(await registeredReady('app_db', run, undefined, reg), true);
  assert.equal(await registeredReady('scn-replica', run, 'app_db', reg), true);
  assert.deepEqual(calls, [
    ['exec', 'app_db', 'mysqladmin', 'ping', '-uroot', '-psecret'],
    ['exec', 'app_db', 'mysqladmin', 'ping', '-h', 'scn-replica', '-uroot', '-psecret'],
  ]);
});

test('a mariadb client is pinged with mariadb-admin, which recent mariadb images ship instead of mysqladmin', async () => {
  const reg = { raw: { db: { scn_app: { container: 'app_db', client: ['mariadb', '--user=root', '--password=s3cret'] } } } };
  const calls = [];
  assert.equal(await registeredReady('app_db', async (args) => { calls.push(args); return ALIVE; }, undefined, reg), true);
  assert.deepEqual(calls, [['exec', 'app_db', 'mariadb-admin', 'ping', '--user=root', '--password=s3cret']]);
});

test('the probe answers false when the output is not "mysqld is alive"', async () => {
  assert.equal(await registeredReady('app_db', async () => 'mysqld is not alive', undefined, probeReg), false);
  assert.equal(await registeredReady('app_db', async () => undefined, undefined, probeReg), false);
});

test('the probe answers null for a container it does not understand, without running anything', async () => {
  const run = async () => { throw new Error('must not run'); };
  assert.equal(await registeredReady('scn-cache', run, 'cache_probe', probeReg), null, 'ready_via is not a mysql db container');
  assert.equal(await registeredReady('stranger', run, undefined, probeReg), null, 'not in the registry at all');
  assert.equal(await registeredReady('other_db', run, undefined, probeReg), null, 'a db container of another dialect');
  assert.equal(await registeredReady('app_db_x', run, 'other_db', probeReg), null, 'ready_via of another dialect');
  assert.equal(await registeredReady('anything', run, undefined, { raw: {} }), null, 'no db entries');
});

test('stopFault waits for a fault container through its ready_via host, with entries a project really has', async () => {
  process.env[FAULT_FLAG] = '1';
  const reg = { raw: { db: { scn_core: 'app_db mysql -uroot' }, fault_containers: { 'scn-replica-db': { ready_via: 'app_db' } } } };
  const calls = [];
  const run = async (args) => { calls.push(args); return args[0] === 'exec' ? ALIVE : ''; };
  const { restore } = await stopFault({ cleanups: [] }, reg, 'scn-replica-db', { run, startSync: () => {} });
  await restore();
  assert.deepEqual(calls, [
    ['stop', 'scn-replica-db'],
    ['start', 'scn-replica-db'],
    ['exec', 'app_db', 'mysqladmin', 'ping', '-h', 'scn-replica-db', '-uroot'],
  ]);
});

test('stopFault accepts a db container as the faulted container: the sql registry puts it in the perimeter', async () => {
  process.env[FAULT_FLAG] = '1';
  const reg = { raw: { db: { scn_app: 'app_db mysql -uroot' } } };
  const calls = [];
  const run = async (args) => { calls.push(args); return args[0] === 'exec' ? ALIVE : ''; };
  const { restore } = await stopFault({ cleanups: [] }, reg, 'app_db', { run, startSync: () => {} });
  await restore();
  assert.deepEqual(calls[2], ['exec', 'app_db', 'mysqladmin', 'ping', '-uroot']);
});

test('the probe is the one the adapter exports: registering it is what makes docker consult it', async () => {
  __resetReadyProbesForTest();
  assert.equal(await registeredReady('app_db', async () => ALIVE, undefined, probeReg), null, 'no probe registered, so nobody claims it');
  addReadyProbe(mysqlAdapter.readyProbe);
  assert.equal(await registeredReady('app_db', async () => ALIVE, undefined, probeReg), true);
});
