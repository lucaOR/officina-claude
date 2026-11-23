import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerRun, isEnvironmentFailure, dockerFailure, addEnvironmentFailure } from '../docker.mjs';
import { Blocked } from '../errors.mjs';
import { installFakeDocker, removeDockerFromPath } from './support/fake-docker.mjs';

test('isEnvironmentFailure recognises the four docker daemon refusals', () => {
  assert.equal(isEnvironmentFailure('Error response from daemon: container 47e0 is not running'), true);
  assert.equal(isEnvironmentFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'), true);
  assert.equal(isEnvironmentFailure('No such container: app-web'), true);
  assert.equal(isEnvironmentFailure('permission denied while trying to connect to the Docker daemon socket'), true);
});

test('isEnvironmentFailure leaves anything else alone, including a missing or empty stderr', () => {
  assert.equal(isEnvironmentFailure("ERROR 1054: Unknown column 'source' in 'field list'"), false);
  assert.equal(isEnvironmentFailure('The service could not be reached'), false);
  assert.equal(isEnvironmentFailure(''), false);
  assert.equal(isEnvironmentFailure(undefined), false);
  assert.equal(isEnvironmentFailure(null), false);
});

test('dockerFailure types an environment failure Blocked and names the command, the code and stderr', () => {
  const err = dockerFailure(['exec', '-i', 'app-web', 'sh'], 1, 'Error response from daemon: No such container: app-web\n');
  assert.ok(err instanceof Blocked);
  assert.equal(err.message, 'docker exec -i app-web sh exited 1: Error response from daemon: No such container: app-web');
});

test('dockerFailure leaves an unrecognised failure as a plain Error, so it still reaches KO', () => {
  const err = dockerFailure(['exec', 'app-web', 'sh'], 3, 'boom\n');
  assert.equal(err instanceof Blocked, false);
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'docker exec app-web sh exited 3: boom');
});

test('addEnvironmentFailure lets another adapter classify its own client error as an environment failure', () => {
  const stderr = "ERROR 1049 (42000): Unknown database 'scn_x'";
  assert.equal(isEnvironmentFailure(stderr), false);
  assert.equal(dockerFailure(['exec', 'db', 'client'], 1, stderr) instanceof Blocked, false);
  addEnvironmentFailure(/Unknown database 'scn_/i);
  assert.equal(isEnvironmentFailure(stderr), true);
  assert.ok(dockerFailure(['exec', 'db', 'client'], 1, stderr) instanceof Blocked);
  // The docker patterns still apply, and an unrelated message is still not an environment failure.
  assert.equal(isEnvironmentFailure('No such container: db'), true);
  assert.equal(isEnvironmentFailure("Unknown column 'source'"), false);
});

test('dockerRun resolves the stdout of a successful command and pipes stdin through', async (t) => {
  installFakeDocker(t, 'printf "args:%s|" "$*"; cat');
  assert.equal(await dockerRun(['exec', '-i', 'app-web', 'sh'], 'hello'), 'args:exec -i app-web sh|hello');
});

test('dockerRun closes stdin when none is given, so a reading command does not hang', async (t) => {
  installFakeDocker(t, 'cat; printf done');
  assert.equal(await dockerRun(['ps']), 'done');
});

test('dockerRun rejects a daemon refusal as Blocked', async (t) => {
  installFakeDocker(t, 'echo "Error response from daemon: container abc is not running" >&2; exit 1');
  await assert.rejects(() => dockerRun(['exec', 'app-web', 'true']), err => err instanceof Blocked && /is not running/.test(err.message));
});

test('dockerRun rejects any other failure untyped', async (t) => {
  installFakeDocker(t, 'echo "the command failed" >&2; exit 2');
  await assert.rejects(() => dockerRun(['exec', 'app-web', 'false']),
    err => !(err instanceof Blocked) && err instanceof Error && /exited 2: the command failed/.test(err.message));
});

test('dockerRun reports a docker binary that cannot start as Blocked and keeps the cause', async (t) => {
  removeDockerFromPath(t);
  await assert.rejects(() => dockerRun(['ps']), err => err instanceof Blocked
    && /docker ps could not start/.test(err.message) && err.cause?.code === 'ENOENT');
});

test('a docker that exits without reading stdin rejects typed, never an uncaught EPIPE', async (t) => {
  // Exits 2 at once without reading stdin, so a 4 MiB write overflows the pipe buffer and fails with EPIPE.
  installFakeDocker(t, 'echo "the command failed" >&2; exit 2');
  const payload = 'x'.repeat(4 * 1024 * 1024);
  await assert.rejects(() => dockerRun(['exec', '-i', 'app-web', 'sh'], payload), err => {
    assert.notEqual(err.code, 'EPIPE');
    assert.ok(!(err instanceof Blocked));
    assert.ok(err instanceof Error);
    assert.match(err.message, /exited 2: the command failed/);
    return true;
  });
});

test('dockerRun with a timeout kills a hung command and rejects untyped, naming the limit', async (t) => {
  installFakeDocker(t, 'exec sleep 5');
  const started = Date.now();
  await assert.rejects(() => dockerRun(['exec', 'db', 'mysqldump'], undefined, { timeoutMs: 200 }),
    e => !(e instanceof Blocked) && /^docker exec db mysqldump timed out after 200ms/.test(e.message));
  assert.ok(Date.now() - started < 3000, 'the hung command was killed, not waited out');
});

test('dockerRun with a timeout resolves a command that finishes in time', async (t) => {
  installFakeDocker(t, 'cat');
  assert.equal(await dockerRun(['exec', 'db', 'mysql'], 'hello', { timeoutMs: 5000 }), 'hello');
});
