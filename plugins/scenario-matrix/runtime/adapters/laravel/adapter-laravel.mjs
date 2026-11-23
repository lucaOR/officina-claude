// The laravel adapter's contribution module: the `exec` registry key and its `execTarget`
// accessor, the `logSource.laravel` driver (a service's storage/logs), the storage reset steps,
// its lint rule, its selftest probes and its artifact verifier. The keys of `drivers` equal the
// `drivers` array of adapter.json.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blocked, Ko, Inconclusive } from './errors.mjs';
import { adapterConfig, fill } from './config.mjs';
import { dockerRun } from './docker.mjs';
import { artisan, assertPrefixedTargets, tinker } from './php.mjs';

export const name = 'laravel';

const isMapping = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- registry: exec ---

function execTargetOf(raw, service) {
  const entry = raw?.exec?.[service];
  if (!entry) throw new Blocked(`unknown exec target: ${service} (add infra.env_registry.exec.${service})`);
  const workdir = entry.workdir ?? fill(adapterConfig('laravel').defaultWorkdir ?? '/var/www/html', { service });
  return { container: entry.container, workdir, service };
}

export const registry = {
  keys: {
    exec: {
      validate(value) {
        if (!isMapping(value)) return 'must be a mapping of service name to { container, workdir }';
        for (const [service, entry] of Object.entries(value)) {
          if (!isMapping(entry) || typeof entry.container !== 'string' || entry.container === '') {
            return `${service} must be a mapping with a non-empty container name (container: <name>)`;
          }
          if (entry.workdir !== undefined && (typeof entry.workdir !== 'string' || entry.workdir === '')) {
            return `${service}.workdir must be a non-empty path inside the container`;
          }
        }
        return null;
      },
    },
  },
  accessors: raw => ({ execTarget: service => execTargetOf(raw, service) }),
  logSources: raw => Object.fromEntries(Object.keys(raw?.exec ?? {})
    .map(service => [service, { kind: 'laravel', ...execTargetOf(raw, service) }])),
  // The containers the exec entries run in, which puts them inside the docker adapter's fault perimeter.
  containers: raw => Object.values(raw?.exec ?? {}).map(entry => entry?.container).filter(c => typeof c === 'string' && c !== ''),
  logSourceHint: 'exec maps a service to the container its artisan runs in',
};

// --- logSource.laravel ---

// Every daily log file at once, under whatever name the framework gave it. A path built from a
// clock names the wrong file for whichever service does not agree with it for part of every day,
// and `laravel-*.log` sidesteps the question: it reads every daily file present, so no service's
// timezone has to be known here.
//
// The missing-vs-empty distinction survives the glob. The container shell is POSIX sh, which has
// no nullglob: when nothing matches, the unexpanded literal pattern is passed straight to `cat`,
// which fails "No such file or directory" exactly like a single missing filename would. When
// anything matches, the read succeeds and an empty result is a genuine "nothing logged", because a
// reset truncates every `.log` file in the directory, not just today's. So this command must carry
// no masking (`2>/dev/null`, `|| true`): masking would make a wrong workdir look like an empty log.
export function logPathCommand(workdir) {
  return `cat ${workdir}/storage/logs/laravel-*.log`;
}

const isTyped = err => err instanceof Blocked || err instanceof Ko || err instanceof Inconclusive;

// The missing-file case, typed. `cat` exiting 1 on a file that was never created means no service
// wrote a log line, or the workdir is wrong: the environment, never the product. It is the one
// failure of this command the docker process boundary cannot classify, because that layer knows
// docker's own errors, not which command it was asked to carry, and "No such file or directory"
// out of an arbitrary container command could equally be a product signal. Here the command IS
// known, so the meaning is known too.
//
// This matters most where it is least visible: noLog() is a NEGATIVE assert, so an unclassified
// missing file would be reported as "the product logged <pattern>" when in fact nothing had
// written a log line at all.
export function asLogReadFailure(service, err) {
  if (isTyped(err)) return err;
  if (!/No such file or directory/.test(err?.message ?? '')) return err;
  return new Blocked(
    `no log file to read for ${service} — nothing has written one, or the `
    + `service's workdir is wrong: ${err.message}`,
    { cause: err },
  );
}

// `opts.run` is the testing seam for the docker call. `opts.grep` is ignored here: the core filters.
const readLaravelLog = (reg, src, opts = {}) => (opts.run ?? dockerRun)(
  ['exec', '-i', src.container, 'sh', '-c', logPathCommand(src.workdir)],
).catch(err => { throw asLogReadFailure(src.service, err); });

const logSourceLaravel = {
  read: readLaravelLog,
  async capture(reg, src, dir, opts = {}) {
    writeFileSync(join(dir, `${src.service}.log`), String(await readLaravelLog(reg, src, opts)));
  },
};

export const drivers = {
  'logSource.laravel': logSourceLaravel,
};

// --- reset: storage ---

// Two storage subtrees each service writes to from more than one uid:
//
//   storage/logs: artisan()/tinker() run through `docker exec` as root, so whichever of them
//   speaks first on a new calendar day CREATES that day's laravel-<date>.log owned by root. A
//   logging config that sets 'permission' => 0660 has Monolog re-apply it with a chmod on every
//   open, so the file keeps returning to 0660 no matter how often the mode is widened. The web
//   server and the queue worker run as other users; with the file root:root 0660 both are locked
//   out, every route answers 500, and the worker dies at its first log line, and nothing says why
//   because writing the log is the thing that failed. A truncate preserves owner and mode, so it
//   does not clear this on its own.
//
//   storage/framework/cache/data: a queue worker (umask 022) creates cache prefix dirs mode 755,
//   and a later web request whose lock-key hash lands under one cannot write its ShouldBeUnique
//   lock.
//
// The mode widening alone is only a truce: the next root-run artisan reopens the log and Monolog
// chmods it back. The cure is OWNERSHIP: chgrp to www-data plus setgid on the directories, so files
// created later inherit the group and Monolog's own 0660 then grants that group write.
//
// These are NOT ephemeral scratch dirs when the workdir is a bind mount of a real working tree, and
// each storage/logs holds a tracked .gitignore. The recursion is permissive-only and `a+rwX` cannot
// set the execute bit on a regular file that does not already have one, so no git-visible mode
// change results. Nothing here is disposable, which is why it stays a widening and never a delete.
export function storagePermsCommand(workdir) {
  const paths = [`${workdir}/storage/logs`, `${workdir}/storage/framework/cache/data`];
  return [
    // Both paths, not just the cache one: `chmod -R` on a missing directory exits non-zero, and
    // this runs before anything has necessarily created storage/logs.
    `mkdir -p ${paths.join(' ')}`,
    `chmod -R a+rwX ${paths.join(' ')}`,
    // Suppressed per path: a container image without a www-data group must not be able to fail
    // the whole reset over an ownership nicety.
    `chgrp -R www-data ${paths.join(' ')} 2>/dev/null || true`,
    `find ${paths.join(' ')} -type d -exec chmod g+s {} + 2>/dev/null || true`,
  ].join(' && ');
}

// Empties every log file in place, keeping owner and mode, so a slice starts at zero bytes.
export function truncateLogsCommand(workdir) {
  return `find ${workdir}/storage/logs -name '*.log' -exec truncate -s 0 {} +`;
}

// BLOCKED, not KO: a container that cannot be brought to a known state is a broken environment,
// and scenario.mjs classifies any unrecognized throw as KO, a product bug, which is the wrong
// thing to report. `run` is the testing seam.
async function eachService(reg, what, commandFor, { run = dockerRun } = {}) {
  for (const service of Object.keys(reg.raw?.exec ?? {})) {
    const { container, workdir } = reg.execTarget(service);
    await run(['exec', '-u', 'root', container, 'sh', '-c', commandFor(workdir)])
      .catch(err => { throw new Blocked(`${what} failed for ${service}: ${err.message}`); });
  }
}

export const reset = [
  {
    phase: 'normalize',
    name: 'storage-perms',
    run: reg => eachService(reg, 'storage perms normalization', storagePermsCommand),
  },
  {
    // A project whose baseline restore already truncates the logs sets truncateLogsOnReset to
    // false: this step costs one exec per service per row.
    phase: 'normalize',
    name: 'truncate-logs',
    run: reg => (adapterConfig('laravel').truncateLogsOnReset ?? true)
      ? eachService(reg, 'log truncation', truncateLogsCommand)
      : undefined,
  },
];

// --- lint ---

export const lint = [
  { id: 'php-artisan', kind: 'code', re: /php\s+artisan/, msg: 'raw artisan — use artisan()/tinker()' },
];

// --- fatal log patterns and verify ---

export const fatalLogPatterns = ['Allowed memory size', 'PHP Fatal'];

// `{workdir}` and `{container}` come from `reg.execTarget('{service}')`.
export const verify = {
  command: "docker exec -w {workdir} {container} php artisan list --raw | grep -q '^{command} '",
};

// --- selftest ---

const serviceOf = cfg => cfg.adapters.laravel.selftest.service;
const NEEDS = ['adapters.laravel.selftest.service'];

// A probe passes when the call REJECTS, which is the property both "surfaces as an error" checks
// share: a non-zero exit from the container must reach the caller, not resolve with whatever
// partial output was printed before it.
const rejects = async call => {
  try { await call(); return false; } catch { return true; }
};

export const selftest = [
  {
    // `--version` prints a version string and exits; it opens no database connection at all,
    // which is exactly the claim touchesNoDatabase makes.
    name: 'artisan: runs in the container',
    needs: NEEDS,
    run: async (reg, cfg) =>
      String(await artisan(reg, serviceOf(cfg), ['--version'], { touchesNoDatabase: true })).includes('Laravel'),
  },
  {
    // The opt-out keeps this checking what it says it checks: a command that does not exist
    // cannot bind a database, and without the opt-out the guard would refuse first and this
    // would pass for the wrong reason.
    name: 'artisan: a failing command surfaces as an error',
    needs: NEEDS,
    run: (reg, cfg) => rejects(() =>
      artisan(reg, serviceOf(cfg), ['scn-selftest-nonexistent-command'], { touchesNoDatabase: true })),
  },
  {
    // Never reaches docker: the target named is outside the prefix and the check is in code.
    name: 'artisan: refuses a write target outside the database prefix',
    needs: NEEDS,
    run: async (reg, cfg) => {
      try {
        assertPrefixedTargets(serviceOf(cfg), ['scn-selftest-not-prefixed']);
        return false;
      } catch (e) {
        return e instanceof Blocked && /write target outside/.test(e.message);
      }
    },
  },
  {
    name: 'tinker: multi-line file executes',
    needs: NEEDS,
    run: async (reg, cfg) =>
      String(await tinker(reg, serviceOf(cfg), 'try { echo "SCN_OK"; } catch (\\Throwable $e) { echo "ERR"; }')).includes('SCN_OK'),
  },
  {
    // dispatchSync() runs a job's file-cache lock middleware inside this root process; under
    // root's default umask 022 the lock dirs came out 2755 and the worker's user could not
    // create the lock file in them.
    name: 'tinker: dirs a root tinker creates are group-writable (worker gid can write them)',
    needs: NEEDS,
    run: async (reg, cfg) => {
      const out = String(await tinker(reg, serviceOf(cfg), `
    $d = storage_path('framework/cache/data/zz-scn-selftest/aa');
    mkdir($d, 0777, true);
    echo 'SCN_MODE=' . substr(sprintf('%o', fileperms($d)), -4);
    rmdir($d); rmdir(dirname($d));`));
      const mode = /SCN_MODE=([0-7]{4})/.exec(out);
      return mode !== null && (parseInt(mode[1], 8) & 0o020) !== 0;
    },
  },
  {
    // exit(1) inside the script is the same signal the guard preamble relies on.
    name: 'tinker: a failing script surfaces as an error',
    needs: NEEDS,
    run: (reg, cfg) => rejects(() =>
      tinker(reg, serviceOf(cfg), 'fwrite(STDERR, "SCN_SELFTEST_TINKER_BOOM"); exit(1);')),
  },
];
