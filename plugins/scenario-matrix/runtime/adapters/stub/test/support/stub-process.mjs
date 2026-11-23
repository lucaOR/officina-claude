// Spawns a stub server for a unit test and waits for its first stdout line.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

// Resolves with the child on its first stdout chunk. Rejects when the child
// closes first, for example on EADDRINUSE, or when no chunk arrives within
// timeoutMs; the error carries the end of the child's stderr. Waiting on stdout
// alone hung the test file for good whenever the stub died before printing.
export function bootStub(path, port, env = {}, { timeoutMs = 10_000 } = {}) {
  const child = spawn(process.execPath, [path], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  const where = `${path} on :${port}`;

  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onReady);
      child.off('close', onClose);
      fn(value);
    };
    const onReady = () => settle(resolve, child);
    // 'close' rather than 'exit': it fires after stderr is drained, so the
    // message holds the child's whole error.
    const onClose = (code, signal) => settle(reject, new Error(
      `${where} exited (code=${code} signal=${signal}) before its ready line; stderr: ${stderr.trim()}`));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(reject, new Error(`${where} printed no ready line within ${timeoutMs}ms; stderr: ${stderr.trim()}`));
    }, timeoutMs);
    child.stdout.on('data', onReady);
    child.once('close', onClose);
  });
}

// Asks the OS for a free port, releases it, and returns the number. Hardcoded
// test ports sat inside this machine's ephemeral range (36430-40525), so any
// process listening on an OS-assigned port could already hold one of them.
// The port can still be taken between close() and the stub's listen(); if that
// happens, bootStub rejects quickly instead of hanging.
export async function freePort() {
  const server = net.createServer().listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}
