// Tests never run the real docker binary. A stand-in `docker` executable is put first on PATH
// for one test, and PATH is restored when the test ends.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withPath(t, path, dir) {
  const saved = process.env.PATH;
  process.env.PATH = path;
  t.after(() => {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });
}

// `body` is a /bin/sh script. It sees the docker arguments as $1, $2, ...
export function installFakeDocker(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-fake-docker-'));
  writeFileSync(join(dir, 'docker'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, 'docker'), 0o755);
  withPath(t, `${dir}:${process.env.PATH}`, dir);
}

// PATH holds nothing, so spawning `docker` fails with ENOENT.
export function removeDockerFromPath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'scn-no-docker-'));
  withPath(t, dir, dir);
}
