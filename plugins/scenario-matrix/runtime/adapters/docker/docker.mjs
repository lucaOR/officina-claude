// The docker process boundary: the one place that runs the docker CLI and decides which of its
// failures are the ENVIRONMENT failing and which are the system under test answering.
//
// This discrimination lives at the process boundary rather than at each call site because
// dockerRun is the single seam every environment-reaching lever goes through: typed here, a
// stopped container reaches BLOCKED from every lever alike, instead of only from the one that
// happened to wrap it.
//
// The list is deliberately narrow, because the over-correction is as wrong as the original
// defect: a blanket "any docker failure is Blocked" would launder real bugs out of the KO count.
// Every built-in entry is text the docker CLI writes about ITSELF, and none of it can be produced
// by the command running inside the container. An adapter whose client writes a similar
// statement about its own environment adds it through addEnvironmentFailure().
import { spawn } from 'node:child_process';
import { Blocked } from './errors.mjs';

const ENVIRONMENT_STDERR = [
  // The docker daemon's own refusals: container stopped, removed, renamed, or paused.
  // `docker exec` on a stopped container prints "Error response from daemon: Container <id> is not running".
  /Error response from daemon/i,
  /Cannot connect to the Docker daemon/i,
  // Some CLI paths (`docker pause`/`unpause`) print this without the prefix.
  /No such container/i,
  /permission denied while trying to connect to the Docker daemon/i,
];

// Patterns other adapters register, consulted after the docker ones.
const registered = [];

export function addEnvironmentFailure(re) {
  registered.push(re);
}

export function isEnvironmentFailure(stderr) {
  const text = String(stderr ?? '');
  return ENVIRONMENT_STDERR.some(re => re.test(text)) || registered.some(re => re.test(text));
}

// Exported for its own unit test: this function IS the classification, and the failure mode it
// guards is silent in both directions — an environment failure quietly reported as a product bug,
// or a product bug quietly laundered into BLOCKED and dropped from the count.
export function dockerFailure(args, code, stderr) {
  const message = `docker ${args.join(' ')} exited ${code}: ${String(stderr).trim()}`;
  if (isEnvironmentFailure(stderr)) return new Blocked(message);
  return new Error(message);
}

// `timeoutMs`, when given, kills a command still running at that limit (SIGKILL) and rejects at
// once. The rejection is untyped: a hung lock wait or dump says nothing about the environment.
export function dockerRun(args, stdin, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    let timer = null;
    const settle = (finish, value) => { clearTimeout(timer); finish(value); };
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`docker ${args.join(' ')} timed out after ${timeoutMs}ms${err.trim() ? `: ${err.trim()}` : ''}`));
      }, timeoutMs);
    }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    // The docker binary itself could not be started (absent, not on PATH, not executable).
    // Nothing ran, so nothing was learned: Blocked with no discrimination needed. `cause` keeps
    // the original errno for diagnosis.
    child.on('error', e => settle(reject, new Blocked(
      `docker ${args.join(' ')} could not start: ${e.message}`, { cause: e },
    )));
    child.on('close', code => code === 0
      ? settle(resolve, out)
      : settle(reject, dockerFailure(args, code, err)));
    // A stdin EPIPE only means docker stopped reading early; the close handler reports the outcome from the exit code.
    child.stdin.on('error', () => {});
    if (stdin !== undefined) { child.stdin.write(stdin); }
    child.stdin.end();
  });
}

// Readiness probes other adapters register. A probe is
// `probe(container, run, readyVia, reg) -> boolean | null | Promise<boolean | null>`, where null or
// undefined means "not mine". `readyVia` is the registry's name of the container that probes
// readiness of the faulted one. A probe that knows a client (for example a database adapter that
// pings through `readyVia`) claims the containers it understands and leaves the rest alone.
const readyProbes = [];

export function addReadyProbe(probe) {
  readyProbes.push(probe);
}

// Registered probes in registration order: the first non-null answer wins, null when none claims.
export async function registeredReady(container, run, readyVia, reg) {
  for (const probe of readyProbes) {
    const answer = await probe(container, run, readyVia, reg);
    if (answer !== null && answer !== undefined) return answer;
  }
  return null;
}

export function __resetReadyProbesForTest() {
  readyProbes.length = 0;
}
