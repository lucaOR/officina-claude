// Every lever that reaches the container runtime types what it throws: an untyped throw is reported
// as a product bug. This file pins the laravel adapter's side of that classification.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Blocked, Inconclusive } from '../errors.mjs';
import { dockerFailure } from '../docker.mjs';
import { tinker, SCN_GUARD_MARKER } from '../php.mjs';
import { __setForTest } from '../ext.mjs';

let restoreExt;
beforeEach(() => { restoreExt = __setForTest({ adapters: {}, providers: {}, hooks: {}, config: {} }); });
afterEach(() => restoreExt());

const reg = { execTarget: () => ({ container: 'app-web', workdir: '/srv/api', service: 'api' }) };

test('dockerFailure leaves a PHP fatal untyped -- the tinker guard depends on it', () => {
  const err = dockerFailure(['exec', '-i', 'app-web', 'sh', '-c', 'php artisan tinker /tmp/x.php'], 255,
    'PHP Fatal error:  Uncaught TypeError: Job::prune(): Argument #1 must be of type int');
  assert.equal(err instanceof Blocked, false);
  assert.match(err.message, /PHP Fatal error/);
});

test('dockerFailure leaves an unrecognised non-zero exit untyped -- the KO default is not weakened', () => {
  const err = dockerFailure(['exec', '-i', 'app-web', 'sh', '-c', 'php artisan app:x'], 1, 'The remote service could not be reached');
  assert.equal(err instanceof Blocked, false);
});

test("tinker() maps its own guard's refusal to Blocked, but leaves a PHP fatal a KO", async () => {
  const runRejectingWith = (message) => {
    let call = 0;
    return async () => {
      call += 1;
      if (call === 1) return ''; // the `cat > file` write succeeds
      throw new Error(message);
    };
  };

  await assert.rejects(
    () => tinker(reg, 'api', 'echo 1;', {
      run: runRejectingWith(`docker exec exited 1: ${SCN_GUARD_MARKER}: connection 'main' resolves to 'local_main'`),
    }),
    err => err instanceof Blocked,
  );

  // A genuine fatal inside the body says the code under test misbehaved. It must NOT be laundered
  // into Blocked, or a real bug disappears out of the KO count.
  await assert.rejects(
    () => tinker(reg, 'api', 'echo 1;', {
      run: runRejectingWith('docker exec exited 255: PHP Fatal error: Uncaught TypeError'),
    }),
    err => !(err instanceof Blocked) && !(err instanceof Inconclusive) && /PHP Fatal error/.test(err.message),
  );
});

test('tinker() removes its script file even when the body fails', async () => {
  const calls = [];
  const run = async args => {
    calls.push(String(args.at(-1)));
    if (calls.length === 2) throw new Error('exited 255: PHP Fatal error');
    return '';
  };
  await assert.rejects(() => tinker(reg, 'api', 'echo 1;', { run }));
  assert.match(calls.at(-1), /^rm -f \/tmp\/scn-tinker-/);
});
