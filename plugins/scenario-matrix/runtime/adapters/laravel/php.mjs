// artisan + tinker inside a service container. tinker() writes a real multi-line PHP file and
// passes it as the `include` argument (vendor/laravel/tinker/src/Console/TinkerCommand.php), with
// stdin closed so PsySH includes the file and exits: no line-by-line eval, so ordinary try/catch
// and multi-statement code work.
//
// Three things in here are project specifics and come from hooks instead of from this file:
//   laravel.preamble({ service, tenant, reg }) -> string           PHP run before every tinker body
//   laravel.writeTargets({ service, args, tenant, reg }) -> Promise<string[]>
//                                                                   the databases an artisan command writes to
//   laravel.worker(service, { tenant, reg }) -> { pattern, processRegex, start(log) }
//                                                                   the queue worker's process and start command
// The tenant is passed through, never interpreted.
import { spawnSync } from 'node:child_process';
import { dockerRun } from './docker.mjs';
import { Blocked } from './errors.mjs';
import { adapterConfig, config, fill } from './config.mjs';
import { hook, tenantOf } from './ext.mjs';
import { armRecovery, defaultReraiseSignal } from './adapter-docker.mjs';

// --- the exec layer -----------------------------------------------------------

// `docker exec` argv for a command inside a service's container. `execWrapper` is the adapter
// config's list of words placed between the container and `sh -c`, each with {service} filled in:
// it is how a project makes PHP see the same environment its web server does.
export function laravelExec(target, cmd, { detach = false, stdin = false, user = null, xdebugOff = false } = {}) {
  const wrapper = (adapterConfig('laravel').execWrapper ?? []).map(word => fill(word, { service: target.service }));
  return [
    'exec',
    ...(detach ? ['-d'] : []),
    ...(stdin ? ['-i'] : []),
    ...(user ? ['-u', user] : []),
    ...(xdebugOff ? ['-e', 'XDEBUG_MODE=off'] : []),
    '-w', target.workdir,
    target.container,
    ...wrapper,
    'sh', '-c', cmd,
  ];
}

// `docker exec` without -u runs as root, but a queue worker usually runs as another user.
// dispatchSync() runs a job's middleware in the CALLER, so a root tinker/artisan process creates
// the file-cache lock directories (WithoutOverlapping, ShouldBeUnique) that the worker must later
// write into. Under root's default umask 022 they come out 2755 and the worker dies with
// "fopen(...): Permission denied". umask 002 makes them 2775 under a setgid cache tree, so the
// group can write.
const GROUP_WRITABLE = 'umask 002 && ';

// Single-quoted PHP strings honour exactly two escapes, \\ and \', so a value embedded in one has
// to be escaped before it can be placed in the literal.
function phpSingleQuoted(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// --- tinker connection guard ---------------------------------------------------
//
// The stable marker every refusal below starts with. tinker() matches on it to tell "the guard
// fired" (BLOCKED, nothing ran) apart from "the body itself blew up" (a real failure the
// scenario has to explain).
export const SCN_GUARD_MARKER = 'refusing non-scn_ database';

// The guard is a CONNECTION-LEVEL assertion, armed unconditionally and before the preamble hook
// runs, so a preamble or body that switches the connection itself, or calls a service that does,
// is still covered.
//
// Mechanism: Illuminate\Database\Connection::run() invokes every callback registered through
// beforeExecuting() BEFORE the statement executes, and select(), statement(),
// affectingStatement() and unprepared() all go through run(). So one callback per connection
// covers reads, writes and DDL alike, at the moment of the query rather than at the moment of a
// switch. Coverage of connections that do not exist yet comes from the ConnectionEstablished event
// DatabaseManager dispatches the first time it resolves each one: the listener arms the guard on
// every connection the body causes to be created. Already-resolved connections are armed directly.
//
// LIMITS, stated plainly:
//   - Raw PDO (`DB::connection()->getPdo()->exec(...)`) bypasses run() and is therefore
//     unguarded. Nothing short of not handing out the PDO can close that.
//   - The guard refuses per QUERY, so it stops the first offending statement rather than
//     predicting the body's targets in advance. It needs no notion of what the body intends.
//   - It asserts only the configured prefix on the connection's database name. It does not check
//     the host, so a prefixed database on some other server would pass.
//   - If the framework ever drops beforeExecuting() or ConnectionEstablished, the preamble fails
//     closed at boot rather than running unguarded: see the class_exists/method_exists refusal.
function guardPreamble() {
  const prefix = phpSingleQuoted(config().dbPrefix);
  return `$__scnGuard = function ($__scnQuery, $__scnBindings, $__scnConnection) {
    $__scnDb = (string) $__scnConnection->getDatabaseName();
    if (strpos($__scnDb, '${prefix}') !== 0) {
        fwrite(STDERR, "${SCN_GUARD_MARKER}: connection '{$__scnConnection->getName()}' resolves to '{$__scnDb}' — query: " . substr($__scnQuery, 0, 200) . "\\n");
        exit(1);
    }
};
if (! class_exists(\\Illuminate\\Database\\Events\\ConnectionEstablished::class)
    || ! method_exists(\\Illuminate\\Database\\Connection::class, 'beforeExecuting')) {
    fwrite(STDERR, "${SCN_GUARD_MARKER}: this framework build has no beforeExecuting/ConnectionEstablished hook, so the guard cannot be armed\\n");
    exit(1);
}
foreach (app('db')->getConnections() as $__scnExisting) {
    $__scnExisting->beforeExecuting($__scnGuard);
}
\\Illuminate\\Support\\Facades\\Event::listen(
    \\Illuminate\\Database\\Events\\ConnectionEstablished::class,
    function ($__scnEvent) use ($__scnGuard) { $__scnEvent->connection->beforeExecuting($__scnGuard); }
);
`;
}

// The project's PHP, run after the guard is armed and before the body. A project uses it to put
// the process in the state a real entry point would have set up, for example selecting a
// tenant's connection or seeding a context value the queue payload reads. `opts` are the
// options of the tinker call (or of the lever that called tinker) other than the `run` seam, so a
// project option such as a host to select a connection by reaches the hook unchanged.
function preambleFor({ service, tenant, reg, opts }) {
  const text = String(hook('laravel.preamble', () => '')({ service, tenant, reg, opts }) ?? '');
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

export function tinkerScript(body, { service, tenant, reg, opts = {} } = {}) {
  return `<?php\n${guardPreamble()}${preambleFor({ service, tenant, reg, opts })}${body}\n`;
}

// --- artisan write-target guard ---------------------------------------------------
//
// A bare check of the default connection cannot always guard artisan(): a service may resolve
// its real connection through per-request middleware that a console command never runs, so the
// default connection alone says nothing about which database the command binds. The project says
// so through laravel.writeTargets, which names the databases the command is about to write to.
// Without the hook the targets are the default connection's database, read by tinker, so the
// preamble hook has already run and a preamble that selects a connection is honoured.
//
// The guard FAILS CLOSED. An empty list is a refusal, never "touches nothing": it says the probe
// could not tie the command to a database, and a command whose optional argument is omitted may
// well sweep every one it can reach. The one way through for a command that genuinely binds no
// database (`--version`, `config:clear`, `queue:restart`) is the explicit `touchesNoDatabase: true`
// option, a claim the author makes at the call site so it sits next to the command it is about.
// There is deliberately no allowlist of "safe" command names: such a list rots, and inferring
// safety from a command string is the same guess this guard exists to replace.
//
// Whatever the hook names, EVERY target must still start with `dbPrefix`. That check is in code,
// not in the hook, so a project cannot widen what artisan may write to.
//
// LIMIT: the hook verifies the databases it names, not the ones the command will actually reach.
// A command that widens its own reach past its arguments is only as safe as the hook that
// anticipates it; read the command before calling artisan() with a flag that does that.
const TARGETS_MARKER = 'SCN_WRITE_TARGETS=';

const defaultTargetsScript = () => `echo '${TARGETS_MARKER}' . json_encode([\\Illuminate\\Support\\Facades\\DB::connection()->getDatabaseName()]) . "\\n";`;

export function parseWriteTargets(out) {
  const m = /^SCN_WRITE_TARGETS=(.*)$/m.exec(String(out));
  if (!m) throw new Blocked(`the write-target probe printed no target list: ${String(out).slice(0, 400)}`);
  return JSON.parse(m[1]);
}

export function assertPrefixedTargets(service, targets) {
  const prefix = config().dbPrefix;
  const bad = targets.filter(db => !String(db).startsWith(prefix));
  if (bad.length === 0) return targets;
  throw new Blocked(
    `refusing artisan on ${service}: write target outside the ${prefix}* databases (${bad.join(', ')})`
    + ' — the scenario overlay is not applied to this container',
  );
}

function assertTargetsNamed(service, args, targets) {
  if (targets.length > 0) return;
  throw new Blocked(
    `refusing artisan on ${service}: the database [${args.join(' ')}] writes to could not be determined, `
    + 'so it cannot be shown to stay inside the scenario databases. A command whose optional argument is '
    + 'omitted may sweep every database it can reach. Have laravel.writeTargets name the databases the '
    + 'command binds, or declare touchesNoDatabase: true at the call site if it really binds none.',
  );
}

// The hook gets the call's options other than the guard's own, and `probe(script)`, which runs a
// PHP script in the service the same way the default probe does (through tinker, behind the
// connection guard and the preamble). A project that has to ask the container which databases a
// command binds uses it rather than reaching for docker itself.
async function resolveWriteTargets(reg, service, args, tenant, probe, probeOpts) {
  const named = hook('laravel.writeTargets', null);
  if (named === null) {
    return parseWriteTargets(await probe(reg, service, defaultTargetsScript(), probeOpts));
  }
  const runProbe = script => probe(reg, service, script, probeOpts);
  const targets = await named({ service, args, tenant, reg, opts: probeOpts, probe: runProbe });
  if (!Array.isArray(targets) || !targets.every(t => typeof t === 'string')) {
    throw new Blocked(`refusing artisan on ${service}: laravel.writeTargets must return a list of database names, got ${JSON.stringify(targets)}`);
  }
  return targets;
}

// `probe` and `run` are the testing seams: they are the two things here that reach outside the
// process. `run` in particular is what lets a test assert that the command line handed to the
// container is the same one the guard verified. There is deliberately no option that names a
// target, because an option that changes what gets verified without changing what gets executed
// makes those two subjects diverge, and a guard that verifies a different invocation than the one
// it runs is worse than no guard. The target belongs in `args`, which is both what the CLI takes
// and the only thing the execution below can see.
export async function artisan(reg, service, args, {
  touchesNoDatabase = false,
  probe = tinker,
  run = dockerRun,
  ...rest
} = {}) {
  const target = reg.execTarget(service);
  const { workdir } = target;
  // A project whose scripts already spell the claim another way names those options in
  // `noDatabaseOptions`. Each is the same explicit claim at the call site, never inferred.
  const { noDatabaseOptions = [], noDatabaseConflicts = [] } = adapterConfig('laravel');
  const claimOption = touchesNoDatabase ? 'touchesNoDatabase' : noDatabaseOptions.find(name => rest[name] === true);
  // An option in `noDatabaseConflicts` says the opposite of the claim (for example "this command
  // binds every database"), so a call site that sets both has not decided what the command does.
  // The guard must not pick for it: honouring the claim would silently skip the check.
  const conflictOption = claimOption && noDatabaseConflicts.find(name => rest[name] === true);
  if (conflictOption) {
    throw new Blocked(
      `refusing artisan on ${service}: [${args.join(' ')}] declares both ${claimOption} and ${conflictOption}, `
      + 'which contradict each other. Read the command and pick one.',
    );
  }
  if (!claimOption) {
    const targets = await resolveWriteTargets(reg, service, args, tenantOf(rest), probe, rest);
    assertTargetsNamed(service, args, targets);
    assertPrefixedTargets(service, targets);
  }
  const cmd = ['php', 'artisan', ...args].map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  return run(laravelExec(target, `${GROUP_WRITABLE}cd ${workdir} && ${cmd}`, { stdin: true, xdebugOff: true }));
}

// Deliberately NOT a blanket "any tinker failure is Blocked": a PHP fatal inside the body is the
// system under test misbehaving, and stays an untyped rejection that scenario.mjs classifies as
// KO. Only the guard's own refusal, recognised by the marker it writes to stderr, becomes
// Blocked, because a refusal means nothing ran and nothing was learned.
//
// `run` is the testing seam; real callers pass nothing, or the tenant key's option.
export async function tinker(reg, service, body, opts = {}) {
  const { run = dockerRun, ...callOpts } = opts;
  const tenant = tenantOf(opts);
  const target = reg.execTarget(service);
  const { container, workdir } = target;
  const path = `/tmp/scn-tinker-${process.pid}-${Math.trunc(process.hrtime()[1])}.php`;
  const script = tinkerScript(body, { service, tenant, reg, opts: callOpts });
  await run(['exec', '-i', container, 'sh', '-c', `cat > ${path}`], script);
  try {
    return await run(laravelExec(
      target,
      `${GROUP_WRITABLE}cd ${workdir} && php artisan tinker ${path} < /dev/null`,
      { stdin: true, xdebugOff: true },
    ));
  } catch (err) {
    const message = err?.message ?? String(err);
    if (message.includes(SCN_GUARD_MARKER)) throw new Blocked(message);
    throw err;
  } finally {
    await run(['exec', '-i', container, 'sh', '-c', `rm -f ${path}`]).catch(() => {});
  }
}

// --- the queue worker ---------------------------------------------------------------

// What a service's queue worker looks like as a process, and how to start it. The patterns
// matter: the bracket keeps a pgrep/pkill from matching the `sh -c` that carries the pattern
// itself, and `processRegex` matches php processes only, never that `sh -c`. A project whose
// worker command differs, or whose container holds several services' workers, returns its own
// through laravel.worker.
function defaultWorker() {
  return {
    pattern: '[a]rtisan queue:work',
    processRegex: '^(/[^ ]*/)?php [^ ]*[a]rtisan queue:work',
    start: log => `php artisan queue:work >> storage/logs/${log} 2>&1`,
  };
}

const workerFor = (service, tenant, reg) => hook('laravel.worker', defaultWorker)(service, { tenant, reg });

const startWorker = (run, target, worker, log) =>
  run(laravelExec(target, worker.start(log), { detach: true, user: adapterConfig('laravel').workerUser }));

function requireWorkerOptIn(lever) {
  if (process.env.SCN_ALLOW_CONTAINER_FAULT === '1') return;
  throw new Blocked(`${lever}() needs SCN_ALLOW_CONTAINER_FAULT=1 — process lifecycle requires explicit approval`);
}

async function untilTrue(check, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return false;
}

// Kill and restart a service's queue worker, for crash-recovery scenarios.
//
// WHY A LEVER AND NOT A tinker() BODY. The worker is a long-running OS process inside the
// container, not something the application can reach; killing it needs a signal, and restarting
// it needs the same detached invocation the stack's own startup uses. Getting that invocation
// wrong leaves the stack with NO worker, which does not fail the scenario that broke it: it fails
// every later row that queues anything, in code that has nothing to do with the cause.
//
// THAT IS WHY restore() IS REGISTERED ON ctx.cleanups AND VERIFIED. It runs on every
// scenario.mjs exit path, and it does not return until `pgrep` sees the process again, so a row
// cannot hand the next one a workerless queue.
//
// Gated behind SCN_ALLOW_CONTAINER_FAULT for the same reason dbFault() and stopFault() are: this
// manipulates process lifecycle inside the perimeter, and it must never fire by accident in an
// unattended run.
export async function queueWorkerFault(ctx, reg, service, tenant, {
  run = dockerRun,
  readyTimeoutMs = 30000,
} = {}) {
  requireWorkerOptIn('queueWorkerFault');
  const target = reg.execTarget(service);
  const { container } = target;
  const worker = workerFor(service, tenant, reg);
  const PATTERN = worker.pattern;

  const isRunning = async () => {
    const out = await run(['exec', container, 'sh', '-c',
      `pgrep -f '${PATTERN}' >/dev/null 2>&1 && echo SCN_WORKER_UP || echo SCN_WORKER_DOWN`]);
    return /SCN_WORKER_UP/.test(String(out ?? ''));
  };

  const start = async () => {
    await startWorker(run, target, worker, 'queue-worker.log');
    return untilTrue(isRunning, readyTimeoutMs, 250);
  };

  // Registered BEFORE the kill: a failure inside kill() itself must still leave a restore path
  // standing.
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    if (await isRunning()) return;
    if (!await start()) {
      throw new Blocked(
        `the ${service} queue worker did not come back within ${readyTimeoutMs}ms after this scenario `
        + 'killed it. Every later row that queues a job would hang on a queue nobody is draining; '
        + 'restart the stack to bring it back',
      );
    }
  };
  ctx.cleanups.push(restore);

  if (!await isRunning()) {
    throw new Blocked(
      `the ${service} queue worker is not running BEFORE this scenario tried to kill it, so a `
      + 'crash-recovery claim cannot be exercised — the stack should have started it',
    );
  }
  await run(['exec', container, 'sh', '-c', `pkill -9 -f '${PATTERN}' || true`]);
  const down = await untilTrue(async () => !await isRunning(), readyTimeoutMs, 200);
  if (!down) {
    throw new Blocked(`the ${service} queue worker was still running ${readyTimeoutMs}ms after SIGKILL, `
      + 'so the crash this row simulates never happened');
  }

  return { restart: restore, isRunning };
}

// A SECOND queue worker for the length of one scenario, for rows whose claim needs two workers
// draining the one queue at once (a duplicate continuation has to meet the overlap lock a live
// slice holds, and with a single worker the duplicate just waits for that worker to be free and
// never contends).
//
// WHY A LEVER, AND WHY IT COUNTS. The stack starts exactly one worker and the whole matrix
// assumes it. A second worker that outlives its row would make every later row run against two
// workers, and nothing in that row would say so. So the lever refuses to start unless the
// container holds exactly the one standing worker, finds the new process by the difference between
// two listings (the standing worker is never signalled), and refuses to call itself stopped until
// the listing is back to exactly what it was before.
//
// The stop is registered on ctx.cleanups BEFORE the start (a failed start still stops whatever did
// appear) and on exit / SIGTERM / SIGINT, because run.mjs's per-row timeout kills a hung row with
// SIGTERM and cleanups do not run then. Gated behind SCN_ALLOW_CONTAINER_FAULT like
// queueWorkerFault: it manipulates process lifecycle inside the perimeter.
function defaultKillSync(container, pids) {
  spawnSync('docker', ['exec', container, 'sh', '-c', `kill -9 ${pids.join(' ')} 2>/dev/null || true`]);
}

export async function extraQueueWorker(ctx, reg, service, tenant, {
  run = dockerRun,
  killSync = defaultKillSync,
  reraiseSignal = defaultReraiseSignal,
  readyTimeoutMs = 30000,
  stopTimeoutMs = 15000,
  pollMs = 250,
} = {}) {
  requireWorkerOptIn('extraQueueWorker');
  const target = reg.execTarget(service);
  const { container } = target;
  const worker = workerFor(service, tenant, reg);

  const workerPids = async () => {
    const out = String(await run(['exec', container, 'sh', '-c',
      `echo SCN_WORKER_PIDS=$(pgrep -f '${worker.processRegex}' | tr '\\n' ' ')`]) ?? '');
    const match = /^SCN_WORKER_PIDS=(.*)$/m.exec(out);
    if (!match) {
      throw new Blocked(`the ${service} worker listing printed no SCN_WORKER_PIDS marker: ${out.slice(0, 300)}`);
    }
    return match[1].split(/\s+/).filter(p => /^\d+$/.test(p)).map(Number);
  };

  const before = await workerPids();
  if (before.length !== 1) {
    throw new Blocked(
      `expected exactly one ${service} queue worker (the standing one) before starting a second, found `
      + `${before.length} (${before.join(', ') || 'none'}); restart the stack to restore the standing worker`,
    );
  }

  const added = async () => (await workerPids()).filter(pid => !before.includes(pid));

  let stopped = false;
  let known = [];
  let disarm = () => {};

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const extra = await added();
    if (extra.length > 0) {
      await run(['exec', container, 'sh', '-c', `kill ${extra.join(' ')} 2>/dev/null || true`]);
      const gone = await untilTrue(async () => (await added()).length === 0, stopTimeoutMs, pollMs);
      if (!gone) {
        await run(['exec', container, 'sh', '-c', `kill -9 ${extra.join(' ')} 2>/dev/null || true`]);
        await untilTrue(async () => (await added()).length === 0, stopTimeoutMs, pollMs);
      }
    }
    const after = await workerPids();
    if (after.length !== before.length || after.some(pid => !before.includes(pid))) {
      throw new Blocked(
        `the ${service} container did not get back to exactly the one standing worker after the second one was `
        + `stopped: before ${before.join(', ')}, now ${after.join(', ') || 'none'}. Every later row that queues a `
        + 'job would run against the wrong number of workers; restart the stack to restore the standing one',
      );
    }
    disarm();
  };

  // Registered and armed BEFORE the start, so a failure inside it still leaves a stop standing.
  // The exit handler is synchronous on purpose ('exit' cannot await), best effort, and covers
  // only the processes already known to be additions.
  ctx.cleanups.push(stop);
  disarm = armRecovery(() => { if (known.length > 0) killSync(container, known); }, reraiseSignal);

  await startWorker(run, target, worker, 'queue-worker-2.log');
  const appeared = await untilTrue(async () => {
    known = await added();
    return known.length > 0;
  }, readyTimeoutMs, pollMs);
  if (!appeared) {
    throw new Blocked(
      `the second ${service} queue worker did not appear within ${readyTimeoutMs}ms of its start command; `
      + 'the row cannot show two workers contending without it',
    );
  }

  return { stop, count: async () => (await workerPids()).length };
}

// --- .ods fixture -------------------------------------------------------------------
//
// Writes an OpenDocument spreadsheet from CSV text and returns its bytes.
//
// It exists because an ODS is a ZIP of XML parts and nothing in this library can produce one.
// Hand-rolling the ZIP was rejected for a reason worth keeping in view: a workbook
// PhpSpreadsheet's IOFactory refused would classify to an internal error, which is
// INDISTINGUISHABLE from the product refusing ODS: a KO blaming the product for a defect in the
// harness's own input.
//
// So the file is written by the same library the product reads it with:
// PhpOffice\PhpSpreadsheet\Writer\Ods, which is already in the service's vendor tree when the
// product reads spreadsheets. That makes the round trip library-to-library, which is weaker than
// an ODS from a real office suite and is stated plainly here rather than hidden: it proves the
// product's ODS arm opens and reads a well-formed ODF file, not that it interoperates with every
// writer in the world.
//
// The bytes come back base64 over tinker's stdout because that is the only channel there is.
// `echo` alone would be ambiguous, since PsySH prints and a stray warning would land in the same
// stream, so the payload is fenced between two markers and everything outside them is discarded.
const ODS_BEGIN = '---scn-ods-begin---';
const ODS_END = '---scn-ods-end---';

export async function odsFromCsv(reg, service, csvText, opts = {}) {
  const csvB64 = Buffer.from(csvText, 'utf8').toString('base64');
  const out = await tinker(reg, service, `$__scnSrc = tempnam(sys_get_temp_dir(), 'scn-ods-src-');
$__scnDst = tempnam(sys_get_temp_dir(), 'scn-ods-dst-');
file_put_contents($__scnSrc, base64_decode('${csvB64}'));
$__scnReader = new \\PhpOffice\\PhpSpreadsheet\\Reader\\Csv();
$__scnReader->setDelimiter(',');
$__scnBook = $__scnReader->load($__scnSrc);
$__scnWriter = new \\PhpOffice\\PhpSpreadsheet\\Writer\\Ods($__scnBook);
$__scnWriter->save($__scnDst);
echo "${ODS_BEGIN}" . base64_encode(file_get_contents($__scnDst)) . "${ODS_END}";
@unlink($__scnSrc);
@unlink($__scnDst);`, opts);

  return fencedZip(out, service, '.ods');
}

// --- multi-sheet workbook fixture -----------------------------------------------------
//
// Writes an .xlsx or .ods workbook with any number of NAMED sheets and returns its bytes.
// odsFromCsv() cannot do this: a CSV is one unnamed sheet, and an importer that is judged by its
// sheet names needs the names to be the fixture. Same writer-is-the-reader's-library reasoning as
// odsFromCsv() above.
//
// `sheets` is [{ name, rows }], where rows[0] is the header row. Every cell is written as an
// explicit STRING: PhpSpreadsheet's default value binder would turn '007123' into the number 7123
// and silently drop the leading zeros a row asserts on (a code or an account number, say). A null,
// undefined or '' cell is left UNWRITTEN rather than written empty, so a row whose last cells are
// blank is physically shorter than its header row, which is the shape a trailing-empty-column
// guard needs the reader to meet.
const SUPPORTED_WORKBOOK_FORMATS = { xlsx: 'Xlsx', ods: 'Ods' };

export function workbookScript(sheets, format) {
  const writer = SUPPORTED_WORKBOOK_FORMATS[format];
  if (!writer) throw new Error(`workbook(): unsupported format ${JSON.stringify(format)} (xlsx or ods)`);
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error('workbook(): at least one sheet is required');
  const spec = Buffer.from(JSON.stringify(sheets.map(s => ({ name: s.name, rows: s.rows }))), 'utf8').toString('base64');
  return `$__scnSpec = json_decode(base64_decode('${spec}'), true);
$__scnDst = tempnam(sys_get_temp_dir(), 'scn-wb-dst-');
$__scnBook = new \\PhpOffice\\PhpSpreadsheet\\Spreadsheet();
$__scnBook->removeSheetByIndex(0);
foreach ($__scnSpec as $__scnI => $__scnSheet) {
    $__scnWs = $__scnBook->createSheet($__scnI);
    $__scnWs->setTitle($__scnSheet['name']);
    foreach ($__scnSheet['rows'] as $__scnR => $__scnRow) {
        foreach ($__scnRow as $__scnC => $__scnValue) {
            if ($__scnValue === null || $__scnValue === '') {
                continue;
            }
            $__scnWs->setCellValueExplicit(
                \\PhpOffice\\PhpSpreadsheet\\Cell\\Coordinate::stringFromColumnIndex($__scnC + 1) . ($__scnR + 1),
                (string) $__scnValue,
                \\PhpOffice\\PhpSpreadsheet\\Cell\\DataType::TYPE_STRING
            );
        }
    }
}
$__scnBook->setActiveSheetIndex(0);
$__scnWriter = new \\PhpOffice\\PhpSpreadsheet\\Writer\\${writer}($__scnBook);
$__scnWriter->save($__scnDst);
echo "${ODS_BEGIN}" . base64_encode(file_get_contents($__scnDst)) . "${ODS_END}";
@unlink($__scnDst);`;
}

export async function workbook(reg, service, sheets, { format = 'xlsx', ...opts } = {}) {
  const out = await tinker(reg, service, workbookScript(sheets, format), opts);
  return fencedZip(out, service, `.${format}`);
}

// Both fixtures come back base64 between the same two markers, and both are ZIP containers, so
// the unwrapping and the transfer check are shared.
function fencedZip(out, service, what) {
  const fenced = out.slice(out.indexOf(ODS_BEGIN) + ODS_BEGIN.length, out.indexOf(ODS_END));
  if (!out.includes(ODS_BEGIN) || !out.includes(ODS_END) || fenced.trim() === '') {
    throw new Blocked(`the ${service} container produced no ${what} fixture -- PhpSpreadsheet's writer `
      + `printed nothing between the markers: ${out.slice(0, 400)}`);
  }
  const bytes = Buffer.from(fenced.replace(/\s+/g, ''), 'base64');
  // "PK" is the ZIP local-file-header magic every ODF and OOXML package starts with, so this
  // catches a truncated or text-mangled transfer here rather than letting it reach the product
  // and read as a file the product could not parse.
  if (bytes.length === 0 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Blocked(`the ${what} fixture came back as ${bytes.length} bytes that are not a ZIP container, `
      + 'so the transfer mangled it -- feeding it to the product would blame the product for it');
  }
  return bytes;
}
