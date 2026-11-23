#!/usr/bin/env node
// Setup-SQL rehearsal gate for a scenario matrix: executes every scenario's `db` setup ops so a
// column, enum, NOT NULL or foreign-key error is caught BEFORE a run ever touches them, leaving the
// real scenario databases untouched.
//
// Two paths, because DDL commits implicitly (a ROLLBACK cannot undo it, and it would also commit any
// DML before it in the same group):
//   - a group with no implicit-commit statement runs in one START TRANSACTION ... ROLLBACK on the
//     real target database;
//   - a group with one or more implicit-commit statements (see isDdl) runs in a throwaway full clone
//     of its target database, dropped in a `finally`. A clone that DROP cannot remove is named in a
//     warning. Such a group must not name the real target qualified, or it would escape the clone;
//     it fails with a message instead.
// Both paths send the batch under a custom client delimiter, so a compound trigger body (which
// contains `;`) survives the client.
//
// Every group goes through the target's own db entry client (its user and password included), and
// a target that lacks the db prefix fails before anything reaches docker: the rehearsal executes
// real SQL, so it keeps the same guard as sql(). Each docker call has a timeout, so a hung lock wait
// or dump fails the group instead of hanging the gate.
//
// Grouping rule: a scenario's setup ops against the SAME target run together in ONE transaction, in
// matrix order, so intra-scenario foreign-key chains hold (an INSERT, then an INSERT referencing it).
// Ops against different targets run in separate groups, because they are separate databases.
//
// `mutate` steps are rehearsed too, but with the scenario's same-target setup replayed first inside
// the group, so setup-created rows exist. Product-created rows cannot be replayed statically. An
// UPDATE or DELETE that matches 0 rows is NOT an error, so this only false-fails on an INSERT mutate
// whose foreign-key target the product action was meant to create.
//
// Usage: rehearse-sql.mjs <matrix.yaml> [--family F] [--mutates]
// Exit 0 = all green, 1 = at least one scenario failed (details printed), 2 = no db map in the matrix.
import { config } from './config.mjs';
import { isMain } from './paths.mjs';
import { readMatrix } from './matrix.mjs';
import { assertScnTarget, dockerRun, parseDbEntry } from './db.mjs';
import { companion } from './adapter-mysql.mjs';

// Statements that cause an implicit commit (first keyword or keywords, case-insensitive).
const IMPLICIT_COMMIT = [
  'ALTER', 'CREATE', 'DROP', 'RENAME', 'TRUNCATE', 'LOCK', 'UNLOCK',
  'GRANT', 'REVOKE', 'ANALYZE', 'OPTIMIZE', 'REPAIR', 'BEGIN',
  'START TRANSACTION', 'COMMIT', 'SET AUTOCOMMIT', 'LOAD DATA',
];
const IMPLICIT_COMMIT_RE = new RegExp(`(?:${IMPLICIT_COMMIT.map(k => k.replace(' ', '\\s+')).join('|')})\\b`, 'iy');
const LEADING_NOISE_RE = /(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/y;
const DELIM = '$$';
const CLIENT_TIMEOUT_MS = 30_000;
const FILL_TIMEOUT_MS = 600_000;

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shellQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`;
// A word the shell reads as itself stays bare, so a plain client line reads as typed.
const shellWord = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s));

// True if the statement's first keyword or keywords cause an implicit commit.
export function isDdl(statement) {
  let pos = 0;
  for (;;) {
    LEADING_NOISE_RE.lastIndex = pos;
    const m = LEADING_NOISE_RE.exec(statement);
    if (!m || m[0].length === 0) break;
    pos += m[0].length;
  }
  IMPLICIT_COMMIT_RE.lastIndex = pos;
  return IMPLICIT_COMMIT_RE.test(statement);
}

// The throwaway database a DDL group runs in: the prefix, `rh_`, then the target without its prefix.
export function cloneName(db) {
  const prefix = config().dbPrefix;
  return `${prefix}rh_${db.startsWith(prefix) ? db.slice(prefix.length) : db}`;
}

const keepsFamily = (id, family) => !family || id.startsWith(`${family}-`) || id === family;

// The groups to run, in matrix order: { id, kind: 'setup' | 'mutate', target, statements, own }.
// `statements` is what runs, and `own` how many of them are the group's own ops, since a mutate
// group replays its target's setup first. `ops` counts own statements, `scenarios` the rows kept.
export function collectStatements(matrix, { family = null, mutates = false } = {}) {
  const groups = [];
  let scenarios = 0;
  let ops = 0;
  for (const scn of matrix.scenarios ?? []) {
    if (!keepsFamily(scn.id, family)) continue;
    scenarios++;
    const setup = new Map();
    for (const op of scn.setup ?? []) {
      const db = op?.db;
      if (db?.sql) setup.set(db.target, [...(setup.get(db.target) ?? []), db.sql]);
    }
    const mutate = new Map();
    if (mutates) {
      for (const step of scn.steps ?? []) {
        const db = step?.mutate?.db;
        if (db?.sql) mutate.set(db.target, [...(mutate.get(db.target) ?? []), db.sql]);
      }
    }
    for (const [target, statements] of setup) {
      groups.push({ id: scn.id, kind: 'setup', target, statements, own: statements.length });
      ops += statements.length;
    }
    for (const [target, statements] of mutate) {
      groups.push({ id: scn.id, kind: 'mutate', target, statements: [...(setup.get(target) ?? []), ...statements], own: statements.length });
      ops += statements.length;
    }
  }
  return { scenarios, ops, groups };
}

// Joins the statements under a custom delimiter and optionally wraps them in a rolled-back
// transaction. The delimiter sits on its own line: appended to the statement, a trailing
// `-- comment` would swallow it and merge the statement with the next one.
export function buildBatch(db, statements, rollback) {
  const body = statements.map(s => `${s.trimEnd().replace(/;+$/, '')}\n${DELIM}\n`).join('');
  const head = rollback ? 'START TRANSACTION;\n' : '';
  const tail = rollback ? 'DELIMITER ;\nROLLBACK;' : 'DELIMITER ;\n';
  return `${head}USE \`${db}\`;\nDELIMITER ${DELIM}\n${body}${tail}`;
}

// The client's own ERROR line out of a failed docker call, else the last line of what it said.
function errorLine(err) {
  const message = String(err?.message ?? err);
  const found = /ERROR[^\n]*/.exec(message);
  if (found) return found[0].trim();
  const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.at(-1) ?? 'unknown';
}

async function attempt(run, args, stdin, timeoutMs = CLIENT_TIMEOUT_MS) {
  try {
    await run(args, stdin, { timeoutMs });
    return { ok: true, err: '' };
  } catch (e) {
    return { ok: false, err: errorLine(e) };
  }
}

// The db entry's client, run interactively in its container.
const clientArgs = target => ['exec', '-i', target.container, ...target.client];

// Runs the statements for one target in a throwaway full clone of it.
async function runOnClone(run, target, statements, warn) {
  const { db, container, client } = target;
  const escaping = new RegExp(`\`?${escapeRe(db)}\`?\\s*\\.`);
  if (statements.some(s => escaping.test(s))) {
    return { ok: false, err: `statement names the real target '${db}' qualified; it would escape the throwaway clone` };
  }
  const clone = cloneName(db);
  try {
    const created = await attempt(run, clientArgs(target), `DROP DATABASE IF EXISTS \`${clone}\`;\nCREATE DATABASE \`${clone}\`;`);
    if (!created.ok) return { ok: false, err: `clone create failed: ${created.err}` };
    const words = argv => argv.map(shellWord).join(' ');
    const dump = `${words(companion(client, 'dump'))} --routines --triggers --single-transaction ${shellQuote(db)} | ${words(client)} ${shellQuote(clone)}`;
    const filled = await attempt(run, ['exec', container, 'bash', '-o', 'pipefail', '-c', dump], undefined, FILL_TIMEOUT_MS);
    if (!filled.ok) return { ok: false, err: `clone fill failed: ${filled.err.slice(-200)}` };
    return await attempt(run, clientArgs(target), buildBatch(clone, statements, false));
  } finally {
    const dropped = await attempt(run, clientArgs(target), `DROP DATABASE IF EXISTS \`${clone}\`;`);
    if (!dropped.ok) {
      warn(`WARNING: could not drop the throwaway clone ${clone} in ${container} (${dropped.err}); `
        + `a leftover ${config().dbPrefix}rh_* database is safe to drop by hand`);
    }
  }
}

// Picks the path for one group: { ok, err, cloned }. `target` is the group's db entry as
// parseDbEntry() returns it: { db, container, client }. A db without the prefix never reaches docker.
export async function runGroup(run, target, statements, { warn = m => console.error(m) } = {}) {
  try {
    assertScnTarget(target.db);
  } catch (e) {
    return { ok: false, err: e.message, cloned: false };
  }
  if (!statements.some(isDdl)) {
    const done = await attempt(run, clientArgs(target), buildBatch(target.db, statements, true));
    return { ...done, cloned: false };
  }
  const done = await runOnClone(run, target, statements, warn);
  return { ok: done.ok, err: done.ok ? '' : done.err, cloned: true };
}

// Rehearses every group of the matrix: { opCount, scnCount, cloneRuns, failures }, where `failures`
// maps a scenario id to [[kind, target, message], ...] in the order found.
export async function rehearse(matrix, { family = null, mutates = false, run = dockerRun, warn } = {}) {
  const access = matrix.infra?.env_registry?.db ?? {};
  const { scenarios, ops, groups } = collectStatements(matrix, { family, mutates });
  const failures = new Map();
  const cloneRuns = [];
  const fail = (id, kind, target, err) => failures.set(id, [...(failures.get(id) ?? []), [kind, target, err]]);
  for (const g of groups) {
    // The guard comes first, so neither a missing nor a malformed entry can mask a refusal.
    try {
      assertScnTarget(g.target);
    } catch (e) {
      fail(g.id, g.kind, g.target, e.message);
      continue;
    }
    const entry = access[g.target];
    if (!entry) {
      fail(g.id, g.kind, g.target, `no env_registry.db entry for '${g.target}'`);
      continue;
    }
    let target;
    try {
      target = parseDbEntry(g.target, entry);
    } catch (e) {
      fail(g.id, g.kind, g.target, e.message);
      continue;
    }
    const done = await runGroup(run, target, g.statements, warn ? { warn } : {});
    if (done.cloned && !cloneRuns.includes(g.id)) cloneRuns.push(g.id);
    if (!done.ok) fail(g.id, g.kind, g.target, done.err);
  }
  return { opCount: ops, scnCount: scenarios, cloneRuns, failures };
}

async function main(argv) {
  const args = argv.filter(a => !a.startsWith('--'));
  const familyAt = argv.indexOf('--family');
  const family = familyAt >= 0 ? argv[familyAt + 1] : null;
  const mutates = argv.includes('--mutates');
  // The value of --family is not the matrix path.
  const path = args.find(a => a !== family);
  if (!path) {
    console.error('usage: rehearse-sql.mjs <matrix.yaml> [--family F] [--mutates]');
    return 64;
  }
  const matrix = readMatrix(path);
  if (Object.keys(matrix.infra?.env_registry?.db ?? {}).length === 0) {
    console.error('no infra.env_registry.db map — cannot rehearse');
    return 2;
  }
  const { opCount, scnCount, cloneRuns, failures } = await rehearse(matrix, { family, mutates });
  console.log(`rehearsed ${opCount} db ops across ${scnCount} scenarios`
    + (mutates ? ' (incl. mutates)' : ' (setup only)')
    + (cloneRuns.length ? `; ${cloneRuns.length} scenario(s) with DDL ran on a throwaway clone: ${cloneRuns.join(', ')}` : ''));
  if (failures.size === 0) {
    console.log('ALL GREEN — every setup SQL executes against real schema');
    return 0;
  }
  console.log(`\n${failures.size} scenarios have setup-SQL errors:\n`);
  for (const id of [...failures.keys()].sort()) {
    for (const [kind, target, err] of failures.get(id)) console.log(`  ${id} [${kind} ${target}]: ${err}`);
  }
  return 1;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
