// The matrix reader: one scenario, a family of them, or the infra preamble.
// Usage: query.mjs <epic> [selector] [--list | --infra | --json]
import { join } from 'node:path';
import YAML from 'yaml';
import { Blocked } from './errors.mjs';
import { readMatrix } from './matrix.mjs';
import { SCENARIOS, isMain } from './paths.mjs';

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// An exact id (case-insensitive) wins over an id prefix.
export function select(items, selector) {
  if (!selector) return items;
  const wanted = selector.trim().toLowerCase();
  const id = r => String(r.id ?? '').toLowerCase();
  const exact = items.filter(r => id(r) === wanted);
  return exact.length ? exact : items.filter(r => id(r).startsWith(wanted));
}

export function listLine(r) {
  const behaviour = String(r.behaviour ?? '').replaceAll('\n', ' ').slice(0, 120);
  return `${String(r.id ?? '?').padEnd(8)} ${String(r.status ?? '?').padEnd(12)} ${behaviour}`;
}

const toYaml = obj => YAML.stringify(obj, { blockQuote: 'literal', lineWidth: 100 });

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function main(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const [epic, selector] = argv.filter(a => !a.startsWith('--'));
  const unknown = [...flags].filter(f => !['--list', '--infra', '--json'].includes(f));
  if (!epic || unknown.length) die('usage: query.mjs <epic> [selector] [--list | --infra | --json]', 64);

  const path = join(process.env.SCN_MATRIX_DIR ?? SCENARIOS, `${epic}.yaml`);
  let data;
  try {
    data = readMatrix(path);
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
    die(err.message);
  }
  if (!isMap(data)) die(`${path} does not hold a YAML mapping`);

  const emit = obj => process.stdout.write(flags.has('--json') ? `${JSON.stringify(obj, null, 2)}\n` : toYaml(obj));

  if (flags.has('--infra')) {
    emit(Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'scenarios')));
    return;
  }
  if (!Array.isArray(data.scenarios)) die(`${path} has no \`scenarios:\` list`);
  const items = data.scenarios.filter(isMap);
  const chosen = select(items, selector);
  if (!chosen.length) {
    die(`no scenario matching '${selector}'. Available ids: ${items.map(r => String(r.id ?? '?')).join(', ')}`, 1);
  }
  if (flags.has('--json')) emit(chosen);
  else if (flags.has('--list')) process.stdout.write(chosen.map(r => `${listLine(r)}\n`).join(''));
  else emit(chosen.length > 1 ? chosen : chosen[0]);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
