import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dockerAdapter from '../adapter-docker.mjs';
import * as sqlAdapter from '../adapter-sql.mjs';
import * as mysqlAdapter from '../adapter-mysql.mjs';
import { contributions, __setForTest } from '../ext.mjs';
import { reset } from '../reset.mjs';
import { Blocked } from '../errors.mjs';
import { installFakeDocker } from './support/fake-docker.mjs';

const ADAPTERS = { docker: dockerAdapter, sql: sqlAdapter, mysql: mysqlAdapter };
const RAW = { db: { scn_app: 'app_db mysql -uroot' } };
const reg = { raw: RAW, ...sqlAdapter.registry.accessors(RAW) };

let restoreExt;
const install = mysql => { restoreExt = __setForTest({ adapters: ADAPTERS, providers: {}, hooks: {}, config: { adapters: { mysql } } }); };
beforeEach(() => install({ sentinelDb: 'scn_app' }));
afterEach(() => restoreExt());

// A docker that logs every call with its stdin, and answers a SHOW TABLES with `shown`.
function fakeDocker(t, shown) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-reset-mysql-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.log');
  installFakeDocker(t, `in=$(cat)\nprintf 'CALL %s | %s\\n' "$*" "$in" >> ${JSON.stringify(log)}\ncase "$in" in *"SHOW TABLES"*) printf '${shown}';; esac`);
  return log;
}

const PLANT = 'CREATE TABLE IF NOT EXISTS scn_reset_probe (id INT)';
const CHECK = "SHOW TABLES LIKE 'scn_reset_probe'";

test('the sentinel is planted in prepare and checked in probe', async (t) => {
  const log = fakeDocker(t, '');
  const steps = contributions('reset');
  assert.deepEqual(steps.map(s => [s.phase, s.name, s.owner]), [['prepare', 'sentinel-plant', 'mysql'], ['probe', 'sentinel-check', 'mysql']]);
  await reset(reg, { baseline: async () => appendFileSync(log, 'BASELINE\n') });
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    `CALL exec -i app_db mysql -uroot scn_app | ${PLANT}`,
    'BASELINE',
    `CALL exec -i app_db mysql -uroot scn_app | ${CHECK}`,
  ]);
});

test('a sentinel that survives the restore is Blocked: a no-op restore is a broken environment', async (t) => {
  fakeDocker(t, 'Tables_in_scn_app (scn_reset_probe)\\nscn_reset_probe\\n');
  await assert.rejects(() => reset(reg, { baseline: async () => {} }),
    e => e instanceof Blocked && e.message === 'reset did not take effect: sentinel table survived the baseline restore');
});

test('a docker failure in a sentinel step is Blocked through the reset wrapper', async (t) => {
  installFakeDocker(t, "echo 'Error response from daemon: No such container: app_db' >&2; exit 1");
  await assert.rejects(() => reset(reg, { baseline: async () => {} }), e => e instanceof Blocked);
});

test('the sentinel steps are skipped without sentinelDb', async (t) => {
  restoreExt();
  install({ sentinelDb: null });
  const log = fakeDocker(t, 'scn_reset_probe\\n');
  await reset(reg, { baseline: async () => {} });
  assert.equal(existsSync(log), false, 'docker must not be reached when no sentinel database is configured');
});

test('the sentinel steps are skipped when the adapter has no config at all', async (t) => {
  restoreExt();
  restoreExt = __setForTest({ adapters: ADAPTERS, providers: {}, hooks: {}, config: {} });
  const log = fakeDocker(t, 'scn_reset_probe\\n');
  await reset(reg, { baseline: async () => {} });
  assert.equal(existsSync(log), false);
});
