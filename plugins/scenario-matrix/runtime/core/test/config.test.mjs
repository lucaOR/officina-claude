import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, loadConfig, adapterConfig, repoPath, fill, __setConfigForTest, config } from '../config.mjs';
import { REPO } from '../paths.mjs';
import { Blocked } from '../errors.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'scn-config-'));

test('defaults apply when scenarios.config.json is absent', () => {
  const cfg = loadConfig(join(tmp(), 'scenarios.config.json'));
  assert.deepEqual(cfg, JSON.parse(JSON.stringify(DEFAULTS)));
  assert.equal(cfg.dbPrefix, 'scn_');
  assert.equal(cfg.lifecycle.refusedExit, 78);
});

test('nested keys merge over defaults, arrays and scalars replace', () => {
  const path = join(tmp(), 'scenarios.config.json');
  writeFileSync(path, JSON.stringify({
    runsDir: 'out',
    lifecycle: { up: 'make up' },
    check: { artifactKinds: ['seed', 'dump'] },
  }));
  const cfg = loadConfig(path);
  assert.equal(cfg.runsDir, 'out');
  assert.equal(cfg.lifecycle.up, 'make up');
  assert.equal(cfg.lifecycle.keepWarmEnv, 'SCN_KEEP_WARM');
  assert.deepEqual(cfg.check.artifactKinds, ['seed', 'dump']);
  assert.deepEqual(cfg.check.forbiddenArtifactPaths, []);
  assert.equal(DEFAULTS.lifecycle.up, null);
});

test('malformed JSON names the file', () => {
  const path = join(tmp(), 'scenarios.config.json');
  writeFileSync(path, '{ "runsDir": ');
  assert.throws(() => loadConfig(path), err => err instanceof Blocked && err.message.includes(path));
});

test('an empty or blank dbPrefix is Blocked, because it would turn off every prefix guard', () => {
  for (const dbPrefix of ['', '   ', null, 7]) {
    const path = join(tmp(), 'scenarios.config.json');
    writeFileSync(path, JSON.stringify({ dbPrefix }));
    assert.throws(() => loadConfig(path), err => err instanceof Blocked && /dbPrefix/.test(err.message) && err.message.includes(path), JSON.stringify(dbPrefix));
    assert.throws(() => __setConfigForTest({ dbPrefix }), err => err instanceof Blocked && /dbPrefix/.test(err.message));
  }
});

test('__setConfigForTest replaces the cached config and the restore function undoes it', () => {
  const before = config();
  const restore = __setConfigForTest({ dbPrefix: 'x_', adapters: { demo: { a: 1 } } });
  try {
    assert.equal(config().dbPrefix, 'x_');
    assert.equal(config().runsDir, DEFAULTS.runsDir);
    assert.deepEqual(adapterConfig('demo'), { a: 1 });
    assert.deepEqual(adapterConfig('other'), {});
  } finally {
    restore();
  }
  assert.equal(config(), before);
});

test('repoPath resolves against the repository root', () => {
  assert.equal(repoPath('a/b'), join(REPO, 'a/b'));
});

test('fill replaces known placeholders and leaves unknown ones as they are', () => {
  assert.equal(fill('compile {epic} {id} {nope}', { epic: 'demo', id: 'A-01' }), 'compile demo A-01 {nope}');
});
