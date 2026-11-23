import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assemble } from '../dev/assemble.mjs';

test('the assembled runtime lib passes its own tests', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'scn-assembled-'));
  try {
    const { libDir } = assemble(dest, { adapters: 'all' });
    const index = await import(pathToFileURL(join(libDir, 'index.mjs')));
    assert.equal(typeof index.compiledFrom, 'function');
    const { ADAPTERS, PROVIDERS } = await import(pathToFileURL(join(libDir, 'adapters.mjs')));
    assert.equal(typeof ADAPTERS, 'object');
    assert.equal(typeof PROVIDERS, 'object');
    // npm test runs the lib's own package.json script, as an installed project does. Under
    // `node --test` this process carries NODE_TEST_CONTEXT, and a child `node --test` that inherits
    // it skips every file and exits 0, so it is removed; so is SCN_DOCKER_TESTS, to stay offline.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.SCN_DOCKER_TESTS;
    const r = spawnSync('npm', ['test'], { cwd: libDir, encoding: 'utf8', env });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^(?:ℹ|#) pass [1-9]\d*$/m, 'the lib\'s tests actually ran');
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
