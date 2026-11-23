// The sql.mysql dialect driver, exercised through the real sql adapter and a fake docker on PATH.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';
import * as mysqlAdapter from '../adapter-mysql.mjs';
import { parseDbEntry, sql, scalar } from '../db.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked } from '../errors.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

const dialect = mysqlAdapter.drivers['sql.mysql'];
const ADAPTERS = { docker: dockerAdapter, sql: sqlAdapter, mysql: mysqlAdapter };

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: ADAPTERS, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

test('the dialect claims mysql and mariadb clients and nothing else', () => {
  assert.equal(dialect.clients.test('mysql'), true);
  assert.equal(dialect.clients.test('mariadb'), true);
  assert.equal(dialect.clients.test('mysqladmin'), false);
  assert.equal(dialect.clients.test('xmysql'), false);
  assert.equal(dialect.clients.test('other'), false);
});

test('args pipe over stdin, never -e', () => {
  const args = dialect.args({ container: 'app_db', client: ['mysql', '-uroot'], db: 'scn_app' }, 'SELECT 1');
  assert.deepEqual(args, ['exec', '-i', 'app_db', 'mysql', '-uroot', 'scn_app']);
  assert.equal(args.includes('-e'), false);
});

test('parse reads the batch output into rows, NULL to null, escapes undone', () => {
  assert.deepEqual(dialect.parse('id\tval\n1\ta\\tb\n2\tNULL\n'), [{ id: '1', val: 'a\tb' }, { id: '2', val: null }]);
  assert.deepEqual(dialect.parse(''), []);
});

test('a db entry whose client is mysql or mariadb infers the mysql dialect', () => {
  assert.equal(parseDbEntry('scn_app', 'app_db mysql -uroot').dialect, 'mysql');
  assert.equal(parseDbEntry('scn_app', 'app_db mariadb -uroot').dialect, 'mysql');
});

test('a client neither dialect claims is still Blocked, with the remedies', () => {
  assert.throws(() => parseDbEntry('scn_app', 'app_db psqlish -U root'),
    e => e instanceof Blocked && /"psqlish"/.test(e.message) && /dialect/.test(e.message));
});

test('a mapping entry may state the dialect for a client with another name', () => {
  assert.equal(parseDbEntry('scn_app', { container: 'app_db', client: 'wrapper --mysql', dialect: 'mysql' }).dialect, 'mysql');
});

function fakeLog(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-dialect-mysql-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'calls.log');
}

test('sql() runs docker exec with the SQL on stdin and parses the rows', async (t) => {
  const log = fakeLog(t);
  installFakeDocker(t, `in=$(cat)\nprintf '%s|%s\\n' "$*" "$in" >> ${JSON.stringify(log)}\nprintf 'n\\n7\\n'`);
  const reg = { dbTarget: db => parseDbEntry(db, 'app_db mysql -uroot') };
  assert.deepEqual(await sql(reg, 'scn_app', 'SELECT 7 AS n'), [{ n: '7' }]);
  assert.equal(await scalar(reg, 'scn_app', 'SELECT 7 AS n'), '7');
  assert.equal(readFileSync(log, 'utf8').split('\n')[0], 'exec -i app_db mysql -uroot scn_app|SELECT 7 AS n');
});

test('the registry contributes dbTarget and the db containers through the sql adapter', () => {
  const raw = { db: { scn_app: 'app_db mysql -uroot', scn_other: { container: 'other_db', client: 'mariadb -uroot' } } };
  const target = sqlAdapter.registry.accessors(raw).dbTarget('scn_other');
  assert.deepEqual(target, { db: 'scn_other', container: 'other_db', client: ['mariadb', '-uroot'], dialect: 'mysql' });
  assert.deepEqual(sqlAdapter.registry.containers(raw), ['app_db', 'other_db']);
});

test('the adapter declares exactly the drivers adapter.json lists', () => {
  assert.deepEqual(Object.keys(mysqlAdapter.drivers).sort(), ['schemaFreeze', 'sql.mysql']);
});
