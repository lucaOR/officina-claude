// Every lever that reaches the database has to type what it throws: an untyped throw is reported as a
// product bug. This file pins the sql adapter's side of that classification.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ko, Blocked, Inconclusive } from '../errors.mjs';
import { assertScnTarget, sql, one, parseRows } from '../db.mjs';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';
import { loadRegistryFromPath } from '../registry.mjs';
import { __setForTest } from '../ext.mjs';

const dialectAdapter = { name: 'fake', drivers: { 'sql.fake': { clients: /^fakecli$/, args: () => [], parse: parseRows } } };
let restoreExt;
beforeEach(() => {
  restoreExt = __setForTest({ adapters: { docker: dockerAdapter, sql: sqlAdapter, fake: dialectAdapter }, providers: {}, hooks: {}, config: {} });
});
afterEach(() => restoreExt());

function registryFrom(t, db) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-classification-sql-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'epic.yaml');
  writeFileSync(path, `epic: epic\ninfra:\n  env_registry:\n    db:\n${db}\nscenarios: []\n`);
  return loadRegistryFromPath(path, 'epic');
}

test('assertScnTarget refuses with Blocked: the guard succeeding is not a product bug', () => {
  assert.throws(() => assertScnTarget('ambient_app'), err => err instanceof Blocked);
});

test('a db target the registry does not know is Blocked, not KO', (t) => {
  const reg = registryFrom(t, '      scn_app: "app_db fakecli -uroot"');
  assert.throws(() => reg.dbTarget('scn_missing'), err => err instanceof Blocked && /unknown db target/.test(err.message));
});

test('a malformed db entry is Blocked', (t) => {
  assert.throws(() => registryFrom(t, '      scn_app: "app_db"'), err => err instanceof Blocked && /infra\.env_registry\.db/.test(err.message));
});

test('a client no installed adapter drives is Blocked when the target is read', (t) => {
  const reg = registryFrom(t, '      scn_app: "app_db strangecli -uroot"');
  assert.throws(() => reg.dbTarget('scn_app'), err => err instanceof Blocked && /strangecli/.test(err.message));
});

test('a dialect adapter that is not installed is Blocked, never a product KO', async (t) => {
  const reg = registryFrom(t, '      scn_app: { container: app_db, client: "x", dialect: absent }');
  await assert.rejects(() => sql(reg, 'scn_app', 'SELECT 1', { run: async () => '' }), err => err instanceof Blocked);
});

test('a runner failure the docker boundary typed passes through sql() as Blocked', async (t) => {
  const reg = registryFrom(t, '      scn_app: "app_db fakecli -uroot"');
  const run = async () => { throw new Blocked('docker exec exited 1: No such container: app_db'); };
  await assert.rejects(() => sql(reg, 'scn_app', 'SELECT 1', { run }), err => err instanceof Blocked);
});

test('a runner failure about the data stays untyped, so it still reaches KO', async (t) => {
  const reg = registryFrom(t, '      scn_app: "app_db fakecli -uroot"');
  const run = async () => { throw new Error("docker exec exited 1: ERROR 1054: Unknown column 'source'"); };
  await assert.rejects(() => sql(reg, 'scn_app', 'SELECT 1', { run }),
    err => !(err instanceof Blocked) && !(err instanceof Inconclusive) && err instanceof Error);
});

test('one() with too many rows is a Ko: the database answered, and it is the data that is wrong', async (t) => {
  const reg = registryFrom(t, '      scn_app: "app_db fakecli -uroot"');
  await assert.rejects(() => one(reg, 'scn_app', 'SELECT 1', { run: async () => 'id\n1\n2\n' }), err => err instanceof Ko);
});
