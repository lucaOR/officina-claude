// The docker adapter's contribution module: the registry keys it reads, the drivers it provides
// (`logSource.docker`, `dbFault`, `stopFault`), its lint rule, its selftest probes and its
// artifact verifier. The keys of `drivers` equal the `drivers` array of adapter.json.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blocked, Inconclusive } from './errors.mjs';
import { adapterConfig } from './config.mjs';
import { contributions } from './ext.mjs';
import { logs, logSliceStart, markLogSlice } from './observe.mjs';
import { dockerRun, registeredReady } from './docker.mjs';
import { dbFault as dbFaultLever } from './fault.mjs';

export const name = 'docker';

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- registry: log_sources and fault_containers ---

export const registry = {
  keys: {
    log_sources: {
      validate(value) {
        if (!isMapping(value)) return 'must be a mapping of service name to { container }';
        for (const [service, entry] of Object.entries(value)) {
          if (!isMapping(entry) || typeof entry.container !== 'string' || entry.container === '') {
            return `${service} must be a mapping with a non-empty container name (container: <name>)`;
          }
        }
        return null;
      },
    },
    fault_containers: {
      validate(value) {
        if (!isMapping(value)) return 'must be a mapping of container name to { ready_via: <probing container name> }';
        for (const [container, entry] of Object.entries(value)) {
          if (!isMapping(entry)) return `${container} must be a mapping (an empty one is fine)`;
          if (entry.ready_via !== undefined && (typeof entry.ready_via !== 'string' || entry.ready_via === '')) {
            return `${container}.ready_via must be a non-empty container name (the container that probes readiness of ${container})`;
          }
        }
        return null;
      },
    },
  },
  logSources: raw => Object.fromEntries(Object.entries(raw?.log_sources ?? {})
    .map(([service, entry]) => [service, { kind: 'docker', container: entry?.container }])),
  // The containers this adapter puts inside the fault perimeter. Other adapters that name
  // containers contribute theirs through their own `containers`.
  containers: raw => Object.keys(raw?.fault_containers ?? {}),
  logSourceHint: 'log_sources maps a service to a docker container',
};

// Every container any installed adapter's registry names. A container outside this set is not part
// of the scenario perimeter at all, so faulting it can only be a mistake.
export function knownContainers(reg) {
  return new Set(contributions('registry').flatMap(c => c.value.containers?.(reg?.raw ?? {}) ?? []));
}

// --- logSource.docker ---

// Its own spawn rather than dockerRun, which keeps stdout only: `docker logs` replays a
// container's stderr on its own stderr, and many services log there. `-t` prefixes each line with
// the daemon's timestamp, so the two streams can be merged back into one ordered slice.
function dockerLogsCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => reject(new Blocked(`docker ${args.join(' ')} could not start: ${e.message}`, { cause: e })));
    child.on('close', code => (code === 0
      ? resolve(`${out}\n${err}`)
      : reject(new Blocked(`docker ${args.join(' ')} exited ${code}: ${err.trim()}`))));
  });
}

// Services that colour their console output would otherwise carry escape codes inside every grep
// target and every evidence file.
const ANSI = /\x1b\[[0-9;]*m/g;

// `opts.runDocker` is the testing seam for the spawn. The slice start comes from the core, which
// scenario() sets before each attempt, and `opts.grep` is ignored here because the core filters.
async function readDockerLog(reg, src, opts = {}) {
  const since = logSliceStart();
  if (!since) {
    throw new Inconclusive(`logs(${src.service}) has no slice start: a stdout log source is sliced by `
      + 'time, and only scenario() marks when the current attempt began');
  }
  const runDocker = opts.runDocker ?? dockerLogsCommand;
  const raw = await runDocker(['logs', '-t', '--since', since, src.container]);
  return raw.replace(ANSI, '').split('\n').filter(Boolean).sort().join('\n');
}

const logSourceDocker = {
  read: readDockerLog,
  async capture(reg, src, dir, opts = {}) {
    const lines = (await readDockerLog(reg, src, opts)).split('\n').filter(Boolean);
    writeFileSync(join(dir, `${src.service}.log`), lines.join('\n') + (lines.length ? '\n' : ''));
  },
};

// --- dbFault and stopFault: container faults ---

function defaultUnpauseSync(container) {
  spawnSync('docker', ['unpause', container]);
}

function defaultStartSync(container) {
  spawnSync('docker', ['start', container]);
}

const STATE_FORMAT = '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}';

// "Running" is not always "accepting work". Probes that other adapters registered through
// addReadyProbe() go first, because only they know a client that can ask the service itself; they
// receive `ready_via`, the name of the container that probes readiness of this one. When none
// claims the container, docker alone judges: a container with a healthcheck is ready when docker
// reports it healthy, and one without is ready when it is running. That fallback ignores `ready_via`.
async function defaultReadyProbe(container, run, readyVia, reg) {
  const claimed = await registeredReady(container, run, readyVia, reg);
  if (claimed !== null) return claimed;
  const out = await run(['inspect', '--format', STATE_FORMAT, container]);
  return /^(healthy|running)$/.test(String(out ?? '').trim());
}

export function defaultReraiseSignal(signal) {
  process.kill(process.pid, signal);
}

// The containers every service runs in, from the adapter config. Pausing or stopping one freezes
// every worker at once, so a row that "faults a service" through it can no longer attribute what
// it sees to the service under test. Read per call, so a config change is seen without a reload.
function refuseShared(lever, container) {
  const shared = new Set(adapterConfig('docker').sharedContainers ?? []);
  if (!shared.has(container)) return;
  throw new Blocked(
    `${lever}() refuses ${container}: it is shared by every service, so pausing or stopping it would `
    + 'freeze or stop every service and every worker. Fault one service instead: schemaFreeze() locks a '
    + 'single schema, and infra.env_registry.fault_containers names a container that fronts one service only',
  );
}

export function requireOptIn(lever) {
  if (process.env.SCN_ALLOW_CONTAINER_FAULT === '1') return;
  throw new Blocked(
    `${lever}() needs SCN_ALLOW_CONTAINER_FAULT=1 — container lifecycle requires explicit approval`,
  );
}

function requireKnown(lever, reg, container) {
  const known = knownContainers(reg);
  if (known.has(container)) return;
  throw new Blocked(
    `${lever}() refuses ${container}: not a container named by infra.env_registry `
    + `(known: ${[...known].sort().join(', ') || 'none'})`,
  );
}

// Arms the recovery that must survive a scenario which throws or calls process.exit() while a
// fault is live: 'exit' (cannot await, so `recoverSync` is synchronous) plus SIGTERM and SIGINT,
// whose default disposition ends the process WITHOUT running 'exit' handlers. SIGTERM is how a
// per-row timeout kills a hung child; SIGINT is an operator's Ctrl-C. Each signal handler
// recovers, restores the default disposition by removing itself, and re-raises its own signal so
// the process still dies the way its killer asked. `reraiseSignal` is a testing seam for that last
// step alone. Returns disarm().
export function armRecovery(recoverSync, reraiseSignal) {
  const onExit = () => recoverSync();
  const onSignal = signal => () => {
    recoverSync();
    process.removeListener(signal, handlers[signal]);
    reraiseSignal(signal);
  };
  const handlers = { SIGTERM: onSignal('SIGTERM'), SIGINT: onSignal('SIGINT') };
  process.on('exit', onExit);
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  return () => {
    process.removeListener('exit', onExit);
    for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler);
  };
}

// `run`, `unpauseSync` and `reraiseSignal` are testing seams: real callers pass only `reg` and a
// container name. Three gates stand between a scenario script and pausing a piece of the user's
// stack: the opt-in env var, the shared-container list, and the registry perimeter. The env var
// alone is not a perimeter, because once it is exported for a legitimate scenario ANY container
// name goes through. The registry check bounds the blast radius to containers the epic declares.
async function dbFault(reg, container, {
  run = dockerRun,
  unpauseSync = defaultUnpauseSync,
  reraiseSignal = defaultReraiseSignal,
} = {}) {
  requireOptIn('dbFault');
  refuseShared('dbFault', container);
  requireKnown('dbFault', reg, container);
  // Armed after the pause is issued but before anything else can throw: a scenario that dies
  // between here and restore() must not leave the container paused forever.
  await run(['pause', container]);
  const disarm = armRecovery(() => unpauseSync(container), reraiseSignal);
  return {
    restore: async () => {
      // Unpause FIRST, disarm second. If the unpause call rejects (flaky daemon, container removed
      // out-of-band), the exit safety net must still be standing afterwards: it is the one thing
      // left that can still recover the container.
      await run(['unpause', container]);
      disarm();
    },
  };
}

// Stops a container outright for the duration of one scenario, then brings it back AND WAITS FOR
// IT TO ANSWER before returning.
//
// Why not dbFault(): pausing freezes the processes but leaves the listening socket bound, so a
// client's connect() succeeds and the call then hangs until some timeout expires. `stop` removes
// the container from docker's DNS, so the failure is immediate and deterministic.
//
// Why the readiness wait is the point: `docker start` returns as soon as the container is RUNNING,
// which can be long before it accepts work. Without the probe, this lever hands the next scenario
// a service that is up but not answering, a failure that would land on THAT row with nothing in
// its output pointing back here.
//
// The restore is registered on ctx.cleanups (every scenario.mjs exit path) AND on exit/SIGTERM/
// SIGINT, because cleanups cover a scenario that fails and signals cover a timeout kill or Ctrl-C,
// and neither covers the other.
async function stopFault(ctx, reg, container, {
  run = dockerRun,
  startSync = defaultStartSync,
  reraiseSignal = defaultReraiseSignal,
  readyProbe = defaultReadyProbe,
  readyTimeoutMs = 60000,
} = {}) {
  requireOptIn('stopFault');
  refuseShared('stopFault', container);
  requireKnown('stopFault', reg, container);

  // Armed BEFORE the stop, so a failure inside `docker stop` itself (partial stop, flaky daemon)
  // still leaves a recovery path standing.
  const disarm = armRecovery(() => startSync(container), reraiseSignal);
  const readyVia = reg.raw?.fault_containers?.[container]?.ready_via;

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await run(['start', container]);
    const deadline = Date.now() + readyTimeoutMs;
    let lastError = 'never probed';
    while (Date.now() < deadline) {
      const ready = await readyProbe(container, run, readyVia, reg).catch(err => {
        lastError = err?.message ?? String(err);
        return false;
      });
      if (ready) {
        disarm();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Deliberately NOT disarming the exit handlers here: the container is back but not answering,
    // and that safety net is the only thing left that might help. Blocked, not Ko: a container
    // that will not come back says nothing about the product.
    throw new Blocked(
      `${container} was restarted after this scenario's fault but never accepted a connection within `
      + `${readyTimeoutMs}ms (last probe: ${lastError}). Every scenario after this one would fail on a `
      + 'service that is running but not answering',
    );
  };

  ctx.cleanups.push(restore);
  await run(['stop', container]);
  return { restore };
}

export const drivers = {
  'logSource.docker': logSourceDocker,
  dbFault,
  stopFault,
};

// --- lint ---

export const lint = [
  { id: 'docker-exec', kind: 'code', re: /['"]docker['"]\s*,|docker\s+exec/, msg: 'raw docker exec — use a lib lever' },
];

// --- selftest ---

const PROBE_CONTAINER = 'scn-selftest-not-a-real-container';

// Runs `fn` with SCN_ALLOW_CONTAINER_FAULT set to `value` (unset when undefined) and puts the
// variable back as it found it.
async function withFaultFlag(value, fn) {
  const key = 'SCN_ALLOW_CONTAINER_FAULT';
  const saved = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
}

// The refusal probes can never reach docker: the container named is not a real one, and the gate
// under test fires before anything is spawned. The pause path itself is never exercised here,
// because pausing a real container would freeze someone's stack.
const refusalProbe = (flag, pattern) => reg => withFaultFlag(flag, async () => {
  try {
    await dbFaultLever(reg, PROBE_CONTAINER);
    return false;
  } catch (e) {
    return pattern.test(e.message);
  }
});

export const selftest = [
  {
    name: 'docker logs: reads the configured source as lines',
    needs: ['adapters.docker.selftest.logSource'],
    run: async (reg, cfg) => {
      markLogSlice();
      return Array.isArray(await logs(reg, cfg.adapters.docker.selftest.logSource));
    },
  },
  {
    name: 'dbFault: refuses without the explicit opt-in env var',
    needs: [],
    run: refusalProbe(undefined, /SCN_ALLOW_CONTAINER_FAULT/),
  },
  {
    // `reg` is load-bearing: the registry gate is the second of dbFault()'s gates, and with the
    // opt-in given it is the one that refuses this container name.
    name: 'dbFault: refuses a container the registry does not name',
    needs: [],
    run: refusalProbe('1', /refuses scn-selftest-not-a-real-container: not a container named by infra\.env_registry/),
  },
];

// --- verify ---

export const verify = { command: 'docker exec {container} test -e {path}' };
