// The mysql adapter classifies its own client's failures at the docker process boundary. Both
// directions are asserted, because over-correcting is as damaging as the defect: a blanket Blocked
// would drop real product failures out of the KO count silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blocked, Inconclusive } from '../errors.mjs';
import { dockerFailure, isEnvironmentFailure } from '../docker.mjs';
import '../adapter-mysql.mjs';

test('dockerFailure types an ABSENT scn_ database as Blocked: the stack was never provisioned', () => {
  // The target is the harness's own registry argument, which the guard has already proved starts
  // with the prefix, so its absence can only mean the scenario stack is not up. Never a product signal.
  const err = dockerFailure(['exec', '-i', 'app_db', 'mysql', '-uroot', 'scn_app'], 1,
    "ERROR 1049 (42000): Unknown database 'scn_app'");
  assert.ok(err instanceof Blocked);
});

test('the absent-database text is matched without regard to case', () => {
  assert.equal(isEnvironmentFailure("error 1049 (42000): UNKNOWN DATABASE 'SCN_APP'"), true);
});

test('an absent database OUTSIDE the prefix stays untyped: a database the product failed to create cannot launder itself out of KO', () => {
  const err = dockerFailure(['exec', '-i', 'app_db', 'mysql', '-uroot', 'scn_app'], 1,
    "ERROR 1049 (42000): Unknown database 'app_created_by_the_product'");
  assert.equal(err instanceof Blocked, false);
  assert.ok(err instanceof Error);
});

test('dockerFailure leaves an error about the DATA untyped, so it still reaches KO', () => {
  // The named counter-example: the migration that should have added `source` did not run. Moving this
  // into Blocked would delete a real bug from the KO count.
  const err = dockerFailure(['exec', '-i', 'app_db', 'mysql', '-uroot', 'scn_app'], 1,
    "ERROR 1054 (42S22) at line 1: Unknown column 'source' in 'field list'");
  assert.equal(err instanceof Blocked, false);
  assert.equal(err instanceof Inconclusive, false);
  assert.ok(err instanceof Error);
});

test('the docker daemon refusals still type Blocked next to the registered text', () => {
  assert.ok(dockerFailure(['exec', '-i', 'app_db', 'mysql'], 1, 'Error response from daemon: No such container: app_db\n') instanceof Blocked);
});
