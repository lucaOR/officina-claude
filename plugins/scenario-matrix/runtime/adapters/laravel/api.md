## laravel adapter

1. How is it stood up for real?

   The application runs in a container, started by the project's own compose file or by its `lifecycle.up` command. The adapter adds nothing to start. It reaches the application with `docker exec` into the container named by an `infra.env_registry.exec` entry, so the `docker` CLI must be on `PATH`. The entry names the container and, optionally, the workdir that holds `artisan`: `api: { container: app-web, workdir: /srv/api }`. A project that must run PHP with an environment its web server sets up puts a wrapper command in `execWrapper`.

2. How do you know it is ready, without waiting a fixed time?

   `artisan` answers or it does not. The selftest probe `artisan: runs in the container` runs `php artisan --version` and expects the framework's name back, and `tinker: multi-line file executes` proves the application boots far enough to run code. A failure to reach the container is Blocked, because the docker process boundary types the daemon's own refusals as the environment failing, never as the product.

3. What deterministic marker shows it processed something?

   A line in `storage/logs`. `logs(reg, service, { grep })` returns the lines every `laravel-*.log` file holds, and `noLog(reg, service, pattern)` asserts that none matches. Reset empties those files, so the slice is exactly what the current attempt wrote. For a job, print or log a unique token from the code path under test and grep for it, rather than counting lines. A service that has never written a log file is Blocked, not an empty slice, so a wrong workdir cannot make `noLog` pass vacuously.

4. How do you force it to fail and undo that?

   `queueWorkerFault(ctx, reg, service, tenant)` kills the service's queue worker with `SIGKILL` and returns `{ restart, isRunning }`. Its restore is registered on `ctx.cleanups`, runs on every exit path of `scenario()`, and does not return until the worker is seen running again. `extraQueueWorker(ctx, reg, service, tenant)` starts a second worker for one scenario, so a row can show two workers contending for one queue, and returns `{ stop, count }`. It refuses unless exactly one worker is standing, finds the new process by the difference between two listings and never signals the standing one. Both need `SCN_ALLOW_CONTAINER_FAULT=1`, and both arm a recovery on process exit, SIGTERM and SIGINT. A project whose worker is not `php artisan queue:work` says so through the `laravel.worker` hook.

5. What does it do that the others don't?

   It runs PHP inside a container behind a guard that keeps a scenario out of the developer's real database. Every `tinker` body is wrapped in a connection guard that refuses the first query on any connection whose database name does not start with `dbPrefix`, and a refusal is Blocked because nothing ran. `artisan` is stricter. Before it runs a command, it asks which databases the command writes to and refuses unless every one starts with `dbPrefix`. An empty answer is a refusal, never "touches nothing". The prefix check is in code, so a project hook that names its own targets cannot widen it.

### Levers

| Lever | Signature | Notes |
| --- | --- | --- |
| `artisan` | `artisan(reg, service, args, opts)` | Runs `php artisan <args>`. `opts.touchesNoDatabase: true` skips the write-target check for a command that binds no database (`--version`, `config:clear`). So does `true` under any option name listed in `noDatabaseOptions`. A call that makes that claim and also sets an option listed in `noDatabaseConflicts` to `true` is refused before anything runs. |
| `tinker` | `tinker(reg, service, body, opts)` | Runs a PHP body, multi-line and multi-statement, behind the connection guard. |
| `queueWorkerFault` | `queueWorkerFault(ctx, reg, service, tenant, opts)` | Kills the queue worker. Needs `SCN_ALLOW_CONTAINER_FAULT=1`. |
| `extraQueueWorker` | `extraQueueWorker(ctx, reg, service, tenant, opts)` | Adds a second worker for one scenario. Needs `SCN_ALLOW_CONTAINER_FAULT=1`. |
| `odsFromCsv` | `odsFromCsv(reg, service, csvText, opts)` | Returns the bytes of an `.ods` written by the application's own spreadsheet library. |
| `workbook` | `workbook(reg, service, sheets, { format })` | Returns the bytes of an `.xlsx` or `.ods` with named sheets. `sheets` is `[{ name, rows }]`. |

`tenant` is passed through to the hooks below and never interpreted. `tinker` and `artisan` read it from the option named by the config's `tenantKey`. `logs` and `noLog` are the shared log readers, which this adapter backs for a service named in `exec`.

The connection guard checks every query that runs through the framework's connections, including a connection the body switches to or causes to be created, and a refusal is Blocked. It has two limits: a statement sent through the raw PDO handle bypasses it, and it checks the prefix of the database name but not the host, so a prefixed database on another server passes.

### Registry keys

```yaml
infra:
  env_registry:
    exec:                    # service name -> where its artisan runs
      api: { container: app-web, workdir: /srv/api }
      admin: { container: app-web }     # workdir defaults to defaultWorkdir, with {service} filled in
```

Every container an `exec` entry names joins the docker adapter's fault perimeter, so `dbFault` and `stopFault` may target it.

### Hooks

These three live in the project's `hooks.mjs`. They are optional, and the generated hooks template does not list them, because only this adapter may name laravel. Export them as `export const laravel = { preamble, writeTargets, worker };`.

| Hook | Signature | Default | Called |
| --- | --- | --- | --- |
| `laravel.preamble` | `({ service, tenant, reg, opts }) -> string` | `''` | Each time a `tinker` body is built, which includes every `artisan` write-target probe, `odsFromCsv` and `workbook`. The returned PHP runs after the connection guard is armed and before the body. Use it to put the process in the state a real entry point sets up, such as selecting a tenant's connection. `opts` are the call's options other than the `run` seam, so a project option reaches the hook unchanged. |
| `laravel.writeTargets` | `({ service, args, tenant, reg, opts, probe }) -> Promise<string[]>` | The default connection's database, read through `tinker` | Each time `artisan` runs without `touchesNoDatabase`. It names the databases the command is about to write to. Every name must start with `dbPrefix`, whatever the hook says, and an empty list is refused. `opts` are the `artisan` call's options other than `touchesNoDatabase` and the `probe` and `run` seams. `probe(script)` runs a PHP script in the service the way the default does, through `tinker`, and resolves to its output; a hook that has to ask the container uses it. A hook may also throw a `Blocked` to refuse with its own reason. |
| `laravel.worker` | `(service, { tenant, reg }) -> { pattern, processRegex, start(log) }` | `{ pattern: '[a]rtisan queue:work', processRegex: '^(/[^ ]*/)?php [^ ]*[a]rtisan queue:work', start: log => 'php artisan queue:work >> storage/logs/' + log + ' 2>&1' }` | Each time `queueWorkerFault` or `extraQueueWorker` runs. `pattern` is a `pgrep -f` and `pkill -f` pattern and `processRegex` matches the worker's php process only. Bracket one character in each, so the `sh -c` that carries the pattern never matches itself. `start(log)` returns the shell command that starts one worker, with `log` the file name under `storage/logs` (`queue-worker.log`, or `queue-worker-2.log` for the second worker). |

### Configuration

```json
{ "adapters": { "laravel": {
  "defaultWorkdir": "/var/www/html",
  "execWrapper": ["/opt/svc-env.sh", "{service}"],
  "workerUser": "worker",
  "truncateLogsOnReset": true,
  "noDatabaseOptions": [],
  "noDatabaseConflicts": [],
  "selftest": { "service": "api" }
} } }
```

- `defaultWorkdir`: the workdir of an `exec` entry that states none. `{service}` is filled in. Default: `/var/www/html`.
- `execWrapper`: words placed between the container and `sh -c` in every PHP exec, each with `{service}` filled in. Default: none.
- `workerUser`: the user a detached worker starts as (`docker exec -u`). When null, docker's default user. Default: null.
- `truncateLogsOnReset`: when true, reset empties every `storage/logs/*.log` of every `exec` service. Set it to false when the project's baseline restore already does that, because the step costs one exec per service per row. Default: true.
- `noDatabaseOptions`: further `artisan` option names that make the same claim as `touchesNoDatabase`, for a project whose scripts already spell it another way. Each is still an explicit claim at the call site, and only the value `true` counts. Default: none.
- `noDatabaseConflicts`: `artisan` option names that contradict the no-database claim, such as an option saying the command binds every database. A call that claims no database and sets one of these to `true` is `Blocked` before anything is probed or run, naming both options, because the guard must not pick between them. Default: none.
- `selftest.service`: an `exec` service. When set, `selftest.mjs` runs the artisan and tinker probes against it. When null, they are skipped.

### Other contributions

- Reset, in the `normalize` phase: `storage-perms` widens `storage/logs` and `storage/framework/cache/data` to group-writable with `www-data` ownership and setgid directories, and never deletes. `truncate-logs` runs only when `truncateLogsOnReset` is true. A failure in either is Blocked. Keep the logs cleared on every reset, by this step or by the project's baseline restore: without it, a long run's daily log grows until a heavy request exhausts PHP's `memory_limit`, and every route behind it answers 500.
- Lint: `php-artisan` rejects a raw `php artisan` in compiled scripts. Use `artisan` or `tinker`.
- Fatal log patterns: `Allowed memory size` and `PHP Fatal`.
- Selftest: `artisan: runs in the container`, `artisan: a failing command surfaces as an error`, `artisan: refuses a write target outside the database prefix`, `tinker: multi-line file executes`, `tinker: dirs a root tinker creates are group-writable (worker gid can write them)` and `tinker: a failing script surfaces as an error`.
- Verify: `docker exec -w {workdir} {container} php artisan list --raw | grep -q '^{command} '` checks that an artisan command exists. `{workdir}` and `{container}` come from `reg.execTarget('<service>')`.
