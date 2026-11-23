import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';
import * as mysqlAdapter from '../adapter-mysql.mjs';
import { collectProbes } from '../selftest.mjs';
import { __setForTest } from '../ext.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

const RAW = { db: { scn_app: 'app_db mysql -uroot' } };
const reg = { raw: RAW, ...sqlAdapter.registry.accessors(RAW) };

let restoreExt;
const install = config => { restoreExt = __setForTest({ adapters: { docker: dockerAdapter, sql: sqlAdapter, mysql: mysqlAdapter }, providers: {}, hooks: {}, config }); };
beforeEach(() => install({}));
afterEach(() => restoreExt());

const probes = cfg => collectProbes(reg, cfg).filter(p => p.owner === 'mysql');

test('the adapter contributes the two sql probes under their established names', () => {
  assert.deepEqual(probes({}).map(p => p.name), ['sql: positive', 'sql: guard refuses a dev database']);
});

test('the positive probe needs a configured selftest database, the guard probe needs none', () => {
  const [positive, guard] = probes({});
  assert.equal(positive.missing, 'adapters.mysql.selftest.db');
  assert.equal(guard.missing, undefined);
});

test('the positive probe runs once the database is configured', (t) => {
  const cfg = { adapters: { mysql: { selftest: { db: 'scn_app' } } } };
  assert.equal(probes(cfg)[0].missing, undefined);
  installFakeDocker(t, "cat >/dev/null; printf '1\\n1\\n'");
  return probes(cfg)[0].run(reg, cfg).then(ok => assert.equal(ok, true));
});

test('the guard probe passes because the guard refuses, and never reaches docker', async (t) => {
  installFakeDocker(t, 'echo reached >&2; exit 99');
  assert.equal(await probes({})[1].run(reg, {}), true);
});
