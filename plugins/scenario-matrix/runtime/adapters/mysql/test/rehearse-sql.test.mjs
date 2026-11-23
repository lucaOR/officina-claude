// The setup-SQL rehearsal. The pure parts are tested directly, the docker calls through an injected
// runner, and the CLI through a fake docker on PATH.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectStatements, isDdl, cloneName, buildBatch, runGroup, rehearse } from '../rehearse-sql.mjs';
import { __setForTest } from '../ext.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'rehearse-sql.mjs');

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ config: {} }); });
afterEach(() => restoreExt());

const setup = (target, statement) => ({ db: { target, sql: statement } });
const mutate = (target, statement) => ({ mutate: { db: { target, sql: statement } } });
const MATRIX = {
  infra: { env_registry: { db: { scn_app: 'app_db mysql -uroot', scn_admin: 'admin_db mysql -uroot' } } },
  scenarios: [
    { id: 'A-01', setup: [setup('scn_app', 'INSERT INTO t VALUES (1)'), setup('scn_app', 'INSERT INTO u VALUES (1)'), setup('scn_admin', 'INSERT INTO v VALUES (1)')] },
    { id: 'A-02', setup: [setup('scn_app', 'ALTER TABLE t ADD c INT')], steps: [{ note: 'no mutate here' }, mutate('scn_app', 'UPDATE t SET c = 1')] },
    { id: 'B-01', setup: [setup('scn_app', 'INSERT INTO t VALUES (2)')], steps: [mutate('scn_admin', 'DELETE FROM v')] },
    { id: 'AB-01', setup: [setup('scn_app', 'INSERT INTO t VALUES (3)')] },
  ],
};

test('isDdl is true for the statements that commit implicitly, whatever their case or leading noise', () => {
  for (const s of ['ALTER TABLE t ADD c INT', 'create table t (id int)', 'DROP TABLE t', 'TRUNCATE t', 'RENAME TABLE a TO b',
    'LOCK TABLES t WRITE', 'GRANT ALL ON x TO y', 'START   TRANSACTION', 'BEGIN', 'COMMIT', 'SET AUTOCOMMIT = 0', 'LOAD DATA INFILE x',
    '  -- a comment\n  ALTER TABLE t ADD c INT', '/* note */ DROP TABLE t', '# hash comment\nCREATE TABLE t (id int)']) {
    assert.equal(isDdl(s), true, s);
  }
});

test('isDdl is false for plain DML, and for a keyword that is only a prefix of a word', () => {
  for (const s of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'SELECT 1', 'REPLACE INTO t VALUES (1)', 'CREATED_AT', 'ALTERNATE x', '']) {
    assert.equal(isDdl(s), false, s);
  }
});

test('cloneName keeps the prefix', () => {
  assert.equal(cloneName('scn_app'), 'scn_rh_app');
  assert.equal(cloneName('plain'), 'scn_rh_plain', 'a name without the prefix gets the whole clone prefix');
  restoreExt();
  restoreExt = __setForTest({ config: { dbPrefix: 'qa_' } });
  assert.equal(cloneName('qa_app'), 'qa_rh_app');
});

test('collectStatements groups a scenario setup by target, in matrix order', () => {
  const { groups, scenarios, ops } = collectStatements(MATRIX, {});
  assert.equal(scenarios, 4);
  assert.equal(ops, 6);
  assert.deepEqual(groups.filter(g => g.id === 'A-01').map(g => [g.kind, g.target, g.statements]), [
    ['setup', 'scn_app', ['INSERT INTO t VALUES (1)', 'INSERT INTO u VALUES (1)']],
    ['setup', 'scn_admin', ['INSERT INTO v VALUES (1)']],
  ]);
});

test('--family filters rows', () => {
  const ids = family => [...new Set(collectStatements(MATRIX, { family }).groups.map(g => g.id))];
  assert.deepEqual(ids('A'), ['A-01', 'A-02'], 'the family prefix needs its dash: AB-01 is another family');
  assert.deepEqual(ids('AB'), ['AB-01']);
  assert.deepEqual(ids('A-01'), ['A-01'], 'a whole id selects itself');
  assert.equal(collectStatements(MATRIX, { family: 'A' }).scenarios, 2);
  assert.equal(collectStatements(MATRIX, { family: 'Z' }).scenarios, 0);
});

test('--mutates includes step mutations, with the same-target setup replayed first', () => {
  const without = collectStatements(MATRIX, {});
  assert.equal(without.groups.some(g => g.kind === 'mutate'), false);
  const { groups, ops } = collectStatements(MATRIX, { mutates: true });
  assert.equal(ops, 8, 'the replayed setup does not count as extra ops');
  assert.deepEqual(groups.filter(g => g.kind === 'mutate').map(g => [g.id, g.target, g.statements]), [
    ['A-02', 'scn_app', ['ALTER TABLE t ADD c INT', 'UPDATE t SET c = 1']],
    ['B-01', 'scn_admin', ['DELETE FROM v']],
  ]);
});

test('a scenario with no setup and no steps contributes no group', () => {
  assert.deepEqual(collectStatements({ scenarios: [{ id: 'X-01' }] }, { mutates: true }).groups, []);
});

test('buildBatch puts the delimiter on its own line, so a trailing comment cannot swallow it', () => {
  assert.equal(buildBatch('scn_app', ['SELECT 1; -- trailing', 'SELECT 2'], true),
    'START TRANSACTION;\nUSE `scn_app`;\nDELIMITER $$\nSELECT 1; -- trailing\n$$\nSELECT 2\n$$\nDELIMITER ;\nROLLBACK;');
  assert.equal(buildBatch('scn_rh_app', ['SELECT 1'], false), 'USE `scn_rh_app`;\nDELIMITER $$\nSELECT 1\n$$\nDELIMITER ;\n');
});

// The db entry a group runs against, as parseDbEntry() returns it.
const APP = { db: 'scn_app', container: 'app_db', client: ['mysql', '-uroot'] };

function recorder(failWhen = () => false, failure = 'ERROR 1054 (42S22) at line 3: Unknown column') {
  const calls = [];
  const run = async (args, stdin, opts) => {
    calls.push({ args, stdin, opts });
    if (failWhen(args, stdin)) throw new Error(`docker exec exited 1: ${failure}`);
    return '';
  };
  return { calls, run };
}

test('DML statements group into a rolled-back transaction on the real target', async () => {
  const { calls, run } = recorder();
  const result = await runGroup(run, APP, ['INSERT INTO t VALUES (1)']);
  assert.deepEqual(result, { ok: true, err: '', cloned: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['exec', '-i', 'app_db', 'mysql', '-uroot']);
  assert.match(calls[0].stdin, /^START TRANSACTION;\nUSE `scn_app`;/);
  assert.match(calls[0].stdin, /ROLLBACK;$/);
});

test('DDL statements group into a clone, which is filled from the target and always dropped', async () => {
  const { calls, run } = recorder();
  const result = await runGroup(run, APP, ['INSERT INTO t VALUES (1)', 'ALTER TABLE t ADD c INT']);
  assert.deepEqual(result, { ok: true, err: '', cloned: true });
  assert.equal(calls.length, 4);
  assert.equal(calls[0].stdin, 'DROP DATABASE IF EXISTS `scn_rh_app`;\nCREATE DATABASE `scn_rh_app`;');
  assert.deepEqual(calls[1].args.slice(0, 7), ['exec', 'app_db', 'bash', '-o', 'pipefail', '-c', calls[1].args[6]]);
  assert.equal(calls[1].args[6],
    "mysqldump -uroot --routines --triggers --single-transaction 'scn_app' | mysql -uroot 'scn_rh_app'");
  assert.match(calls[2].stdin, /^USE `scn_rh_app`;/);
  assert.equal(calls[2].stdin.includes('START TRANSACTION'), false, 'the clone is thrown away, so no rollback wrapper');
  assert.equal(calls[3].stdin, 'DROP DATABASE IF EXISTS `scn_rh_app`;');
});

test('a clone that fails to fill is reported and still dropped', async () => {
  const { calls, run } = recorder(args => args[2] === 'bash');
  const result = await runGroup(run, APP, ['DROP TABLE t']);
  assert.equal(result.ok, false);
  assert.match(result.err, /^clone fill failed: /);
  assert.equal(calls.at(-1).stdin, 'DROP DATABASE IF EXISTS `scn_rh_app`;');
});

test('a DDL group that names the real target qualified is refused without touching docker for the batch', async () => {
  const { calls, run } = recorder();
  const result = await runGroup(run, APP, ['ALTER TABLE `scn_app`.t ADD c INT']);
  assert.equal(result.ok, false);
  assert.match(result.err, /names the real target 'scn_app' qualified; it would escape the throwaway clone/);
  assert.deepEqual(calls, [], 'the refusal comes before the clone is created');
});

test('a statement error is reported as its ERROR line', async () => {
  const { run } = recorder((args, stdin) => /START TRANSACTION/.test(stdin ?? ''));
  const result = await runGroup(run, APP, ['INSERT INTO t (nope) VALUES (1)']);
  assert.deepEqual(result, { ok: false, err: 'ERROR 1054 (42S22) at line 3: Unknown column', cloned: false });
});

test('a failed drop of the clone warns, naming the clone', async () => {
  const warnings = [];
  const { run } = recorder((args, stdin) => stdin === 'DROP DATABASE IF EXISTS `scn_rh_app`;', 'ERROR 1010 cannot drop');
  await runGroup(run, APP, ['DROP TABLE t'], { warn: m => warnings.push(m) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WARNING: could not drop the throwaway clone scn_rh_app in app_db \(ERROR 1010 cannot drop\)/);
  assert.match(warnings[0], /a leftover scn_rh_\* database is safe to drop by hand/);
});

test('a group runs through the db entry\'s own client, and the clone is dumped and filled with its credentials', async () => {
  const { calls, run } = recorder();
  const secured = { db: 'scn_app', container: 'app_db', client: ['mysql', '-uroot', '-ps3cr et'] };
  await runGroup(run, secured, ['INSERT INTO t VALUES (1)']);
  assert.deepEqual(calls[0].args, ['exec', '-i', 'app_db', 'mysql', '-uroot', '-ps3cr et']);
  calls.length = 0;
  await runGroup(run, secured, ['ALTER TABLE t ADD c INT']);
  assert.deepEqual(calls[0].args, ['exec', '-i', 'app_db', 'mysql', '-uroot', '-ps3cr et']);
  assert.equal(calls[1].args[6],
    "mysqldump -uroot '-ps3cr et' --routines --triggers --single-transaction 'scn_app' | mysql -uroot '-ps3cr et' 'scn_rh_app'");
  calls.length = 0;
  await runGroup(run, { db: 'scn_app', container: 'app_db', client: ['mariadb', '--user=root', '--password=pw'] }, ['DROP TABLE t']);
  assert.equal(calls[1].args[6],
    "mariadb-dump --user=root --password=pw --routines --triggers --single-transaction 'scn_app' | mariadb --user=root --password=pw 'scn_rh_app'");
});

test('every docker call has a timeout: 30 seconds for the client, 10 minutes for the clone fill', async () => {
  const { calls, run } = recorder();
  await runGroup(run, APP, ['INSERT INTO t VALUES (1)', 'ALTER TABLE t ADD c INT']);
  assert.deepEqual(calls.map(c => c.opts?.timeoutMs), [30000, 600000, 30000, 30000]);
  calls.length = 0;
  await runGroup(run, APP, ['INSERT INTO t VALUES (1)']);
  assert.deepEqual(calls.map(c => c.opts?.timeoutMs), [30000]);
});

test('a group whose target lacks the db prefix fails before any docker call', async () => {
  const { calls, run } = recorder();
  const matrix = {
    infra: { env_registry: { db: { scn_app: 'app_db mysql -uroot', app_dev: 'app_db mysql -uroot' } } },
    scenarios: [{ id: 'D-01', setup: [setup('app_dev', 'DELETE FROM users'), setup('app_dev', 'ALTER TABLE users ADD c INT')], steps: [mutate('app_dev', 'DELETE FROM users')] }],
  };
  const result = await rehearse(matrix, { run, mutates: true });
  assert.deepEqual([...result.failures], [['D-01', [['setup', 'app_dev', 'refusing non-scn_ target: app_dev'], ['mutate', 'app_dev', 'refusing non-scn_ target: app_dev']]]]);
  assert.deepEqual(calls, [], 'nothing reached docker');
  const direct = await runGroup(run, { ...APP, db: 'app_dev' }, ['DELETE FROM users']);
  assert.deepEqual(direct, { ok: false, err: 'refusing non-scn_ target: app_dev', cloned: false });
  assert.deepEqual(calls, []);
});

test('the prefix guard runs before the db entry is looked up, so a missing entry cannot mask it', async () => {
  const { calls, run } = recorder();
  const matrix = { infra: MATRIX.infra, scenarios: [{ id: 'D-02', setup: [setup('prod_db', 'DELETE FROM users')] }] };
  const result = await rehearse(matrix, { run });
  assert.deepEqual([...result.failures], [['D-02', [['setup', 'prod_db', 'refusing non-scn_ target: prod_db']]]]);
  assert.deepEqual(calls, []);
});

test('rehearse counts, runs each group, and collects the failures per scenario', async () => {
  const { calls, run } = recorder((args, stdin) => /INSERT INTO v/.test(stdin ?? ''));
  const result = await rehearse(MATRIX, { run, mutates: false });
  assert.equal(result.opCount, 6);
  assert.equal(result.scnCount, 4);
  assert.deepEqual(result.cloneRuns, ['A-02']);
  assert.deepEqual([...result.failures], [['A-01', [['setup', 'scn_admin', 'ERROR 1054 (42S22) at line 3: Unknown column']]]]);
  assert.ok(calls.some(c => c.args[2] === 'admin_db'), 'each target runs in its own container');
});

test('rehearse names a target with no db entry as a failure instead of running it', async () => {
  const { calls, run } = recorder();
  const matrix = { infra: MATRIX.infra, scenarios: [{ id: 'C-01', setup: [setup('scn_gone', 'INSERT INTO t VALUES (1)')] }] };
  const result = await rehearse(matrix, { run });
  assert.deepEqual([...result.failures], [['C-01', [['setup', 'scn_gone', "no env_registry.db entry for 'scn_gone'"]]]]);
  assert.deepEqual(calls, []);
});

// --- the CLI ---

function cli(t, matrixYaml, args, dockerBody) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-rehearse-sql-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'matrix.yaml');
  writeFileSync(path, matrixYaml);
  installFakeDocker(t, dockerBody);
  return spawnSync(process.execPath, [CLI, path, ...args], { encoding: 'utf8', env: process.env });
}

const YAML_OK = `epic: demo
infra:
  env_registry:
    db:
      scn_app: "app_db mysql -uroot"
scenarios:
  - id: A-01
    setup:
      - db: { target: scn_app, sql: "INSERT INTO t VALUES (1)" }
  - id: A-02
    setup:
      - db: { target: scn_app, sql: "ALTER TABLE t ADD c INT" }
`;

test('the CLI prints a summary and ALL GREEN, and exits 0', (t) => {
  const r = cli(t, YAML_OK, [], 'cat >/dev/null');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout,
    'rehearsed 2 db ops across 2 scenarios (setup only); 1 scenario(s) with DDL ran on a throwaway clone: A-02\n'
    + 'ALL GREEN — every setup SQL executes against real schema\n');
});

test('the CLI lists each failing scenario and exits 1', (t) => {
  const r = cli(t, YAML_OK, ['--family', 'A-01'], "cat >/dev/null; echo 'ERROR 1054 (42S22): Unknown column' >&2; exit 1");
  assert.equal(r.status, 1);
  assert.equal(r.stdout,
    'rehearsed 1 db ops across 1 scenarios (setup only)\n'
    + '\n1 scenarios have setup-SQL errors:\n\n'
    + '  A-01 [setup scn_app]: ERROR 1054 (42S22): Unknown column\n');
});

test('the CLI says so on stderr and exits 2 when the matrix has no db map', (t) => {
  const r = cli(t, 'epic: demo\ninfra:\n  env_registry:\n    hosts: {}\nscenarios: []\n', [], 'cat >/dev/null');
  assert.equal(r.status, 2);
  assert.equal(r.stderr, 'no infra.env_registry.db map — cannot rehearse\n');
  assert.equal(r.stdout, '');
});

test('the CLI marks the summary when mutates are included', (t) => {
  const r = cli(t, YAML_OK, ['--mutates'], 'cat >/dev/null');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^rehearsed 2 db ops across 2 scenarios \(incl\. mutates\);/);
});

test('the CLI with no matrix path is a usage error', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage: rehearse-sql\.mjs <matrix\.yaml>/);
});
