// Runs SQL text against a scn_* database inside a container, piped over stdin. This file is
// dialect-neutral: a dialect adapter provides `driver('sql.<dialect>')` as
// `{ clients: RegExp, args(target, text): string[], parse(raw): rows }`, and `sql()` dispatches to it.
// The SQL goes over stdin and never through `-e '<sql>'` plus `sh -c`, because that form silently
// swallows everything after a `--` comment.
import { Blocked, Ko } from './errors.mjs';
import { config } from './config.mjs';
import { adapters, driver } from './ext.mjs';
import { dockerRun } from './docker.mjs';

export { dockerRun } from './docker.mjs';

// Blocked, not a plain Error: this guard REFUSING is the guard succeeding, and an untyped throw is
// reported as a product KO. What a refusal means is "this scenario asked for a target outside the
// scenario stack, so nothing ran".
//
// LIMIT: this guard is on the TARGET ARGUMENT, not on the statement. `sql(reg, 'scn_app', 'DROP
// DATABASE ambient_db')` passes it, because the client connects to scn_app and then executes
// whatever it is piped, against the whole server. A statement matcher is deliberately NOT the
// remedy: `alias.column` is ubiquitous in real SQL, so any schema-qualified-name regex
// false-positives constantly, and a guard that cries wolf gets bypassed. What covers the accidental
// case is this adapter's `ambient-db` lint rule, which refuses an ambient database name anywhere
// in a compiled script.
export function assertScnTarget(db) {
  const prefix = config().dbPrefix;
  if (!String(db).startsWith(prefix)) throw new Blocked(`refusing non-${prefix} target: ${db}`);
  return db;
}

// The client's tab-separated batch output escapes a real tab, newline or backslash BYTE in the data
// to the two-character sequence \t, \n or \\. The only literal tab and newline bytes in the raw
// output are the field and row delimiters themselves. Undo that in a single left-to-right pass, so
// an escaped backslash followed by a literal 't' (raw \\t) is not misread as an escaped tab (raw \t):
// consuming exactly one recognized two-character escape per step keeps those cases distinct.
function unescapeValue(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    const next = v[i + 1];
    if (c === '\\' && next === 't') { out += '\t'; i++; continue; }
    if (c === '\\' && next === 'n') { out += '\n'; i++; continue; }
    if (c === '\\' && next === '\\') { out += '\\'; i++; continue; }
    out += c;
  }
  return out;
}

// A header line, then one line per row. NULL becomes null. `escaped` says whether the client escapes
// its values as above; a dialect whose client escapes nothing passes `escaped: false`, and every
// value is then kept exactly as printed, backslashes included.
export function parseRows(raw, { escaped = true } = {}) {
  // Split into lines and fields BEFORE unescaping: a real newline byte only ever occurs as a row
  // delimiter, so splitting first is safe. Unescaping first would turn a value's escaped \n back
  // into a newline byte and split that single row into two.
  const value = escaped ? unescapeValue : v => v;
  const lines = String(raw).split('\n').filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const cols = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const vals = line.split('\t');
    return Object.fromEntries(cols.map((c, i) => {
      const v = vals[i];
      if (v === 'NULL') return [c, null];
      if (v === undefined) return [c, undefined];
      return [c, value(v)];
    }));
  });
}

// The dialect whose driver claims this client name, found by scanning the installed adapters'
// `sql.<dialect>` drivers. Null when none claims it.
function inferDialect(clientName) {
  for (const { mod } of adapters()) {
    for (const [key, drv] of Object.entries(mod.drivers ?? {})) {
      if (key.startsWith('sql.') && drv?.clients instanceof RegExp && drv.clients.test(clientName)) {
        return key.slice('sql.'.length);
      }
    }
  }
  return null;
}

// A string entry is "<container> <client...>" and infers its dialect from the client's first token.
// A mapping entry is { container, client, dialect? }, where `client` is a string or an argv array and
// a stated `dialect` skips the inference.
export function parseDbEntry(db, entry) {
  let container, client, dialect;
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    container = entry.container;
    client = Array.isArray(entry.client)
      ? entry.client.map(String)
      : String(entry.client ?? '').trim().split(/\s+/).filter(Boolean);
    dialect = entry.dialect;
    if (typeof container !== 'string' || container === '' || client.length === 0) {
      throw new Blocked(`db entry for ${db} needs a container and a client: ${JSON.stringify(entry)}`);
    }
  } else {
    const parts = String(entry).trim().split(/\s+/);
    if (parts.length < 2) throw new Blocked(`db entry for ${db} needs "<container> <client...>": ${entry}`);
    [container, ...client] = parts;
  }
  if (dialect === undefined) {
    dialect = inferDialect(client[0]);
    if (dialect === null) {
      throw new Blocked(
        `db entry for ${db}: no installed adapter drives a client named "${client[0]}". State \`dialect\` in the `
        + 'entry (a mapping with container, client and dialect), or run /scenario-matrix:setup --add <adapter>',
      );
    }
  }
  return { db, container, client, dialect };
}

// `run` is the testing seam: real callers pass nothing. assertScnTarget() is unit-tested in
// isolation, but only an injected `run` proves that sql() CALLS it before anything reaches docker.
// The guard is deliberately evaluated on its own statement, before reg.dbTarget(), so the refusal
// cannot be reordered behind a registry lookup that might itself throw first and mask it.
export async function sql(reg, db, text, { run: exec = dockerRun } = {}) {
  assertScnTarget(db);
  const target = reg.dbTarget(db);
  const dialect = driver(`sql.${target.dialect}`);
  return dialect.parse(await exec(dialect.args(target, text), text));
}

export async function one(reg, db, text, opts) {
  const rows = await sql(reg, db, text, opts);
  // Ko, not Blocked: the query ran and the database answered, just with more rows than the
  // scenario claimed were possible, which is a statement about the data under test.
  if (rows.length > 1) throw new Ko(`one(): expected at most 1 row, got ${rows.length}`);
  return rows[0] ?? null;
}

export async function scalar(reg, db, text, opts) {
  const row = await one(reg, db, text, opts);
  return row ? Object.values(row)[0] : null;
}
