// A stub that cannot start must fail its test quickly. Before bootStub raced the child's exit and a
// deadline, a stub that died on EADDRINUSE left the test file waiting for a ready line that would
// never come.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { LIB } from '../paths.mjs';
import { bootStub, freePort } from './support/stub-process.mjs';

const GENERIC_STUB = join(LIB, 'test/fixtures/generic-stub.mjs');
const NEVER_READY = join(LIB, 'test/fixtures/never-ready.mjs');

test('bootStub rejects with the stub\'s EADDRINUSE when its port is already taken', { timeout: 15_000 }, async () => {
  const occupant = net.createServer().listen(0, '127.0.0.1');
  await once(occupant, 'listening');
  const { port } = occupant.address();
  try {
    await assert.rejects(bootStub(GENERIC_STUB, port, {}, { timeoutMs: 10_000 }), (err) => {
      assert.match(err.message, /exited/);
      assert.match(err.message, /EADDRINUSE/);
      return true;
    });
  } finally {
    occupant.close();
  }
});

test('bootStub rejects after timeoutMs when the child stays up without a ready line', { timeout: 15_000 }, async () => {
  const port = await freePort();
  await assert.rejects(bootStub(NEVER_READY, port, {}, { timeoutMs: 300 }), /no ready line/);
});

test('freePort returns a port a stub boots and answers on', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const child = await bootStub(GENERIC_STUB, port);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/__scn/requests`)).status, 200);
  } finally {
    child.kill('SIGKILL');
  }
});
