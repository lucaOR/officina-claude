import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, assertScnTarget, parseDbEntry, sql, one, scalar } from '../db.mjs';
import * as dbModule from '../db.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';
import { dockerRun } from '../docker.mjs';
import { __setForTest } from '../ext.mjs';
import { Blocked, Ko } from '../errors.mjs';

// A stand-in dialect: the tests of this adapter never depend on a real client being installed.
const fakeDialect = {
  clients: /^fakecli$/,
  args: (target, text) => ['exec', '-i', target.container, ...target.client, target.db, `len=${text.length}`],
  parse: parseRows,
};
const dialectAdapter = { name: 'fake', drivers: { 'sql.fake': fakeDialect } };

let restoreExt;
const install = (config = {}) => {
  restoreExt = __setForTest({
    adapters: { docker: dockerAdapter, sql: sqlAdapter, fake: dialectAdapter }, providers: {}, hooks: {}, config,
  });
};
beforeEach(() => install());
afterEach(() => restoreExt());

const target = db => ({ db, container: 'app_db', client: ['fakecli', '-uroot'], dialect: 'fake' });

test('parseRows turns tab-separated output into objects, NULL to null', () => {
  const raw = 'id\tlabel\n1\tScn Tenant\n2\tNULL\n';
  assert.deepEqual(parseRows(raw), [
    { id: '1', label: 'Scn Tenant' },
    { id: '2', label: null },
  ]);
});

test('parseRows with escaped: false reads every value verbatim, backslashes included', () => {
  // For a client that escapes nothing: its only tab and newline bytes are the delimiters.
  const raw = 'id\tpath\tdoc\n1\tC:\\new\t{"a":"x\\ny"}\n2\t\\\\t\tNULL\n';
  assert.deepEqual(parseRows(raw, { escaped: false }), [
    { id: '1', path: 'C:\\new', doc: '{"a":"x\\ny"}' },
    { id: '2', path: '\\\\t', doc: null },
  ]);
  assert.deepEqual(parseRows('id\n', { escaped: false }), []);
});

test('parseRows returns [] for an empty result set', () => {
  assert.deepEqual(parseRows(''), []);
  assert.deepEqual(parseRows('id\tlabel\n'), []);
});

test('parseRows unescapes batch-mode \\t \\n \\\\ without misreading an escaped backslash + literal t as a tab', () => {
  // A real tab, newline or backslash BYTE inside a value is escaped by the client to the two-character
  // sequence \t, \n or \\. Each raw fragment below mirrors what the client emits.
  const header = 'id\tval\n';
  const raw = header
    + '1\t' + '\\\\t' + '\n'   // data: a real backslash followed by a literal 't' (NOT a tab)
    + '2\t' + 'a\\tb' + '\n'   // data: a real TAB byte between a and b
    + '3\t' + 'c\\nd' + '\n'   // data: a real NEWLINE byte between c and d
    + '4\t' + 'e\\\\f' + '\n'; // data: a single real backslash between e and f
  assert.deepEqual(parseRows(raw), [
    { id: '1', val: '\\t' },
    { id: '2', val: 'a\tb' },
    { id: '3', val: 'c\nd' },
    { id: '4', val: 'e\\f' },
  ]);
});

test('assertScnTarget refuses a real dev database', () => {
  assert.throws(() => assertScnTarget('ambient_app'), /refusing non-scn_ target/);
  assert.throws(() => assertScnTarget('local_app_main'), /refusing non-scn_ target/);
  // Anchor check: 'not_scn_backup' contains "scn_" as a substring but does not start with it.
  assert.throws(() => assertScnTarget('not_scn_backup'), /refusing non-scn_ target/);
  assert.equal(assertScnTarget('scn_app'), 'scn_app');
});

test('assertScnTarget takes the prefix from the config', () => {
  restoreExt();
  install({ dbPrefix: 'qa_' });
  assert.throws(() => assertScnTarget('scn_app'), /refusing non-qa_ target/);
  assert.equal(assertScnTarget('qa_app'), 'qa_app');
});

test('db.mjs re-exports dockerRun from the docker adapter', () => {
  assert.equal(dbModule.dockerRun, dockerRun);
});

// --- parseDbEntry ---

test('a string entry infers its dialect from the first token of the client', () => {
  assert.deepEqual(parseDbEntry('scn_app', 'app_db fakecli -uroot'), {
    db: 'scn_app', container: 'app_db', client: ['fakecli', '-uroot'], dialect: 'fake',
  });
});

test('a mapping entry that states its dialect skips the inference', () => {
  assert.deepEqual(parseDbEntry('scn_app', { container: 'app_db', client: 'unknowncli -x', dialect: 'fake' }), {
    db: 'scn_app', container: 'app_db', client: ['unknowncli', '-x'], dialect: 'fake',
  });
});

test('a mapping entry takes its client as an argv array too, and infers the dialect when none is stated', () => {
  assert.deepEqual(parseDbEntry('scn_app', { container: 'app_db', client: ['fakecli', '-uroot'] }), {
    db: 'scn_app', container: 'app_db', client: ['fakecli', '-uroot'], dialect: 'fake',
  });
});

test('a client no installed dialect claims is Blocked, naming the token and the remedies', () => {
  assert.throws(() => parseDbEntry('scn_app', 'app_db strangecli -uroot'),
    e => e instanceof Blocked
      && /"strangecli"/.test(e.message)
      && /State `dialect`/.test(e.message)
      && /\/scenario-matrix:setup --add <adapter>/.test(e.message));
});

test('an entry with no client is Blocked', () => {
  assert.throws(() => parseDbEntry('scn_app', 'app_db'), e => e instanceof Blocked && /needs "<container> <client...>"/.test(e.message));
  assert.throws(() => parseDbEntry('scn_app', { container: 'app_db' }), Blocked);
});

// --- sql, one, scalar ---

// assertScnTarget() is unit-tested above in isolation, which proves the guard works, not that sql()
// calls it. These two assert on the injected `run` seam, so they fail on any refactor that lets a
// non-scn target through to docker.
test('sql() refuses a non-scn target BEFORE anything reaches the docker runner', async () => {
  const reached = [];
  const run = async (args) => { reached.push(args); return ''; };
  const reg = { dbTarget: () => { throw new Error('dbTarget must not be consulted for a refused target'); } };
  await assert.rejects(() => sql(reg, 'local_app_main', 'DELETE FROM users', { run }), /refusing non-scn_ target/);
  assert.deepEqual(reached, [], 'no docker invocation may happen for a refused target');
});

test('sql() does reach the runner for a scn target, with the SQL piped on stdin', async () => {
  const reached = [];
  const run = async (args, stdin) => { reached.push({ args, stdin }); return 'id\n1\n'; };
  const reg = { dbTarget: target };
  const rows = await sql(reg, 'scn_app', 'SELECT id FROM t', { run });
  assert.deepEqual(rows, [{ id: '1' }]);
  assert.deepEqual(reached, [{
    args: ['exec', '-i', 'app_db', 'fakecli', '-uroot', 'scn_app', 'len=16'],
    stdin: 'SELECT id FROM t',
  }]);
});

test('sql() dispatches on the target dialect, so a missing dialect adapter is Blocked and names the adapter to add', async () => {
  restoreExt();
  restoreExt = __setForTest({ adapters: { docker: dockerAdapter, sql: sqlAdapter }, providers: { 'sql.fake': ['fake'] }, hooks: {}, config: {} });
  const run = async () => { throw new Error('must not reach docker'); };
  await assert.rejects(() => sql({ dbTarget: target }, 'scn_app', 'SELECT 1', { run }),
    e => e instanceof Blocked && /sql\.fake needs the fake adapter/.test(e.message));
});

// one()/scalar() reach the guard only transitively, through sql(). A future refactor that gives
// either its own query path would silently drop the guard for two thirds of the read levers.
test('one() and scalar() inherit the refusal, without reaching the runner either', async () => {
  const reached = [];
  const run = async (args) => { reached.push(args); return ''; };
  const reg = { dbTarget: () => { throw new Error('must not be consulted'); } };
  await assert.rejects(() => one(reg, 'ambient_app', 'SELECT 1', { run }), /refusing non-scn_ target/);
  await assert.rejects(() => scalar(reg, 'ambient_app', 'SELECT 1', { run }), /refusing non-scn_ target/);
  assert.deepEqual(reached, []);
});

test('one() is null for no row, the row for one, and a Ko for more than one', async () => {
  const reg = { dbTarget: target };
  const answer = raw => ({ run: async () => raw });
  assert.equal(await one(reg, 'scn_app', 'q', answer('id\n')), null);
  assert.deepEqual(await one(reg, 'scn_app', 'q', answer('id\n1\n')), { id: '1' });
  await assert.rejects(() => one(reg, 'scn_app', 'q', answer('id\n1\n2\n')), e => e instanceof Ko && /at most 1 row, got 2/.test(e.message));
});

test('scalar() is the first column of the row, or null', async () => {
  const reg = { dbTarget: target };
  assert.equal(await scalar(reg, 'scn_app', 'q', { run: async () => 'n\n7\n' }), '7');
  assert.equal(await scalar(reg, 'scn_app', 'q', { run: async () => 'n\n' }), null);
});
