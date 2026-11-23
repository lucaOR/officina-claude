// Reads a scenario matrix the way PyYAML's safe_load does, so that every
// compiled_from hash stays stable. npm `yaml` in YAML 1.1 mode matches PyYAML
// except that it also reads bare `y` and `n` as booleans; the two bool tags
// below replace the stock ones to drop that.
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { Blocked } from './errors.mjs';

const BOOL = 'tag:yaml.org,2002:bool';

const boolTag = (value, test) => ({
  identify: v => v === value,
  default: true,
  tag: BOOL,
  test,
  resolve: () => value,
  stringify: () => String(value),
});

const trueTag = boolTag(true, /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/);
const falseTag = boolTag(false, /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/);

// Stock yaml 1.1 also reads `E-01` and `92e487916021` as floats (an exponent
// with no dot, or no digits at all), where PyYAML keeps them strings.
const FLOAT = 'tag:yaml.org,2002:float';
const FLOAT_TESTS = {
  EXP: /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)[eE][-+][0-9]+$/,
  PLAIN: /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*|\.[0-9][0-9_]*)$/,
};
// Depends on yaml 2.9.1's float tag shape; re-check on any yaml upgrade. The
// `inf` test keeps the stock floatNaN tag (.inf / .nan) untouched.
const pyFloat = t => (t.tag === FLOAT && t.format === 'EXP' ? { ...t, test: FLOAT_TESTS.EXP }
  : t.tag === FLOAT && !t.format && !String(t.test).includes('inf') ? { ...t, test: FLOAT_TESTS.PLAIN } : t);

const customTags = tags => [...tags.filter(t => t.tag !== BOOL).map(pyFloat), trueTag, falseTag];

function rejectDates(node, path) {
  if (node instanceof Date) {
    throw new Blocked(`unquoted date at ${path.where}:${path.key || '<root>'}; quote it`);
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => rejectDates(v, { where: path.where, key: `${path.key}[${i}]` }));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      rejectDates(v, { where: path.where, key: path.key ? `${path.key}.${k}` : k });
    }
  }
}

export function parseMatrixText(text, where = '<text>') {
  let doc;
  try {
    doc = YAML.parse(text, { version: '1.1', customTags, uniqueKeys: false, merge: true, maxAliasCount: -1 });
  } catch (err) {
    throw new Blocked(`${where} is not valid YAML: ${err.message}`);
  }
  rejectDates(doc, { where, key: '' });
  return doc;
}

// The tag overrides above lean on yaml 2.9.1 internals, and a project's own yaml pin wins over the
// plugin's, so the parse is checked once at import against what PyYAML gives for the same text: an
// id that looks like an exponent stays a string, `y` stays a string, `yes` is true and a dotted
// exponent is a float. A mismatch would silently change every compiled_from hash, so it is Blocked.
const PARITY_TEXT = 'a: E-01\nb: y\nc: 92e487916021\nd: yes\ne: 1.5e+3\n';
const PARITY_WANT = { a: 'E-01', b: 'y', c: '92e487916021', d: true, e: 1500 };

export function assertPyYamlParity(parse = text => parseMatrixText(text, '<yaml self-check>')) {
  let got;
  try {
    got = parse(PARITY_TEXT);
  } catch (err) {
    got = `an error: ${err?.message ?? err}`;
  }
  if (JSON.stringify(got) !== JSON.stringify(PARITY_WANT)) {
    throw new Blocked(
      `the installed yaml package no longer parses a matrix as PyYAML does (got ${JSON.stringify(got)}, `
      + `want ${JSON.stringify(PARITY_WANT)}), so compiled_from hashes would drift. Pin "yaml": "2.9.1" in `
      + '.claude/scenarios/_lib/package.json and run npm install there.',
    );
  }
}

assertPyYamlParity();

export function readMatrix(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Blocked(`matrix not found: ${path}`);
    throw err;
  }
  return parseMatrixText(text, path);
}
