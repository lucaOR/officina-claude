// Each CLI module runs its command only when node was started on that very file. A project script
// whose name merely ends the same way (my-run.mjs) and imports the module must not start it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../paths.mjs';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIS = ['check.mjs', 'hash.mjs', 'lint.mjs', 'query.mjs', 'run.mjs', 'selftest.mjs'];

const scratch = t => {
  const dir = mkdtempSync(join(tmpdir(), 'scn-cli-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

for (const cli of CLIS) {
  test(`a script named my-${cli} that imports ${cli} does not start its command`, (t) => {
    const script = join(scratch(t), `my-${cli}`);
    writeFileSync(script, `import ${JSON.stringify(pathToFileURL(join(LIB, cli)).href)};\nconsole.log('imported');\n`);
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: LIB });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'imported\n');
  });
}

test('a CLI started through a symlinked lib directory still runs its command', (t) => {
  const link = join(scratch(t), 'lib');
  symlinkSync(LIB, link, 'dir');
  const r = spawnSync(process.execPath, [join(link, 'hash.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: hash\.mjs <epic> <id>/);
});

test('isMain compares the started file, never a name suffix', () => {
  const saved = process.argv[1];
  try {
    process.argv[1] = join(LIB, 'hash.mjs');
    assert.equal(isMain(pathToFileURL(join(LIB, 'hash.mjs')).href), true);
    process.argv[1] = join(LIB, 'test', 'rehash.mjs');
    assert.equal(isMain(pathToFileURL(join(LIB, 'hash.mjs')).href), false, 'a file that does not exist is not the module');
    process.argv[1] = undefined;
    assert.equal(isMain(pathToFileURL(join(LIB, 'hash.mjs')).href), false);
  } finally {
    process.argv[1] = saved;
  }
});
