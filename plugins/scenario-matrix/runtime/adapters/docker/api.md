## docker adapter

1. How is it stood up for real?

   The services under test run as containers, started by the project's own compose file or by its `lifecycle.up` command. The adapter adds nothing to start. It talks to the `docker` CLI on the host, so the CLI must be on `PATH` and its daemon reachable. When either is missing, every lever fails as Blocked, never as a product failure.

2. How do you know it is ready, without waiting a fixed time?

   For a container that was faulted, `stopFault` polls after `docker start` until the container answers. `fault_containers.<container>.ready_via` names the container that probes readiness of the faulted one. Docker itself does not read it: a database adapter registers the probe that does (through `addReadyProbe`), and that probe decides first for the containers it understands. For every other container docker alone judges: a container with a healthcheck is ready when docker reports it `healthy`, and one without is ready when docker reports it `running`. The wait ends at the first ready answer or after 60 seconds, and a container that never answers is Blocked.

3. What deterministic marker shows it processed something?

   A line in the container's log. `logs(reg, service, { grep })` returns the lines `docker logs` holds since the current attempt began, and `noLog(reg, service, pattern)` asserts that none matches. Print a unique token from the code path under test and grep for it, rather than counting lines.

4. How do you force it to fail and undo that?

   `dbFault(reg, container)` pauses the container and `stopFault(ctx, reg, container)` stops it. Both return `{ restore }`, and `stopFault` also registers its restore on `ctx.cleanups`, which `scenario()` runs on every exit path. A pause leaves the socket bound, so a client connects and then hangs. A stop removes the container from docker's DNS, so the client fails at once. Both are opt-in: the environment variable `SCN_ALLOW_CONTAINER_FAULT=1` must be set, the container must be named in `infra.env_registry` (`fault_containers`, or a container another adapter's registry names), and it must not be listed in `adapters.docker.sharedContainers`. A recovery is armed on process exit, SIGTERM and SIGINT, so a scenario that dies mid-fault does not leave the container paused or stopped.

5. What does it do that the others don't?

   It owns the docker process boundary. `dockerRun(args, stdin, opts)` is the one place the CLI is spawned, and it sorts failures: the daemon's own refusals (a stopped, removed or paused container, an unreachable daemon, a permission error on the socket) are Blocked, and every other non-zero exit stays an untyped error that reaches KO. `dockerRun(args, stdin, { timeoutMs })` kills a command still running at the limit and rejects untyped, because a hang says nothing about the environment. Another adapter that drives a client inside a container registers its own environment-failure text with `addEnvironmentFailure(re)`. It also supplies the `logSource.docker` driver, so any other adapter's container can be read as a log source.

### Registry keys

```yaml
infra:
  env_registry:
    log_sources:            # service name -> the container whose log it is
      web: { container: app-web }
    fault_containers:       # containers a fault may touch; ready_via names the probing container, optional
      app-queue: {}
      app-cache: { ready_via: app-probe }
```

`log_sources` entries become sources of kind `docker`. Both keys are validated when the registry loads.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `logs` | `logs(reg, service, { grep })` | Lines since the attempt began, merged from stdout and stderr, ANSI colour removed, sorted by timestamp. |
| `noLog` | `noLog(reg, service, pattern)` | Ko when a line matches. |
| `dbFault` | `dbFault(reg, container, opts)` | Pauses. `restore()` unpauses. |
| `stopFault` | `stopFault(ctx, reg, container, opts)` | Stops. `restore()` starts and waits for readiness. |

A log read with no slice start (the lever was called outside `scenario()`) is Inconclusive, never a whole-history read.

### Configuration

```json
{ "adapters": { "docker": { "sharedContainers": ["app-web"], "selftest": { "logSource": "web" } } } }
```

- `sharedContainers`: containers every service runs in. Both faults refuse them, because pausing one freezes every service and the row can no longer attribute what it sees. Default: none.
- `selftest.logSource`: a service name from `log_sources`. When set, `selftest.mjs` reads it as a probe. When null, that probe is skipped.

### Other contributions

- Lint: `docker-exec` rejects `spawn('docker', ...)` and `docker exec` in compiled scripts. Use a lever.
- Selftest: `docker logs: reads the configured source as lines`, and two `dbFault` refusal probes that never reach docker.
- Verify: `docker exec {container} test -e {path}` checks that an artifact exists inside a container.
